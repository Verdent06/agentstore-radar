import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAggregate, isFreshKpiValue } from "../src/aggregate/build.ts";
import { writeDemoSnapshots } from "../src/aggregate/demo.ts";
import { writeAggregateFiles } from "../src/aggregate/write.ts";
import { writeNormalized } from "../src/lib/io.ts";
import { emptySourceRow, type AppRow, type SnapshotManifest } from "../src/lib/schema.ts";

describe("buildAggregate", () => {
  it("builds compact public summaries from dated snapshots", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-agg-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "fixture");

    expect(agg.meta.origin).toBe("fixture");
    expect(agg.meta.source).toBe("fixture");
    expect(agg.meta.snapshotDates).toEqual(["2026-10-08", "2026-10-14", "2026-10-15"]);
    expect(agg.meta.latestDate).toBe("2026-10-15");
    expect(agg.meta.previousDate).toBe("2026-10-14");
    expect(agg.meta.weekAgoDate).toBe("2026-10-08");
    expect(agg.meta.partialDates).toEqual([]);
    expect(agg.stats.appCount).toBeGreaterThan(10);
    expect(agg.stats.multiStoreCount).toBeGreaterThan(0);

    const brave = agg.apps.find((app) => app.id === "github:brave/brave-search-mcp");
    expect(brave?.useCount).toBe(88000);
    expect(brave?.category).toBe("search");
    expect(agg.series[brave!.id]?.u).toEqual([72000, 85000, 88000]);

    const linear = agg.apps.find((app) => app.id === "github:example/linear-mcp");
    if (linear) {
      expect(linear.firstSeen).toBe("2026-10-15");
    }

    const gemini = agg.apps.find((app) => app.id === "github:obra/superpowers");
    expect(gemini?.geminiStars).toBe(300000);

    const weather = agg.apps.find((app) => app.id === "github:example/weather");
    expect(weather?.stores).toEqual(expect.arrayContaining(["mcp-registry", "smithery", "npm"]));

    const out = mkdtempSync(join(tmpdir(), "radar-out-"));
    const written = writeAggregateFiles(agg, out);
    const parsed = JSON.parse(readFileSync(written.json, "utf8"));
    expect(parsed.apps).toHaveLength(agg.apps.length);
    expect(JSON.stringify(parsed)).not.toMatch(/source_rows/);
    expect(parsed.stats).not.toHaveProperty("totalUseCount");
    expect(JSON.stringify(parsed.stats)).not.toMatch(/useCount|use_count|totalUseCount/);
    expect(agg.answerShare?.probeDate).toBe("2026-10-13");
    expect(agg.answerShare?.overall[0]?.appId).toBe("github:brave/brave-search-mcp");
  });

  it("records meta.source=private when origin is a live data dir", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-priv-src-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "data_dir");
    expect(agg.meta.origin).toBe("data_dir");
    expect(agg.meta.source).toBe("private");
  });

  it("does not treat a single snapshot as having movers windows", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-one-"));
    writeDemoSnapshots(dataDir, ["2026-10-15"]);
    const agg = buildAggregate(dataDir, "fixture");
    expect(agg.meta.previousDate).toBeNull();
    expect(agg.meta.partialDates).toEqual([]);
    expect(agg.stats.snapshotCount).toBe(1);
    expect(agg.answerShare).toBeNull();
  });
});

describe("isFreshKpiValue", () => {
  it("requires carried_forward === false and frozen !== true", () => {
    expect(isFreshKpiValue(false, undefined)).toBe(true);
    expect(isFreshKpiValue(false, false)).toBe(true);
    expect(isFreshKpiValue(true, undefined)).toBe(false);
    expect(isFreshKpiValue(false, true)).toBe(false);
    expect(isFreshKpiValue(undefined, undefined)).toBe(false);
    expect(isFreshKpiValue(undefined, false)).toBe(false);
  });
});

function kpiApp(
  date: string,
  id: string,
  flags: {
    stars: number;
    npmWeekly: number;
    starsCarried?: boolean;
    npmCarried?: boolean;
    starsFrozen?: boolean;
    npmFrozen?: boolean;
    omitCarried?: boolean;
  },
): AppRow {
  const row: AppRow = {
    snapshot_date: date,
    app_id: id,
    sources: "github|npm",
    name: id,
    display_name: id,
    description: null,
    homepage: null,
    repo_url: `https://github.com/${id.replace(/^github:/, "")}`,
    npm_package: `@example/${id.split("/").at(-1)}`,
    pypi_package: null,
    stars: flags.stars,
    forks: null,
    open_issues: null,
    pushed_at: null,
    use_count: 999_999,
    npm_weekly_downloads: flags.npmWeekly,
    pypi_last_week_downloads: null,
    pypi_last_month_downloads: null,
    stars_fetched_at: `${date}T12:00:00.000Z`,
    use_count_fetched_at: null,
    use_count_carried_forward: false,
    npm_weekly_downloads_fetched_at: `${date}T12:00:00.000Z`,
    pypi_last_week_downloads_fetched_at: null,
    pypi_last_week_downloads_carried_forward: false,
    pypi_last_month_downloads_fetched_at: null,
    pypi_last_month_downloads_carried_forward: false,
    stars_source: "github",
  };
  if (!flags.omitCarried) {
    row.stars_carried_forward = flags.starsCarried ?? false;
    row.npm_weekly_downloads_carried_forward = flags.npmCarried ?? false;
  }
  if (flags.starsFrozen != null) {
    row.stars_frozen = flags.starsFrozen;
  }
  if (flags.npmFrozen != null) {
    row.npm_weekly_downloads_frozen = flags.npmFrozen;
  }
  return row;
}

