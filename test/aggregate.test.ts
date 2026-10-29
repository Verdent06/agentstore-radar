import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAggregate, computeHeadlineStats, isFreshKpiValue } from "../src/aggregate/build.ts";
import { decideKpiFreshCoverage, selectFreshCoverageBaseline } from "../src/aggregate/kpi-coverage.ts";
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
    expect(brave).toBeDefined();
    expect(brave).not.toHaveProperty("useCount");
    expect(brave?.category).toBe("search");
    expect(agg.series[brave!.id]).not.toHaveProperty("u");
    expect(agg.series[brave!.id]).not.toHaveProperty("uc");

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
    pypiWeekly?: number;
    starsCarried?: boolean;
    npmCarried?: boolean;
    pypiCarried?: boolean;
    starsFrozen?: boolean;
    npmFrozen?: boolean;
    omitCarried?: boolean;
  },
): AppRow {
  const row: AppRow = {
    snapshot_date: date,
    app_id: id,
    sources: "github|npm|pypi",
    name: id,
    display_name: id,
    description: null,
    homepage: null,
    repo_url: `https://github.com/${id.replace(/^github:/, "")}`,
    npm_package: `@example/${id.split("/").at(-1)}`,
    pypi_package: id.split("/").at(-1) ?? "pkg",
    stars: flags.stars,
    forks: null,
    open_issues: null,
    pushed_at: null,
    use_count: 999_999,
    npm_weekly_downloads: flags.npmWeekly,
    pypi_last_week_downloads: flags.pypiWeekly ?? null,
    pypi_last_month_downloads: null,
    stars_fetched_at: `${date}T12:00:00.000Z`,
    use_count_fetched_at: null,
    use_count_carried_forward: false,
    npm_weekly_downloads_fetched_at: `${date}T12:00:00.000Z`,
    pypi_last_week_downloads_fetched_at: flags.pypiWeekly != null ? `${date}T12:00:00.000Z` : null,
    pypi_last_week_downloads_carried_forward: flags.pypiCarried ?? false,
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

function coverageApps(
  date: string,
  fresh: number,
  carried: number,
): AppRow[] {
  const rows: AppRow[] = [];
  for (let i = 0; i < fresh; i += 1) {
    rows.push(
      kpiApp(date, `github:example/fresh-${i}`, {
        stars: 2,
        npmWeekly: 3,
        pypiWeekly: 4,
        starsCarried: false,
        npmCarried: false,
        pypiCarried: false,
      }),
    );
  }
  for (let i = 0; i < carried; i += 1) {
    rows.push(
      kpiApp(date, `github:example/carried-${i}`, {
        stars: 20,
        npmWeekly: 30,
        pypiWeekly: 40,
        starsCarried: true,
        npmCarried: true,
        pypiCarried: true,
      }),
    );
  }
  return rows;
}

function writeKpiSnapshot(dataDir: string, date: string, apps: AppRow[], partial = false): void {
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
    partial,
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

  it("sums only latestCompleteDate rows and ignores a partial latest day", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-kpi-partial-"));
    writeKpiSnapshot(dataDir, "2026-10-23", [
      kpiApp("2026-10-23", "github:example/fresh", { stars: 100, npmWeekly: 200 }),
      kpiApp("2026-10-23", "github:example/leftover", { stars: 50_000, npmWeekly: 80_000 }),
    ]);
    writeKpiSnapshot(dataDir, "2026-10-24", [
      kpiApp("2026-10-24", "github:example/fresh", { stars: 110, npmWeekly: 220 }),
    ]);
    writeKpiSnapshot(
      dataDir,
      "2026-10-25",
      [
        kpiApp("2026-10-25", "github:example/fresh", { stars: 99_000, npmWeekly: 88_000 }),
        kpiApp("2026-10-25", "github:example/partial-only", { stars: 70_000, npmWeekly: 60_000 }),
      ],
      true,
    );

    const agg = buildAggregate(dataDir, "data_dir");
    expect(agg.meta.latestCompleteDate).toBe("2026-10-24");
    expect(agg.meta.latestDate).toBe("2026-10-24");
    expect(agg.stats.totalStars).toBe(110);
    expect(agg.stats.totalNpmWeekly).toBe(220);
    expect(agg.stats.totalStars).not.toBe(50_110);
    expect(agg.stats.totalStars).not.toBe(99_000);
    expect(agg.stats.totalNpmWeekly).not.toBe(88_000);
  });

  it("computeHeadlineStats skips rows whose snapshot_date is not latestCompleteDate", () => {
    const stats = computeHeadlineStats(
      [],
      ["2026-10-23", "2026-10-24", "2026-10-25"],
      "2026-10-25",
      "2026-10-24",
      null,
      "2026-10-24",
      [
        kpiApp("2026-10-23", "github:example/old", { stars: 50_000, npmWeekly: 80_000 }),
        kpiApp("2026-10-24", "github:example/complete", { stars: 110, npmWeekly: 220 }),
        kpiApp("2026-10-25", "github:example/partial", { stars: 99_000, npmWeekly: 88_000 }),
      ],
    );
    expect(stats.totalStars).toBe(110);
    expect(stats.totalNpmWeekly).toBe(220);
  });

  it("does not pick an npm 603-fresh day as baseline after a 4,535-fresh good day", () => {
    const low = coverageApps("2026-10-20", 603, 3_932);
    const good = coverageApps("2026-10-21", 4_535, 0);
    const today = coverageApps("2026-10-22", 610, 3_925);
    const rowsByDate = {
      "2026-10-20": low,
      "2026-10-21": good,
      "2026-10-22": today,
    };
    const series = [
      { date: "2026-10-20", freshCount: 603, eligibleCount: 4_535 },
      { date: "2026-10-21", freshCount: 4_535, eligibleCount: 4_535 },
      { date: "2026-10-22", freshCount: 610, eligibleCount: 4_535 },
    ];
    const baseline = selectFreshCoverageBaseline(series);
    expect(baseline?.date).toBe("2026-10-21");
    expect(baseline?.freshCount).toBe(4_535);
    expect(baseline?.freshCount).not.toBe(603);

    const stats = computeHeadlineStats(
      [],
      ["2026-10-20", "2026-10-21", "2026-10-22"],
      "2026-10-22",
      "2026-10-21",
      null,
      "2026-10-22",
      today,
      ["2026-10-20", "2026-10-21", "2026-10-22"],
      rowsByDate,
    );
    expect(stats.npmFreshCount).toBe(610);
    expect(stats.npmKpiHeld).toBe(true);
    expect(stats.starsKpiHeld).toBe(true);
    expect(stats.pypiKpiHeld).toBe(true);
    const lastDayOnly = decideKpiFreshCoverage("npm", [series[2]!], "2026-10-22");
    expect(lastDayOnly.held).toBe(true);
    expect(lastDayOnly.baseline).toBeNull();
  });

  it("holds GitHub, npm, and PyPI KPIs on Oct 25–27-style mostly carried_forward days", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-kpi-oct25-"));
    writeKpiSnapshot(dataDir, "2026-10-24", coverageApps("2026-10-24", 40, 0));
    writeKpiSnapshot(dataDir, "2026-10-25", coverageApps("2026-10-25", 3, 37));
    writeKpiSnapshot(dataDir, "2026-10-26", coverageApps("2026-10-26", 2, 38));
    writeKpiSnapshot(dataDir, "2026-10-27", coverageApps("2026-10-27", 4, 36));

    const agg = buildAggregate(dataDir, "data_dir");
    expect(agg.meta.latestCompleteDate).toBe("2026-10-27");
    expect(agg.stats.npmKpiHeld).toBe(true);
    expect(agg.stats.starsKpiHeld).toBe(true);
    expect(agg.stats.pypiKpiHeld).toBe(true);
    expect(agg.stats.npmFreshCount).toBe(4);
    expect(agg.stats.starsFreshCount).toBe(4);
    expect(agg.stats.pypiFreshCount).toBe(4);
    expect(agg.stats).not.toHaveProperty("totalUseCount");
    expect(JSON.stringify(agg.stats)).not.toMatch(/useCount|use_count|geminiStars|totalGemini/);
  });

  it("holds every KPI tile when no complete day reaches 80% fresh share", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-kpi-share-"));
    writeKpiSnapshot(dataDir, "2026-10-24", coverageApps("2026-10-24", 7, 3));
    writeKpiSnapshot(dataDir, "2026-10-25", coverageApps("2026-10-25", 7, 3));
    const agg = buildAggregate(dataDir, "data_dir");
    expect(agg.stats.starsFreshCount).toBe(7);
    expect(agg.stats.starsFreshCount / 10).toBeLessThan(0.8);
    expect(agg.stats.starsKpiHeld).toBe(true);
    expect(agg.stats.npmKpiHeld).toBe(true);
    expect(agg.stats.pypiKpiHeld).toBe(true);
    expect(agg.stats.npmFreshCount).toBe(7);
  });

  it("shows npm and stars when a good 80% day is followed by today within 10%", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-kpi-ok-"));
    writeKpiSnapshot(dataDir, "2026-10-24", coverageApps("2026-10-24", 8, 2));
    writeKpiSnapshot(dataDir, "2026-10-25", coverageApps("2026-10-25", 8, 2));
    const agg = buildAggregate(dataDir, "data_dir");
    expect(agg.stats.starsFreshCount / 10).toBe(0.8);
    expect(agg.stats.npmKpiHeld).toBe(false);
    expect(agg.stats.starsKpiHeld).toBe(false);
    expect(agg.stats.pypiKpiHeld).toBe(false);
  });
});
