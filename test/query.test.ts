import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate/build.ts";
import { writeDemoSnapshots } from "../src/aggregate/demo.ts";
import {
  DEFAULT_MOVER_METRICS,
  categories,
  competitors,
  homeLeaders,
  homeMoverMetric,
  movers,
  multiStoreApps,
  newArrivals,
  rankHistory,
  searchApps,
  topChart,
} from "../src/aggregate/query.ts";
import { runTool } from "../src/aggregate/tools.ts";
import { writeNormalized } from "../src/lib/io.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { emptySourceRow, type SnapshotManifest, type SourceRow } from "../src/lib/schema.ts";

function demoAggregate() {
  const dataDir = mkdtempSync(join(tmpdir(), "radar-q-"));
  writeDemoSnapshots(dataDir);
  return buildAggregate(dataDir, "fixture");
}

describe("public aggregate queries", () => {
  const agg = demoAggregate();

  it("ranks npm / GitHub / Gemini charts", () => {
    expect(topChart(agg, "npm", 1)[0]?.app.id).toBe("github:example/github-mcp");
    expect(topChart(agg, "github", 1)[0]?.app.id).toBe("github:obra/superpowers");
    expect(topChart(agg, "gemini", 1)[0]?.app.id).toBe("github:obra/superpowers");
    expect(topChart(agg, "npm", 5)[0]?.previousRank).toBe(1);
  });

  it("uses day-over-day npm movers on the home list when 2+ days exist", () => {
    expect(homeMoverMetric(agg)).toBe("npm_weekly_downloads");
    const leaders = homeLeaders(agg, 5);
    expect(leaders[0]?.app.id).toBe("github:example/github-mcp");
    expect(leaders[0]?.delta).not.toBeNull();
    expect(leaders[0]?.delta).not.toBe(0);
    expect(JSON.parse(runTool(agg, "movers", { window: "7d", metric: "use_count" }).content[0]!.text)).toEqual({
      error: "unknown metric: use_count",
    });
  });

  it("defaults movers to npm downloads, omitting stars and use_count", () => {
    expect(DEFAULT_MOVER_METRICS).toEqual(["npm_weekly_downloads"]);
    expect(movers(agg).every((row) => row.metric === "npm_weekly_downloads")).toBe(true);
    expect(movers(agg).some((row) => row.metric === "npm_weekly_downloads")).toBe(true);
    expect(movers(agg, { metric: "stars" }).some((row) => row.metric === "stars")).toBe(true);
    const payload = JSON.parse(runTool(agg, "movers", { window: "1d" }).content[0]!.text) as { rows: Array<{ metric: string }> };
    expect(payload.rows.every((row) => row.metric === "npm_weekly_downloads")).toBe(true);
  });

  it("searches, lists multi-store, new arrivals, and categories", () => {
    expect(searchApps(agg, "brave")[0]?.id).toBe("github:brave/brave-search-mcp");
    expect(searchApps(agg, "search", { category: "search" }).every((app) => app.category === "search")).toBe(true);
    expect(multiStoreApps(agg).some((app) => app.id === "github:example/weather")).toBe(true);
    expect(newArrivals(agg).length).toBeLessThanOrEqual(10);
    expect(categories(agg).some((row) => row.slug === "search" && row.appCount >= 1)).toBe(true);
  });

  it("returns rank history and description-based competitors", () => {
    const ranks = JSON.parse(
      runTool(agg, "rank_history", { app_id: "github:brave/brave-search-mcp", metric: "use_count" }).content[0]!.text,
    );
    expect(ranks).toEqual({ error: "unknown metric: use_count" });
    expect(rankHistory(agg, "github:brave/brave-search-mcp", "stars").at(-1)?.rank).toBeGreaterThan(0);
    const similar = competitors(agg, "github:brave/brave-search-mcp");
    expect(similar.some((app) => app.id === "github:example/universal-search")).toBe(true);
  });

  it("exposes answer-share aggregates and a graceful empty payload", () => {
    const present = JSON.parse(runTool(agg, "answer_share", { limit: 3 }).content[0]!.text);
    expect(present.available).toBe(true);
    expect(present.rows[0].appId).toBe("github:brave/brave-search-mcp");
    const openai = JSON.parse(runTool(agg, "answer_share", { provider: "openai" }).content[0]!.text);
    expect(openai.rows.length).toBeGreaterThan(0);
    const emptyDir = mkdtempSync(join(tmpdir(), "radar-empty-share-"));
    writeDemoSnapshots(emptyDir, ["2026-10-15"]);
    const empty = JSON.parse(runTool(buildAggregate(emptyDir, "fixture"), "answer_share", {}).content[0]!.text);
    expect(empty).toEqual({ available: false });
  });

  it("caps tool payloads and never dumps raw history files", () => {
    const result = runTool(agg, "search_apps", { query: "mcp", limit: 500 });
    const payload = JSON.parse(result.content[0]!.text) as { apps: unknown[] };
    expect(payload.apps.length).toBeLessThanOrEqual(10);
    expect(result.content[0]!.text).not.toContain("source_rows.ndjson");
    const charts = runTool(agg, "top_charts", { chart: "npm", limit: 3 });
    expect(charts.content[0]!.text).toContain("GitHub");
  });
});

