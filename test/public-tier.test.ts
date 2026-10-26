import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate/build.ts";
import { writeDemoSnapshots } from "../src/aggregate/demo.ts";
import {
  HISTORY_CAP_DAYS,
  PUBLIC_MAX_LIMIT,
  PUBLIC_TOP_N,
  growthBucket,
  historyCutoffDate,
  round2sf,
} from "../src/aggregate/public.ts";
import {
  appDetail,
  categoryTrends,
  clampLimit,
  findApp,
  movers,
  publicAppIds,
  publicHistoryWindow,
  publicMetricSeries,
  rankHistory,
  searchApps,
  seriesToPoints,
  sparkValues,
  topChart,
} from "../src/aggregate/query.ts";
import { runTool, TOOL_NAMES } from "../src/aggregate/tools.ts";
import { CHART_IDS } from "../src/aggregate/types.ts";
import { writeAggregateFiles } from "../src/aggregate/write.ts";
import { addUtcDays } from "../src/lib/dates.ts";
import { writeNormalized } from "../src/lib/io.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { emptySourceRow, type SnapshotManifest } from "../src/lib/schema.ts";
import { collectForbiddenPublicKeys } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

function writeDay(
  dataDir: string,
  date: string,
  rows: Array<{
    id: string;
    name?: string;
    useCount?: number;
    stars?: number;
    npmWeekly?: number;
    starsCarried?: boolean;
    npmCarried?: boolean;
    starsSource?: "github" | "gemini-cli";
  }>,
  partial = false,
): void {
  const sourceRows = rows.flatMap((row) => {
    const out = [];
    if (row.useCount != null) {
      out.push(
        emptySourceRow({
          snapshot_date: date,
          app_id: row.id,
          source: "smithery",
          source_id: row.id,
          name: row.name ?? row.id,
          display_name: row.name ?? row.id,
          use_count: row.useCount,
        }),
      );
    }
    if (row.stars != null) {
      const source = row.starsSource === "gemini-cli" ? "gemini-cli" : "github";
      out.push(
        emptySourceRow({
          snapshot_date: date,
          app_id: row.id,
          source,
          source_id: row.id.replace(/^github:/, ""),
          name: row.name ?? row.id,
          display_name: row.name ?? row.id,
          stars: row.stars,
          fetched_at: `${date}T12:00:00.000Z`,
          carried_forward: row.starsCarried === true,
        }),
      );
    }
    if (row.npmWeekly != null) {
      out.push(
        emptySourceRow({
          snapshot_date: date,
          app_id: row.id,
          source: "npm",
          source_id: `@example/${row.id.replace(/^github:/, "")}`,
          name: row.name ?? row.id,
          display_name: row.name ?? row.id,
          npm_weekly_downloads: row.npmWeekly,
          fetched_at: `${date}T12:00:00.000Z`,
          carried_forward: row.npmCarried === true,
        }),
      );
    }
    return out;
  });
  const apps = mergeApps(date, sourceRows);
  const manifest: SnapshotManifest = {
    snapshotDate: date,
    collectedAt: `${date}T12:00:00.000Z`,
    appCount: apps.length,
    sourceRowCount: sourceRows.length,
    sources: [],
    ...(partial ? { partial: true } : {}),
  };
  writeNormalized(date, sourceRows, apps, manifest, dataDir);
}

describe("free-tier rounding", () => {
  it("round2sf(12345) = 12000 and 987 = 990", () => {
    expect(round2sf(12345)).toBe(12000);
    expect(round2sf(987)).toBe(990);
    expect(round2sf(72000)).toBe(72000);
    expect(round2sf(0)).toBe(0);
  });

  it("growth buckets work at their edges", () => {
    expect(growthBucket(0.009)).toBe("<1%");
    expect(growthBucket(0.01)).toBe("1–5%");
    expect(growthBucket(0.049)).toBe("1–5%");
    expect(growthBucket(0.05)).toBe("5–10%");
    expect(growthBucket(0.1)).toBe("10–25%");
    expect(growthBucket(0.25)).toBe("25–50%");
    expect(growthBucket(0.5)).toBe("50–100%");
    expect(growthBucket(0.99)).toBe("50–100%");
    expect(growthBucket(1)).toBe(">100%");
    expect(growthBucket(-0.05)).toBe("−5–10%");
    expect(growthBucket(-1.2)).toBe("−>100%");
    expect(growthBucket(null)).toBeNull();
  });
});

