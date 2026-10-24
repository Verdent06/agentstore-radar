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
import { appDetail, clampLimit, findApp, movers, publicAppIds, rankHistory, searchApps, seriesToPoints, topChart } from "../src/aggregate/query.ts";
import { runTool } from "../src/aggregate/tools.ts";
import { addUtcDays } from "../src/lib/dates.ts";
import { writeNormalized } from "../src/lib/io.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { emptySourceRow, type SnapshotManifest } from "../src/lib/schema.ts";

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
      out.push(
        emptySourceRow({
          snapshot_date: date,
          app_id: row.id,
          source: "github",
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
  it("keeps only the last 14 calendar days", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-hist-"));
    const latest = "2026-10-15";
    const cutoff = historyCutoffDate(latest);
    expect(cutoff).toBe("2026-10-02");
    for (let offset = 20; offset >= 0; offset -= 1) {
      const date = addUtcDays(latest, -offset);
      writeDay(dataDir, date, [{ id: "github:example/a", useCount: 100 + offset }]);
    }
    const agg = buildAggregate(dataDir, "fixture");
    expect(agg.meta.snapshotDates.length).toBeLessThanOrEqual(HISTORY_CAP_DAYS);
    expect(agg.meta.snapshotDates.every((date) => date >= cutoff)).toBe(true);
    expect(agg.meta.snapshotDates).not.toContain("2026-10-01");
    expect(JSON.stringify(agg)).not.toContain("2026-09-25");
    const history = rankHistory(agg, agg.apps[0]!.id, "use_count");
    expect(history.length).toBeLessThanOrEqual(HISTORY_CAP_DAYS);
  });
});

describe("list caps and public app pages", () => {
  it("caps every list at 10 and 404s apps outside the public top-10 union", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-cap-"));
    const ids = Array.from({ length: 20 }, (_, index) => ({
      id: `github:example/app-${String(index + 1).padStart(2, "0")}`,
      name: `App ${index + 1}`,
      useCount: (index + 1) * 1000,
    }));
    writeDay(
      dataDir,
      "2026-10-14",
      ids.map((row, index) => ({ ...row, useCount: row.useCount - (index + 1) * 100 })),
    );
    writeDay(dataDir, "2026-10-15", ids);
    const agg = buildAggregate(dataDir, "fixture");

    expect(topChart(agg, "smithery", 50).length).toBeLessThanOrEqual(PUBLIC_TOP_N);
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
    expect(payload.partialDates).toEqual(["2026-10-15"]);
  });
});

describe("rank_history metric fallback", () => {
  it("never ranks by use_count when metric is missing or unknown", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-metric-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "fixture");
    const id = "github:example/github-mcp";
    const missing = JSON.parse(runTool(agg, "rank_history", { app_id: id }).content[0]!.text);
    expect(missing.metric).toBe("npm_weekly_downloads");
    expect(missing.metric).not.toBe("use_count");
    expect(JSON.stringify(missing)).not.toContain("use_count");
    expect(missing.points.every((point: { growth?: string | null }) => point.growth == null || /%$/.test(point.growth))).toBe(true);

    const unknown = JSON.parse(runTool(agg, "rank_history", { app_id: id, metric: "not_a_metric" }).content[0]!.text);
    expect(unknown).toEqual({ error: "unknown metric: not_a_metric" });
    expect(JSON.stringify(unknown)).not.toContain("use_count");
    expect(unknown.points).toBeUndefined();

    const moversUnknown = JSON.parse(runTool(agg, "movers", { metric: "not_a_metric" }).content[0]!.text);
    expect(moversUnknown).toEqual({ error: "unknown metric: not_a_metric" });
    expect(JSON.stringify(moversUnknown)).not.toContain("use_count");
  });
});

describe("appDetail public history", () => {
  it("caps history to 14 complete days, rounds values, buckets growth, and skips partial/carried-forward points", () => {
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
    const cutoff = historyCutoffDate(latest);
    const detail = appDetail(agg, id);
    expect(detail).not.toBeNull();
    expect(detail?.ranks).not.toHaveProperty("use_count");
    expect(detail?.ranks).toHaveProperty("npm_weekly_downloads");
    expect(detail?.ranks).toHaveProperty("stars");

    const history = detail!.history;
    expect(history.length).toBeLessThanOrEqual(HISTORY_CAP_DAYS);
    expect(history.every((point) => point.date >= cutoff)).toBe(true);
    expect(history.some((point) => point.date === "2026-10-12")).toBe(false);
    expect(history.some((point) => point.date === "2026-10-04")).toBe(false);
    const carried = history.find((point) => point.date === "2026-10-18");
    expect(carried?.stars).toBeNull();
    expect(carried?.npmWeeklyDownloads).not.toBeNull();
    expect(JSON.stringify(history)).not.toContain("99999");
    expect(history.every((point) => point.stars == null || point.stars === round2sf(point.stars))).toBe(true);
    expect(history.some((point) => point.starsGrowth != null || point.npmGrowth != null)).toBe(true);
    expect(history.every((point) => point.starsGrowth == null || /%$/.test(point.starsGrowth))).toBe(true);
    expect(history.every((point) => point.npmGrowth == null || /%$/.test(point.npmGrowth))).toBe(true);

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
      runTool(agg, "top_charts", { chart: "smithery", limit: 50 }),
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
      if (Array.isArray(body.points)) expect(body.points.length).toBeLessThanOrEqual(HISTORY_CAP_DAYS);
      if (Array.isArray((body as { history?: unknown[] }).history)) {
        expect((body as { history: unknown[] }).history.length).toBeLessThanOrEqual(HISTORY_CAP_DAYS);
      }
    }
    const detail = JSON.parse(runTool(agg, "app_details", { app_id: brave }).content[0]!.text);
    expect(detail.ranks.use_count).toBeUndefined();
    const charts = JSON.parse(runTool(agg, "top_charts", { chart: "npm", limit: 50 }).content[0]!.text);
    expect(charts.rows.length).toBeLessThanOrEqual(PUBLIC_TOP_N);
    expect(charts.rows[0]).not.toHaveProperty("delta");
    const trends = JSON.parse(runTool(agg, "category_trends", { category: "search" }).content[0]!.text);
    expect(trends.points.every((point: { date: string }) => !agg.meta.partialDates.includes(point.date))).toBe(true);
    expect(trends.apps.length).toBeLessThanOrEqual(PUBLIC_TOP_N);
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
    expect(brave?.useCount).toBe(round2sf(87579));
    const weekly = movers(agg, { window: "7d", metric: "use_count" }).find((row) => row.id === "github:brave/brave-search-mcp");
    expect(weekly?.growth).toMatch(/%$/);
    expect(weekly).not.toHaveProperty("pct");
  });
});
