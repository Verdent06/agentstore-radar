import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KPI_HELD_LOW_FRESH_COVERAGE,
  KPI_SOURCES,
  countFreshCoverage,
  decideKpiFreshCoverage,
  isFreshCountWithinTolerance,
  isFreshKpiValue,
  isGoodFreshCoverageDay,
  selectFreshCoverageBaseline,
  type DailyFreshCoverage,
} from "../src/aggregate/kpi-coverage.ts";
import { KPI_FRESH_COVERAGE_TOLERANCE, KPI_MIN_FRESH_SHARE } from "../src/lib/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

function day(date: string, freshCount: number, eligibleCount = freshCount): DailyFreshCoverage {
  return { date, freshCount, eligibleCount };
}

describe("KPI fresh-coverage constants", () => {
  it("exposes an 80% per-source fresh-share bar and a 10% count tolerance", () => {
    expect(KPI_MIN_FRESH_SHARE).toBe(0.8);
    expect(KPI_FRESH_COVERAGE_TOLERANCE).toBe(0.1);
    expect(KPI_HELD_LOW_FRESH_COVERAGE).toBe("held: low fresh coverage");
  });

  it("evaluates github, npm, and pypi only — not Smithery use_count or Gemini stars", () => {
    expect(KPI_SOURCES).toEqual(["github", "npm", "pypi"]);
    expect(KPI_SOURCES).not.toContain("smithery");
    expect(KPI_SOURCES).not.toContain("gemini-cli");
    expect(KPI_SOURCES).not.toContain("gemini");
  });
});

describe("selectFreshCoverageBaseline", () => {
  it("does not use an npm 603-fresh day as baseline when a later 4,535-fresh day is good", () => {
    const days = [
      day("2026-10-20", 603, 4_535),
      day("2026-10-21", 4_535, 4_535),
      day("2026-10-22", 610, 4_535),
    ];
    expect(isGoodFreshCoverageDay(days[0]!)).toBe(false);
    expect(isGoodFreshCoverageDay(days[1]!)).toBe(true);
    const baseline = selectFreshCoverageBaseline(days);
    expect(baseline?.date).toBe("2026-10-21");
    expect(baseline?.freshCount).toBe(4_535);
    expect(baseline?.date).not.toBe("2026-10-20");
    expect(baseline?.freshCount).not.toBe(603);

    const npm = decideKpiFreshCoverage("npm", days, "2026-10-22");
    expect(npm.held).toBe(true);
    expect(npm.baseline?.freshCount).toBe(4_535);
    expect(npm.today?.freshCount).toBe(610);
  });
});

describe("absolute 80% fresh-share baseline (fails if the relative walk returns)", () => {
  it("(a) slow slide 100, 91, 82, 74 holds once share drops below 80%", () => {
    const days = [
      day("2026-10-21", 100, 100),
      day("2026-10-22", 91, 100),
      day("2026-10-23", 82, 100),
      day("2026-10-24", 74, 100),
    ];
    // A 90%-of-prior-count walk would still treat 74 as good (74 >= 0.9 * 82).
    expect(74).toBeGreaterThanOrEqual(0.9 * 82);
    expect(74 / 100).toBeLessThan(KPI_MIN_FRESH_SHARE);
    expect(isGoodFreshCoverageDay(days[3]!)).toBe(false);
    const npm = decideKpiFreshCoverage("npm", days, "2026-10-24");
    expect(npm.held).toBe(true);
    expect(npm.reason).not.toBe("ok");
    expect(selectFreshCoverageBaseline(days, "2026-10-24")?.freshCount).toBe(82);
  });

  it("(b) a window that opens on a 0.4% day then an equally bad today is held", () => {
    const days = [day("2026-10-25", 18, 4_535), day("2026-10-26", 18, 4_535)];
    expect(18 / 4_535).toBeCloseTo(0.004, 3);
    expect(isGoodFreshCoverageDay(days[0]!)).toBe(false);
    expect(isFreshCountWithinTolerance(18, 18)).toBe(true);
    const npm = decideKpiFreshCoverage("npm", days, "2026-10-26");
    expect(npm.held).toBe(true);
    expect(selectFreshCoverageBaseline(days, "2026-10-26")).toBeNull();
  });

  it("(c) no good day means every tile is held", () => {
    const days = [day("2026-10-25", 10, 100), day("2026-10-26", 12, 100), day("2026-10-27", 11, 100)];
    for (const source of KPI_SOURCES) {
      const decision = decideKpiFreshCoverage(source, days, "2026-10-27");
      expect(decision.held, source).toBe(true);
      expect(decision.baseline, source).toBeNull();
      expect(decision.reason, source).toBe("no_baseline");
    }
  });

  it("(d) a good baseline plus today at 80% or more and within 10% shows the tile", () => {
    const days = [day("2026-10-24", 100, 100), day("2026-10-25", 95, 100)];
    expect(isGoodFreshCoverageDay(days[0]!)).toBe(true);
    expect(isGoodFreshCoverageDay(days[1]!)).toBe(true);
    expect(95 / 100).toBeGreaterThanOrEqual(KPI_MIN_FRESH_SHARE);
    expect(isFreshCountWithinTolerance(95, 100)).toBe(true);
    const npm = decideKpiFreshCoverage("npm", days, "2026-10-25");
    expect(npm.held).toBe(false);
    expect(npm.reason).toBe("ok");
    expect(npm.baseline?.freshCount).toBe(100);
  });

  it("(e) today at 80% or more but more than 10% off the baseline is held", () => {
    const days = [day("2026-10-24", 100, 100), day("2026-10-25", 80, 100)];
    expect(80 / 100).toBeGreaterThanOrEqual(KPI_MIN_FRESH_SHARE);
    expect(isGoodFreshCoverageDay(days[1]!)).toBe(true);
    expect(isFreshCountWithinTolerance(80, 100)).toBe(false);
    expect(isFreshCountWithinTolerance(80, 80)).toBe(true);
    const npm = decideKpiFreshCoverage("npm", days, "2026-10-25");
    expect(npm.held).toBe(true);
    expect(npm.reason).toBe("low_fresh_coverage");
    expect(npm.baseline?.freshCount).toBe(100);
    expect(npm.today?.freshCount).toBe(80);
  });
});