describe("history window", () => {
  it("keeps the last 14 complete snapshot days, not a calendar cutoff from latestDate", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-hist-"));
    const latest = "2026-10-15";
    const cutoff = historyCutoffDate(latest);
    expect(cutoff).toBe("2026-10-02");
    for (let offset = 20; offset >= 0; offset -= 1) {
      const date = addUtcDays(latest, -offset);
      writeDay(dataDir, date, [{ id: "github:example/a", useCount: 100 + offset, npmWeekly: 200 + offset }]);
    }
    const agg = buildAggregate(dataDir, "fixture");
    expect(agg.meta.snapshotDates.length).toBeLessThanOrEqual(HISTORY_CAP_DAYS);
    expect(agg.meta.snapshotDates[0]).toBe("2026-10-02");
    expect(agg.meta.snapshotDates.at(-1)).toBe("2026-10-15");
    expect(agg.meta.snapshotDates).not.toContain("2026-10-01");
    expect(JSON.stringify(agg)).not.toContain("2026-09-25");
    const history = rankHistory(agg, agg.apps[0]!.id, "npm_weekly_downloads");
    const valued = history.filter((point) => point.gap == null && point.value != null);
    expect(valued.length).toBeLessThanOrEqual(HISTORY_CAP_DAYS);
    expect(history[0]?.date).toBe("2026-10-02");
    expect(history.at(-1)?.date).toBe("2026-10-15");
  });
});

describe("list caps and public app pages", () => {
  it("caps every list at 10 and 404s apps outside the public top-10 union", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-cap-"));
    const ids = Array.from({ length: 20 }, (_, index) => ({
      id: `github:example/app-${String(index + 1).padStart(2, "0")}`,
      name: `App ${index + 1}`,
      useCount: (index + 1) * 1000,
      npmWeekly: (index + 1) * 1000,
    }));
    writeDay(
      dataDir,
      "2026-10-14",
      ids.map((row, index) => ({ ...row, useCount: row.useCount - (index + 1) * 100, npmWeekly: row.npmWeekly - (index + 1) * 100 })),
    );
    writeDay(dataDir, "2026-10-15", ids);
    const agg = buildAggregate(dataDir, "fixture");

    expect(topChart(agg, "npm", 50).length).toBeLessThanOrEqual(PUBLIC_TOP_N);
    expect(searchApps(agg, "", { limit: 50 }).length).toBeLessThanOrEqual(PUBLIC_TOP_N);
    expect(movers(agg, { window: "1d", metric: "use_count", limit: 50 }).length).toBeLessThanOrEqual(PUBLIC_TOP_N * 2);
    expect(clampLimit(50)).toBe(PUBLIC_MAX_LIMIT);
    expect(agg.apps.length).toBeLessThanOrEqual(ids.length);
    expect(findApp(agg, "github:example/app-01")).toBeUndefined();
    expect(publicAppIds(agg).has("github:example/app-01")).toBe(false);

    const page = readFileSync(join(repoRoot, "web/app/apps/[id]/page.tsx"), "utf8");
    expect(page).toContain("dynamicParams = false");
    expect(page).toContain("generateStaticParams");
  });

  it("does not ship the full aggregate to a client component", () => {
    const webRoot = join(repoRoot, "web");
    const clientFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(tsx|ts)$/.test(entry.name)) continue;
        const text = readFileSync(path, "utf8");
        if (text.includes('"use client"') || text.includes("'use client'")) {
          clientFiles.push(path);
          expect(text).not.toMatch(/loadAggregate/);
          expect(text).not.toMatch(/radar\.json/);
        }
      }
    };
    walk(join(webRoot, "app"));
    walk(join(webRoot, "components"));
    expect(clientFiles.length).toBeGreaterThan(0);
  });
});