function writeKpiSnapshot(dataDir: string, date: string, apps: AppRow[]): void {
  const sourceRows = apps.flatMap((app) => [
    emptySourceRow({
      snapshot_date: date,
      app_id: app.app_id,
      source: "github",
      source_id: app.app_id.replace(/^github:/, ""),
      name: app.name,
      stars: app.stars,
    }),
    emptySourceRow({
      snapshot_date: date,
      app_id: app.app_id,
      source: "npm",
      source_id: app.npm_package ?? app.app_id,
      name: app.name,
      npm_weekly_downloads: app.npm_weekly_downloads,
    }),
  ]);
  const manifest: SnapshotManifest = {
    snapshotDate: date,
    collectedAt: `${date}T12:00:00.000Z`,
    appCount: apps.length,
    sourceRowCount: sourceRows.length,
    sources: [],
    partial: false,
  };
  writeNormalized(date, sourceRows, apps, manifest, dataDir);
}

describe("home KPI freshness", () => {
  it("sums only explicitly-fresh stars and npm weekly downloads", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-kpi-"));
    const date = "2026-10-15";
    writeKpiSnapshot(dataDir, date, [
      kpiApp(date, "github:example/fresh", { stars: 100, npmWeekly: 200, starsCarried: false, npmCarried: false }),
      kpiApp(date, "github:example/carried", { stars: 10_000, npmWeekly: 20_000, starsCarried: true, npmCarried: true }),
      kpiApp(date, "github:example/frozen", {
        stars: 10_000,
        npmWeekly: 20_000,
        starsCarried: false,
        npmCarried: false,
        starsFrozen: true,
        npmFrozen: true,
      }),
      kpiApp(date, "github:example/missing", { stars: 10_000, npmWeekly: 20_000, omitCarried: true }),
    ]);

    const agg = buildAggregate(dataDir, "data_dir");
    expect(agg.stats.totalStars).toBe(100);
    expect(agg.stats.totalNpmWeekly).toBe(200);
    expect(agg.stats).not.toHaveProperty("totalUseCount");
    expect(JSON.stringify(agg.stats)).not.toMatch(/useCount|use_count|totalUseCount/);

    const out = mkdtempSync(join(tmpdir(), "radar-kpi-out-"));
    const written = writeAggregateFiles(agg, out);
    const parsed = JSON.parse(readFileSync(written.json, "utf8")) as { stats: Record<string, unknown> };
    expect(parsed.stats).not.toHaveProperty("totalUseCount");
    expect(parsed.stats).not.toHaveProperty("useCount");
    expect(JSON.stringify(parsed.stats)).not.toMatch(/useCount|use_count|totalUseCount/);
    expect(parsed.stats.totalStars).toBe(100);
    expect(parsed.stats.totalNpmWeekly).toBe(200);
  });

  it("excludes carried_forward true, frozen true, and missing carried_forward independently", () => {
    const date = "2026-10-15";
    const cases: Array<{ id: string; flags: Parameters<typeof kpiApp>[2] }> = [
      { id: "github:example/carried-only", flags: { stars: 50, npmWeekly: 60, starsCarried: true, npmCarried: true } },
      {
        id: "github:example/frozen-only",
        flags: { stars: 50, npmWeekly: 60, starsCarried: false, npmCarried: false, starsFrozen: true, npmFrozen: true },
      },
      { id: "github:example/missing-only", flags: { stars: 50, npmWeekly: 60, omitCarried: true } },
    ];
    for (const testCase of cases) {
      const dataDir = mkdtempSync(join(tmpdir(), "radar-kpi-case-"));
      writeKpiSnapshot(dataDir, date, [
        kpiApp(date, "github:example/fresh", { stars: 7, npmWeekly: 9, starsCarried: false, npmCarried: false }),
        kpiApp(date, testCase.id, testCase.flags),
      ]);
      const agg = buildAggregate(dataDir, "data_dir");
      expect(agg.stats.totalStars, testCase.id).toBe(7);
      expect(agg.stats.totalNpmWeekly, testCase.id).toBe(9);
    }
  });
});