describe("Oct 25–27-style carried_forward coverage", () => {
  it("holds GitHub, npm, and PyPI KPIs when those days are mostly carried_forward", () => {
    const days = [
      day("2026-10-24", 4_000, 4_000),
      day("2026-10-25", 180, 4_000),
      day("2026-10-26", 160, 4_000),
      day("2026-10-27", 190, 4_000),
    ];
    for (const source of KPI_SOURCES) {
      const decision = decideKpiFreshCoverage(source, days, "2026-10-27");
      expect(decision.held, source).toBe(true);
      expect(decision.baseline?.date, source).toBe("2026-10-24");
      expect(decision.baseline?.freshCount, source).toBe(4_000);
      expect(decision.today?.freshCount, source).toBe(190);
    }
  });
});

describe("GitHub stars minimum fresh share", () => {
  it("holds the stars KPI when fresh share is below 80%", () => {
    expect(KPI_MIN_FRESH_SHARE).toBe(0.8);
    const days = [day("2026-10-24", 79, 100), day("2026-10-25", 79, 100)];
    const stars = decideKpiFreshCoverage("github", days, "2026-10-25");
    expect(stars.held).toBe(true);
    expect(79 / 100).toBeLessThan(KPI_MIN_FRESH_SHARE);
    expect(isFreshCountWithinTolerance(79, 79)).toBe(true);
  });

  it("does not hold stars on the share rule at exactly 80% when the count is within 10%", () => {
    const days = [day("2026-10-24", 80, 100), day("2026-10-25", 80, 100)];
    const stars = decideKpiFreshCoverage("github", days, "2026-10-25");
    expect(80 / 100).toBe(KPI_MIN_FRESH_SHARE);
    expect(stars.held).toBe(false);
    expect(stars.reason).toBe("ok");
  });
});

describe("countFreshCoverage", () => {
  it("uses carried_forward === false and not frozen, same as isFreshKpiValue", () => {
    expect(isFreshKpiValue(false, undefined)).toBe(true);
    const counted = countFreshCoverage(
      [
        { npm_weekly_downloads: 1, npm_weekly_downloads_carried_forward: false },
        { npm_weekly_downloads: 1, npm_weekly_downloads_carried_forward: true },
        { npm_weekly_downloads: 1, npm_weekly_downloads_carried_forward: false, npm_weekly_downloads_frozen: true },
        { npm_weekly_downloads: 1 },
        { npm_weekly_downloads: null, npm_weekly_downloads_carried_forward: false },
      ],
      "npm",
    );
    expect(counted).toEqual({ freshCount: 1, eligibleCount: 4 });
  });
});

describe("guard source wiring (fails if reverted)", () => {
  it("keeps the 80% own-share baseline and fetchedShare TODO in the public KPI path", () => {
    const coverage = readFileSync(join(repoRoot, "src/aggregate/kpi-coverage.ts"), "utf8");
    const build = readFileSync(join(repoRoot, "src/aggregate/build.ts"), "utf8");
    const config = readFileSync(join(repoRoot, "src/lib/config.ts"), "utf8");
    const kpis = readFileSync(join(repoRoot, "web/components/kpis.tsx"), "utf8");
    const tests = readFileSync(join(here, "kpi-coverage.test.ts"), "utf8");
    expect(config).toContain("KPI_MIN_FRESH_SHARE = 0.8");
    expect(config).toContain("KPI_FRESH_COVERAGE_TOLERANCE = 0.1");
    expect(config).not.toContain("KPI_BASELINE_MIN_RATIO");
    expect(coverage).toContain("export function selectFreshCoverageBaseline");
    expect(coverage).toContain("export function isGoodFreshCoverageDay");
    expect(coverage).toContain("fresh share <= fetchedShare");
    expect(coverage).toContain("Do not replace");
    expect(coverage).toContain("fetchedShare counts frozen-but-fetched rows");
    expect(coverage).not.toMatch(/minRatio \* baseline/);
    expect(build).toContain("decideKpiFreshCoverage");
    expect(build).toContain("coverageSeriesForSource");
    expect(build).toContain('kpiHeld("github")');
    expect(build).toContain('kpiHeld("npm")');
    expect(build).toContain('kpiHeld("pypi")');
    expect(kpis).toContain("held: low fresh coverage");
    expect(kpis).toContain("across ");
    expect(kpis).toContain("fresh packages");
    expect(kpis).toContain("round2sf");
    expect(kpis).toContain("npmKpiHeld");
    expect(kpis).toContain("starsKpiHeld");
    expect(tests).toContain("slow slide 100, 91, 82, 74");
    expect(tests).toContain("0.4%");
    expect(tests).toContain("no good day means every tile is held");
    expect(tests).toContain("more than 10% off the baseline is held");
  });
});