describe("partial snapshot exclusion", () => {
  it("skips a partial day in the middle of a growth window", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-partial-mid-"));
    writeDay(dataDir, "2026-10-13", [{ id: "github:example/a", name: "A", stars: 100 }]);
    writeDay(dataDir, "2026-10-14", [{ id: "github:example/a", name: "A", stars: 10_000 }], true);
    writeDay(dataDir, "2026-10-15", [{ id: "github:example/a", name: "A", stars: 130 }]);
    const agg = buildAggregate(dataDir, "fixture");
    expect(agg.meta.partialDates).toEqual(["2026-10-14"]);
    const rows = movers(agg, { window: "1d", metric: "stars" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.previous).toBe(100);
    expect(rows[0]?.current).toBe(130);
    expect(rows[0]?.delta).toBe(30);
  });

  it("uses the latest complete day when the newest snapshot is partial", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-partial-latest-"));
    writeDay(dataDir, "2026-10-13", [{ id: "github:example/a", name: "A", stars: 100 }]);
    writeDay(dataDir, "2026-10-14", [{ id: "github:example/a", name: "A", stars: 130 }]);
    writeDay(dataDir, "2026-10-15", [{ id: "github:example/a", name: "A", stars: 10_000 }], true);
    const agg = buildAggregate(dataDir, "fixture");
    expect(agg.meta.latestCompleteDate).toBe("2026-10-14");
    expect(agg.meta.previousCompleteDate).toBe("2026-10-13");
    const rows = movers(agg, { window: "1d", metric: "stars" });
    expect(rows[0]).toMatchObject({ previous: 100, current: 130, delta: 30 });
    const payload = JSON.parse(runTool(agg, "movers", { window: "1d", metric: "stars" }).content[0]!.text);
    expect(payload.from).toBe("2026-10-13");
    expect(payload.to).toBe("2026-10-14");
    expect(agg.meta.snapshotDates).not.toContain("2026-10-15");
    expect(agg.meta.partialDates).toEqual([]);
  });
});

describe("rank_history metric fallback", () => {
  it("rank_history with no metric uses npm", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-metric-npm-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "fixture");
    const missing = JSON.parse(runTool(agg, "rank_history", { app_id: "github:example/github-mcp" }).content[0]!.text);
    expect(missing.metric).toBe("npm_weekly_downloads");
    expect(missing.metric).not.toBe("use_count");
    expect(JSON.stringify(missing)).not.toMatch(/use_count|useCount/);
    expect(missing.points.every((point: { growth?: string | null }) => point.growth == null || /%$/.test(point.growth))).toBe(true);
  });

  it("rank_history with an unknown metric errors", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-metric-unknown-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "fixture");
    const unknown = JSON.parse(
      runTool(agg, "rank_history", { app_id: "github:example/github-mcp", metric: "not_a_metric" }).content[0]!.text,
    );
    expect(unknown).toEqual({ error: "unknown metric: not_a_metric" });
    expect(JSON.stringify(unknown)).not.toMatch(/use_count|useCount/);
    expect(unknown.points).toBeUndefined();

    const moversUnknown = JSON.parse(runTool(agg, "movers", { metric: "not_a_metric" }).content[0]!.text);
    expect(moversUnknown).toEqual({ error: "unknown metric: not_a_metric" });
    expect(JSON.stringify(moversUnknown)).not.toMatch(/use_count|useCount/);
  });
});

describe("appDetail public history", () => {
  it("caps history to the last 14 complete days, marks gaps, and omits use_count", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-app-hist-"));
    const latest = "2026-10-20";
    const id = "github:example/hist";
    for (let offset = 16; offset >= 0; offset -= 1) {
      const date = addUtcDays(latest, -offset);
      const partial = date === "2026-10-12";
      const starsCarried = date === "2026-10-18";
      writeDay(
        dataDir,
        date,
        [
          {
            id,
            name: "Hist",
            stars: starsCarried ? 99_999 : 100 + (16 - offset) * 3,
            starsCarried,
            npmWeekly: 1540 + (16 - offset) * 40,
          },
        ],
        partial,
      );
    }
    const agg = buildAggregate(dataDir, "fixture");
    const detail = appDetail(agg, id);
    expect(detail).not.toBeNull();
    expect(detail?.ranks).not.toHaveProperty("use_count");
    expect(detail?.ranks).toHaveProperty("npm_weekly_downloads");
    expect(detail?.ranks).toHaveProperty("stars");

    const history = detail!.history;
    const completeValued = history.filter((point) => point.starsGap == null && point.stars != null);
    expect(completeValued.length).toBeLessThanOrEqual(HISTORY_CAP_DAYS);
    expect(history[0]?.date).toBe("2026-10-06");
    expect(history.at(-1)?.date).toBe("2026-10-20");
    expect(history.some((point) => point.date === "2026-10-04")).toBe(false);
    const partialPoint = history.find((point) => point.date === "2026-10-12");
    expect(partialPoint).toMatchObject({ stars: null, starsGap: "partial", starsGrowth: null });
    const carried = history.find((point) => point.date === "2026-10-18");
    expect(carried).toMatchObject({ stars: null, starsGap: "carried_forward", starsGrowth: null });
    expect(carried?.npmWeeklyDownloads).not.toBeNull();
    expect(JSON.stringify(history)).not.toContain("99999");
    expect(JSON.stringify(history)).not.toMatch(/useCount|use_count/);
    expect(history.every((point) => !("useCount" in point))).toBe(true);
    expect(history.every((point) => point.stars == null || point.stars === round2sf(point.stars))).toBe(true);
    expect(history.some((point) => point.starsGrowth != null || point.npmGrowth != null)).toBe(true);
    expect(history.every((point) => point.starsGrowth == null || /%$/.test(point.starsGrowth))).toBe(true);
    expect(history.every((point) => point.npmGrowth == null || /%$/.test(point.npmGrowth))).toBe(true);
    const afterPartial = history.find((point) => point.date === "2026-10-13");
    expect(afterPartial?.starsGrowth).toBeNull();

    const viaHelper = seriesToPoints(agg, id);
    expect(viaHelper.map((point) => point.date)).toEqual(history.map((point) => point.date));
  });
});