function writeStarDay(dataDir: string, date: string, rows: SourceRow[], extra?: Partial<SnapshotManifest>): void {
  writeNormalized(
    date,
    rows,
    mergeApps(date, rows),
    {
      snapshotDate: date,
      collectedAt: `${date}T12:00:00Z`,
      appCount: 1,
      sourceRowCount: rows.length,
      sources: rows.map((row) => ({
        source: row.source,
        rowCount: 1,
        skipped: false,
        collectedAt: `${date}T12:00:00Z`,
      })),
      partial: false,
      completedSources: [...new Set(rows.map((row) => row.source))],
      ...extra,
    },
    dataDir,
  );
}

describe("default movers and stars_source series breaks", () => {
  it("ranks default movers and the homepage on fresh npm downloads, not stars or use_count", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-default-"));
    const day = (date: string, npmWeekly: number, stars: number, useCount: number): SourceRow[] => [
      emptySourceRow({
        snapshot_date: date,
        app_id: "github:example/mixed",
        source: "npm",
        source_id: "@example/mixed",
        name: "mixed",
        display_name: "Mixed",
        npm_weekly_downloads: npmWeekly,
        fetched_at: `${date}T12:00:00Z`,
      }),
      emptySourceRow({
        snapshot_date: date,
        app_id: "github:example/mixed",
        source: "github",
        source_id: "example/mixed",
        name: "mixed",
        display_name: "Mixed",
        stars,
        fetched_at: `${date}T12:00:00Z`,
      }),
      emptySourceRow({
        snapshot_date: date,
        app_id: "github:example/mixed",
        source: "smithery",
        source_id: "mixed",
        name: "mixed",
        display_name: "Mixed",
        use_count: useCount,
        fetched_at: `${date}T12:00:00Z`,
      }),
    ];
    writeStarDay(dataDir, "2026-10-14", day("2026-10-14", 100, 50, 10));
    writeStarDay(dataDir, "2026-10-15", day("2026-10-15", 180, 5_000, 9_000));
    const agg = buildAggregate(dataDir, "fixture");
    expect(movers(agg)).toEqual([
      expect.objectContaining({
        id: "github:example/mixed",
        metric: "npm_weekly_downloads",
        previous: 100,
        current: 180,
        delta: 80,
      }),
    ]);
    expect(movers(agg, { metric: "stars" })[0]).toMatchObject({
      id: "github:example/mixed",
      metric: "stars",
      previous: 50,
      current: 5000,
      delta: 4950,
    });
    expect(JSON.parse(runTool(agg, "movers", { metric: "use_count" }).content[0]!.text)).toEqual({
      error: "unknown metric: use_count",
    });
    expect(homeMoverMetric(agg)).toBe("npm_weekly_downloads");
    expect(homeLeaders(agg, 5)[0]).toMatchObject({
      app: expect.objectContaining({ id: "github:example/mixed" }),
      value: 180,
      delta: 80,
    });
  });

  it("does not compute star growth across a stars_source change", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-ss-break-"));
    writeStarDay(dataDir, "2026-10-14", [
      emptySourceRow({
        snapshot_date: "2026-10-14",
        app_id: "github:example/switcher",
        source: "github",
        source_id: "example/switcher",
        name: "switcher",
        display_name: "Switcher",
        stars: 100,
        fetched_at: "2026-10-14T12:00:00Z",
      }),
    ]);
    writeStarDay(dataDir, "2026-10-15", [
      emptySourceRow({
        snapshot_date: "2026-10-15",
        app_id: "github:example/switcher",
        source: "gemini-cli",
        source_id: "switcher",
        name: "switcher",
        display_name: "Switcher",
        stars: 500,
        fetched_at: "2026-10-15T12:00:00Z",
      }),
    ]);
    const broken = buildAggregate(dataDir, "fixture");
    expect(broken.series["github:example/switcher"]?.ss).toEqual(["github", "gemini-cli"]);
    expect(movers(broken, { window: "1d", metric: "stars" })).toEqual([]);
    expect(movers(broken, { window: "7d", metric: "stars" })).toEqual([]);

    const sameDir = mkdtempSync(join(tmpdir(), "radar-ss-same-"));
    writeStarDay(sameDir, "2026-10-14", [
      emptySourceRow({
        snapshot_date: "2026-10-14",
        app_id: "github:example/steady",
        source: "github",
        source_id: "example/steady",
        name: "steady",
        display_name: "Steady",
        stars: 100,
        fetched_at: "2026-10-14T12:00:00Z",
      }),
    ]);
    writeStarDay(sameDir, "2026-10-15", [
      emptySourceRow({
        snapshot_date: "2026-10-15",
        app_id: "github:example/steady",
        source: "github",
        source_id: "example/steady",
        name: "steady",
        display_name: "Steady",
        stars: 500,
        fetched_at: "2026-10-15T12:00:00Z",
      }),
    ]);
    const same = buildAggregate(sameDir, "fixture");
    expect(same.series["github:example/steady"]?.ss).toEqual(["github", "github"]);
    expect(movers(same, { window: "1d", metric: "stars" })[0]).toMatchObject({
      id: "github:example/steady",
      previous: 100,
      current: 500,
      delta: 400,
    });
  });
});
