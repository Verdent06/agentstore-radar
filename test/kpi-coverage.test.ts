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
  selectFreshCoverageBaseline,
  type DailyFreshCoverage,
} from "../src/aggregate/kpi-coverage.ts";
import {
  KPI_BASELINE_MIN_RATIO,
  KPI_FRESH_COVERAGE_TOLERANCE,
  KPI_MIN_FRESH_SHARE,
} from "../src/lib/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

function day(date: string, freshCount: number, eligibleCount = freshCount): DailyFreshCoverage {
  return { date, freshCount, eligibleCount };
}

describe("KPI fresh-coverage constants", () => {
  it("exposes a 90% prior-good-day baseline, 10% show tolerance, and 80% GitHub min share", () => {
    expect(KPI_BASELINE_MIN_RATIO).toBe(0.9);
    expect(KPI_FRESH_COVERAGE_TOLERANCE).toBe(0.1);
    expect(KPI_MIN_FRESH_SHARE.github).toBe(0.8);
    expect(KPI_MIN_FRESH_SHARE).toEqual({ github: 0.8 });
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
    const baseline = selectFreshCoverageBaseline(days);
    expect(baseline?.date).toBe("2026-10-21");
    expect(baseline?.freshCount).toBe(4_535);
    expect(baseline?.date).not.toBe("2026-10-20");
    expect(baseline?.freshCount).not.toBe(603);
    expect(baseline?.date).not.toBe("2026-10-22");

    const lastComplete = days.at(-1)!;
    expect(lastComplete.freshCount).toBe(610);
    // A last-complete-day baseline of 610 would unlock today's similarly-low KPI.
    expect(isFreshCountWithinTolerance(lastComplete.freshCount, lastComplete.freshCount)).toBe(true);
    expect(isFreshCountWithinTolerance(lastComplete.freshCount, 603)).toBe(true);
    expect(isFreshCountWithinTolerance(lastComplete.freshCount, baseline!.freshCount)).toBe(false);

    const npm = decideKpiFreshCoverage("npm", days, "2026-10-22");
    expect(npm.held).toBe(true);
    expect(npm.reason).toBe("low_fresh_coverage");
    expect(npm.baseline?.freshCount).toBe(4_535);
    expect(npm.today?.freshCount).toBe(610);
  });

  it("keeps walking off the prior good day, not a low intervening day", () => {
    const days = [day("2026-10-01", 4_535), day("2026-10-02", 603), day("2026-10-03", 580)];
    const baseline = selectFreshCoverageBaseline(days);
    expect(baseline).toEqual(day("2026-10-01", 4_535));
    expect(580).toBeGreaterThanOrEqual(KPI_BASELINE_MIN_RATIO * 603);
    expect(580).toBeLessThan(KPI_BASELINE_MIN_RATIO * 4_535);
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
    expect(KPI_MIN_FRESH_SHARE.github).toBe(0.8);
    const days = [day("2026-10-24", 79, 100), day("2026-10-25", 79, 100)];
    const stars = decideKpiFreshCoverage("github", days, "2026-10-25");
    expect(stars.held).toBe(true);
    expect(stars.reason).toBe("low_fresh_share");
    expect(79 / 100).toBeLessThan(KPI_MIN_FRESH_SHARE.github);
    expect(isFreshCountWithinTolerance(79, 79)).toBe(true);

    const npm = decideKpiFreshCoverage("npm", days, "2026-10-25");
    expect(npm.held).toBe(false);
    expect(npm.reason).toBe("ok");
  });

  it("does not hold stars on the share rule at exactly 80% when the baseline is close", () => {
    const days = [day("2026-10-24", 80, 100), day("2026-10-25", 80, 100)];
    const stars = decideKpiFreshCoverage("github", days, "2026-10-25");
    expect(80 / 100).toBe(KPI_MIN_FRESH_SHARE.github);
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
  it("keeps selectFreshCoverageBaseline and the held label in the public KPI path", () => {
    const coverage = readFileSync(join(repoRoot, "src/aggregate/kpi-coverage.ts"), "utf8");
    const build = readFileSync(join(repoRoot, "src/aggregate/build.ts"), "utf8");
    const config = readFileSync(join(repoRoot, "src/lib/config.ts"), "utf8");
    const kpis = readFileSync(join(repoRoot, "web/components/kpis.tsx"), "utf8");
    expect(config).toContain("KPI_MIN_FRESH_SHARE");
    expect(config).toMatch(/github:\s*0\.8/);
    expect(config).toContain("KPI_BASELINE_MIN_RATIO = 0.9");
    expect(config).toContain("KPI_FRESH_COVERAGE_TOLERANCE = 0.1");
    expect(coverage).toContain("export function selectFreshCoverageBaseline");
    expect(coverage).toContain("prior *good* day");
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
  });
});