describe("MCP tool free-tier envelope", () => {
  it("keeps every tool at rounded values, ≤14-day history, and limit max 10", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-mcp-env-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "fixture");
    const brave = "github:brave/brave-search-mcp";
    const payloads = [
      runTool(agg, "search_apps", { query: "mcp", limit: 50 }),
      runTool(agg, "app_details", { app_id: brave }),
      runTool(agg, "rank_history", { app_id: "github:example/github-mcp" }),
      runTool(agg, "rank_history", { app_id: brave, metric: "stars" }),
      runTool(agg, "top_charts", { chart: "npm", limit: 50 }),
      runTool(agg, "movers", { window: "7d", limit: 50 }),
      runTool(agg, "competitors", { app_id: brave, limit: 50 }),
      runTool(agg, "category_trends", { category: "search" }),
      runTool(agg, "category_trends", {}),
      runTool(agg, "multi_store", { limit: 50 }),
      runTool(agg, "answer_share", { limit: 50 }),
    ];
    for (const result of payloads) {
      const text = result.content[0]!.text;
      expect(text).not.toContain("87579");
      expect(text).not.toContain("299294");
      expect(text).not.toContain("source_rows.ndjson");
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(body).not.toHaveProperty("pct");
      if (Array.isArray(body.apps)) expect(body.apps.length).toBeLessThanOrEqual(PUBLIC_TOP_N);
      if (Array.isArray(body.rows)) expect(body.rows.length).toBeLessThanOrEqual(PUBLIC_TOP_N * 2);
      const capComplete = (points: Array<{ gap?: string | null; value?: unknown; stars?: unknown }>) => {
        const valued = points.filter((point) => point.gap == null && (point.value != null || point.stars != null));
        expect(valued.length).toBeLessThanOrEqual(HISTORY_CAP_DAYS);
      };
      if (Array.isArray(body.points)) capComplete(body.points as Array<{ gap?: string | null; value?: unknown; stars?: unknown }>);
      if (Array.isArray((body as { history?: unknown[] }).history)) {
        capComplete((body as { history: Array<{ starsGap?: string | null; stars?: unknown }> }).history.map((point) => ({
          gap: point.starsGap,
          stars: point.stars,
        })));
      }
    }
    const detail = JSON.parse(runTool(agg, "app_details", { app_id: brave }).content[0]!.text);
    expect(detail.ranks.use_count).toBeUndefined();
    expect(JSON.stringify(detail)).not.toMatch(/useCount|use_count/);
    const charts = JSON.parse(runTool(agg, "top_charts", { chart: "npm", limit: 50 }).content[0]!.text);
    expect(charts.rows.length).toBeLessThanOrEqual(PUBLIC_TOP_N);
    expect(charts.rows[0]).not.toHaveProperty("delta");
    const trends = JSON.parse(runTool(agg, "category_trends", { category: "search" }).content[0]!.text);
    expect(trends.points.some((point: { gap: string | null }) => point.gap === "missing")).toBe(true);
    expect(trends.apps.length).toBeLessThanOrEqual(PUBLIC_TOP_N);
    expect(JSON.stringify(trends)).not.toMatch(/useCount/);
    const search = JSON.parse(runTool(agg, "search_apps", { query: "mcp" }).content[0]!.text);
    expect(JSON.stringify(search.apps)).not.toMatch(/useCount/);
    const comps = JSON.parse(runTool(agg, "competitors", { app_id: brave }).content[0]!.text);
    expect(JSON.stringify(comps.rows)).not.toMatch(/useCount/);
    const multi = JSON.parse(runTool(agg, "multi_store", { limit: 5 }).content[0]!.text);
    expect(JSON.stringify(multi.rows)).not.toMatch(/useCount/);
  });
});

describe("built radar.json never holds exact fixture counts", () => {
  it("rounds demo counts and buckets growth", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-round-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "fixture");
    const json = JSON.stringify(agg);
    expect(json).not.toContain("87579");
    expect(json).not.toContain("299294");
    const brave = agg.apps.find((app) => app.id === "github:brave/brave-search-mcp");
    expect(brave).toBeDefined();
    expect(brave).not.toHaveProperty("useCount");
    expect(movers(agg, { window: "7d", metric: "use_count" })).toEqual([]);
  });
});

describe("gap marking and window anchoring", () => {
  it("returns partial, carried_forward, and missing days as marked gaps with no growth across them", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-gaps-"));
    const id = "github:example/gap";
    writeDay(dataDir, "2026-10-10", [{ id, name: "Gap", stars: 100, npmWeekly: 50 }]);
    writeDay(dataDir, "2026-10-11", [{ id, name: "Gap", stars: 10_000, npmWeekly: 9_999 }], true);
    writeDay(dataDir, "2026-10-13", [{ id, name: "Gap", stars: 130, npmWeekly: 80, starsCarried: true }]);
    writeDay(dataDir, "2026-10-14", [{ id, name: "Gap", stars: 160, npmWeekly: 90 }]);
    const agg = buildAggregate(dataDir, "fixture");
    const window = publicHistoryWindow(agg);
    expect(window.map((day) => [day.date, day.gap])).toEqual([
      ["2026-10-10", null],
      ["2026-10-11", "partial"],
      ["2026-10-12", "missing"],
      ["2026-10-13", null],
      ["2026-10-14", null],
    ]);

    const ranks = rankHistory(agg, id, "stars");
    expect(ranks.find((point) => point.date === "2026-10-11")).toMatchObject({
      value: null,
      rank: null,
      growth: null,
      gap: "partial",
    });
    expect(ranks.find((point) => point.date === "2026-10-12")).toMatchObject({
      value: null,
      rank: null,
      growth: null,
      gap: "missing",
    });
    expect(ranks.find((point) => point.date === "2026-10-13")).toMatchObject({
      value: null,
      rank: null,
      growth: null,
      gap: "carried_forward",
    });
    expect(ranks.find((point) => point.date === "2026-10-14")).toMatchObject({
      value: 160,
      growth: null,
      gap: null,
    });
    const series = publicMetricSeries(agg, id, "stars");
    expect(series.find((point) => point.date === "2026-10-14")?.growth).toBeNull();
  });

  it("anchors the window on the latest complete date and drops a trailing partial", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-anchor-"));
    const id = "github:example/anchor";
    for (let offset = 16; offset >= 0; offset -= 1) {
      const date = addUtcDays("2026-10-20", -offset);
      const partial = date === "2026-10-12" || date === "2026-10-20";
      writeDay(dataDir, date, [{ id, name: "Anchor", npmWeekly: 100 + (16 - offset) }], partial);
    }
    const agg = buildAggregate(dataDir, "fixture");
    expect(agg.meta.latestCompleteDate).toBe("2026-10-19");
    expect(agg.meta.snapshotDates.at(-1)).toBe("2026-10-19");
    expect(agg.meta.snapshotDates).not.toContain("2026-10-20");
    const window = publicHistoryWindow(agg);
    expect(window.at(-1)?.date).toBe("2026-10-19");
    expect(window[0]?.date).toBe("2026-10-05");
    expect(window.some((day) => day.date === "2026-10-12" && day.gap === "partial")).toBe(true);
    const completeDays = window.filter((day) => day.gap == null);
    expect(completeDays.length).toBe(HISTORY_CAP_DAYS);
    expect(window.some((day) => day.date === "2026-10-04")).toBe(false);
  });

  it("resets categoryTrends previous at each gap and breaks on stars_source change", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-cat-gap-"));
    const id = "github:example/cat";
    writeDay(dataDir, "2026-10-10", [{ id, name: "Cat", stars: 100 }]);
    writeDay(dataDir, "2026-10-11", [{ id, name: "Cat", stars: 10_000 }], true);
    writeDay(dataDir, "2026-10-12", [{ id, name: "Cat", stars: 130 }]);
    writeDay(dataDir, "2026-10-13", [{ id, name: "Cat", stars: 500, starsSource: "gemini-cli" }]);
    const agg = buildAggregate(dataDir, "fixture");
    const points = categoryTrends(agg);
    expect(points.find((point) => point.date === "2026-10-11")).toMatchObject({
      appCount: null,
      stars: null,
      starsGrowth: null,
      gap: "partial",
    });
    expect(points.find((point) => point.date === "2026-10-12")).toMatchObject({
      stars: 130,
      starsGrowth: null,
      gap: null,
    });
    expect(points.find((point) => point.date === "2026-10-13")).toMatchObject({
      stars: 500,
      starsGrowth: null,
      gap: null,
    });
  });

  it("applies the 14-complete-day window and gap nulls to sparkValues", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-spark-"));
    const id = "github:example/spark";
    for (let offset = 16; offset >= 0; offset -= 1) {
      const date = addUtcDays("2026-10-20", -offset);
      const partial = date === "2026-10-12";
      const npmCarried = date === "2026-10-18";
      writeDay(
        dataDir,
        date,
        [{ id, name: "Spark", npmWeekly: npmCarried ? 99_999 : 100 + (16 - offset), npmCarried }],
        partial,
      );
    }
    const agg = buildAggregate(dataDir, "fixture");
    const values = sparkValues(agg, id, "npm_weekly_downloads");
    const window = publicHistoryWindow(agg);
    expect(values).toHaveLength(window.length);
    expect(window[0]?.date).toBe("2026-10-06");
    expect(window.at(-1)?.date).toBe("2026-10-20");
    expect(agg.meta.snapshotDates.length).toBeGreaterThan(values.filter((value) => value != null).length);
    const partialIndex = window.findIndex((day) => day.date === "2026-10-12");
    const carriedIndex = window.findIndex((day) => day.date === "2026-10-18");
    expect(values[partialIndex]).toBeNull();
    expect(values[carriedIndex]).toBeNull();
    expect(values.some((value) => value != null)).toBe(true);
    expect(JSON.stringify(values)).not.toContain("99999");
  });

  it("nulls categoryTrends starsGrowth when a carried_forward app is excluded from the sum", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-cat-carry-"));
    const id = "github:example/carry";
    writeDay(dataDir, "2026-10-10", [{ id, name: "Carry", stars: 100 }]);
    writeDay(dataDir, "2026-10-11", [{ id, name: "Carry", stars: 140, starsCarried: true }]);
    writeDay(dataDir, "2026-10-12", [{ id, name: "Carry", stars: 180 }]);
    const agg = buildAggregate(dataDir, "fixture");
    const points = categoryTrends(agg);
    expect(points.find((point) => point.date === "2026-10-11")).toMatchObject({
      starsGrowth: null,
      gap: null,
    });
    expect(points.find((point) => point.date === "2026-10-12")?.starsGrowth).toBeTruthy();
  });
});

describe("hidden smithery chart and public use_count", () => {
  it("top_charts with no chart never ranks on use_count", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-default-chart-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "fixture");
    const payload = JSON.parse(runTool(agg, "top_charts", {}).content[0]!.text);
    expect(payload.chart).toBe("npm");
    expect(payload.chart).not.toBe("smithery");
    expect(JSON.stringify(payload)).not.toMatch(/use_count|useCount/);
    expect(payload.rows[0]?.id).toBe("github:example/github-mcp");
  });

  it("top_charts with chart=smithery returns unavailable and /charts/smithery is not generated", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-no-smithery-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "fixture");
    const hidden = JSON.parse(runTool(agg, "top_charts", { chart: "smithery" }).content[0]!.text);
    expect(hidden).toEqual({ error: "chart unavailable: smithery" });
    expect(hidden.rows).toBeUndefined();
    expect(CHART_IDS).toEqual(["npm", "github", "gemini"]);
    expect(CHART_IDS).not.toContain("smithery");
    const chartPage = readFileSync(join(repoRoot, "web/app/charts/[chart]/page.tsx"), "utf8");
    expect(chartPage).toContain("generateStaticParams");
    expect(chartPage).toContain("CHART_IDS.map");
    expect(readFileSync(join(repoRoot, "web/app/charts/page.tsx"), "utf8")).toContain("/charts/npm");
    expect(readFileSync(join(repoRoot, "web/components/shell.tsx"), "utf8")).not.toContain("/charts/smithery");
    expect(readFileSync(join(repoRoot, "web/app/page.tsx"), "utf8")).not.toContain("/charts/smithery");
  });

  it("app_details and the app page contain no use_count/useCount", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-no-use-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "fixture");
    const detail = JSON.parse(runTool(agg, "app_details", { app_id: "github:brave/brave-search-mcp" }).content[0]!.text);
    expect(JSON.stringify(detail)).not.toMatch(/use_count|useCount/);
    expect(detail.app).not.toHaveProperty("useCount");
    const viaHelper = appDetail(agg, "github:brave/brave-search-mcp");
    expect(JSON.stringify(viaHelper)).not.toMatch(/use_count|useCount/);
    const page = readFileSync(join(repoRoot, "web/app/apps/[id]/page.tsx"), "utf8");
    expect(page).not.toMatch(/use_count|useCount/);
    expect(page).not.toMatch(/Use count/);
    const kpis = readFileSync(join(repoRoot, "web/components/kpis.tsx"), "utf8");
    expect(kpis).not.toMatch(/use_count|useCount|totalUseCount/);
    expect(kpis).toContain("fresh on");
    expect(kpis).not.toContain("fresh today");
  });

  it("movers page keeps the complete-day window and layers the fixture source check", () => {
    const page = readFileSync(join(repoRoot, "web/app/movers/page.tsx"), "utf8");
    expect(page).toContain("agg.meta.latestCompleteDate ?? agg.meta.latestDate");
    expect(page).toContain('agg.meta.source === "fixture" || agg.meta.origin === "fixture"');
    expect(page).not.toMatch(/formatDate\(agg\.meta\.weekAgoDate\)\} → \{formatDate\(agg\.meta\.latestDate\)\}/);
  });
});

describe("public output never includes useCount / use_count / u keys", () => {
  it("recursively scans built radar.json and MCP tool payloads", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-no-u-keys-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "fixture");
    expect(agg.apps.length).toBeGreaterThan(0);
    expect(Object.keys(agg.series).length).toBeGreaterThan(0);

    const out = mkdtempSync(join(tmpdir(), "radar-no-u-out-"));
    const written = writeAggregateFiles(agg, out);
    const radar = JSON.parse(readFileSync(written.json, "utf8")) as unknown;
    expect(collectForbiddenPublicKeys(radar)).toEqual([]);
    expect(agg.apps.some((app) => "useCount" in app)).toBe(false);
    expect(Object.values(agg.series).some((series) => "u" in series || "uc" in series)).toBe(false);

    const brave = "github:brave/brave-search-mcp";
    const toolArgs: Record<(typeof TOOL_NAMES)[number], Record<string, unknown>> = {
      search_apps: { query: "mcp" },
      app_details: { app_id: brave },
      rank_history: { app_id: brave, metric: "stars" },
      top_charts: { chart: "npm" },
      movers: { window: "1d" },
      competitors: { app_id: brave },
      category_trends: { category: "search" },
      multi_store: {},
      answer_share: {},
    };
    for (const name of TOOL_NAMES) {
      const payload = JSON.parse(runTool(agg, name, toolArgs[name]).content[0]!.text) as unknown;
      expect(collectForbiddenPublicKeys(payload), name).toEqual([]);
    }
    const extra = [
      runTool(agg, "rank_history", { app_id: brave }),
      runTool(agg, "movers", { window: "7d" }),
      runTool(agg, "top_charts", {}),
      runTool(agg, "search_apps", { query: "brave" }),
    ];
    for (const result of extra) {
      expect(collectForbiddenPublicKeys(JSON.parse(result.content[0]!.text))).toEqual([]);
    }
  });
});
