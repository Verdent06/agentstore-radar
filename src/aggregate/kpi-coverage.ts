import {
  KPI_BASELINE_MIN_RATIO,
  KPI_FRESH_COVERAGE_TOLERANCE,
  KPI_MIN_FRESH_SHARE,
} from "../lib/config.ts";

/** Public homepage metric KPIs. Smithery use_count and Gemini stars stay excluded. */
export const KPI_SOURCES = ["github", "npm", "pypi"] as const;
export type KpiSource = (typeof KPI_SOURCES)[number];

export const KPI_HELD_LOW_FRESH_COVERAGE = "held: low fresh coverage";

export type DailyFreshCoverage = {
  date: string;
  freshCount: number;
  eligibleCount: number;
};

export type KpiCoverageDecision = {
  held: boolean;
  reason: "ok" | "low_fresh_coverage" | "low_fresh_share" | "no_baseline";
  today: DailyFreshCoverage | null;
  baseline: DailyFreshCoverage | null;
};

type KpiFreshRow = {
  snapshot_date?: string;
  stars?: number | null;
  stars_carried_forward?: boolean;
  stars_frozen?: boolean;
  npm_weekly_downloads?: number | null;
  npm_weekly_downloads_carried_forward?: boolean;
  npm_weekly_downloads_frozen?: boolean;
  pypi_last_week_downloads?: number | null;
  pypi_last_week_downloads_carried_forward?: boolean;
  pypi_last_week_downloads_frozen?: boolean;
};

/**
 * Home KPIs count a metric only when `*_carried_forward` is explicitly false
 * and `*_frozen` is not true. A missing `*_frozen` is fine (PR #11 has not
 * landed yet). A missing `*_carried_forward` is not fresh.
 */
export function isFreshKpiValue(carriedForward: unknown, frozen: unknown): boolean {
  return carriedForward === false && frozen !== true;
}

function metricAccess(
  source: KpiSource,
  row: KpiFreshRow,
): { value: number | null | undefined; carried: unknown; frozen: unknown } {
  switch (source) {
    case "github":
      return { value: row.stars, carried: row.stars_carried_forward, frozen: row.stars_frozen };
    case "npm":
      return {
        value: row.npm_weekly_downloads,
        carried: row.npm_weekly_downloads_carried_forward,
        frozen: row.npm_weekly_downloads_frozen,
      };
    case "pypi":
      return {
        value: row.pypi_last_week_downloads,
        carried: row.pypi_last_week_downloads_carried_forward,
        frozen: row.pypi_last_week_downloads_frozen,
      };
  }
}

export function countFreshCoverage(
  rows: readonly KpiFreshRow[],
  source: KpiSource,
): { freshCount: number; eligibleCount: number } {
  let freshCount = 0;
  let eligibleCount = 0;
  for (const row of rows) {
    const { value, carried, frozen } = metricAccess(source, row);
    if (value == null || !Number.isFinite(value)) {
      continue;
    }
    eligibleCount += 1;
    if (isFreshKpiValue(carried, frozen)) {
      freshCount += 1;
    }
  }
  return { freshCount, eligibleCount };
}

export function dailyFreshCoverage(
  date: string,
  rows: readonly KpiFreshRow[],
  source: KpiSource,
): DailyFreshCoverage {
  const scoped = rows.filter((row) => row.snapshot_date == null || row.snapshot_date === date);
  return { date, ...countFreshCoverage(scoped, source) };
}

/**
 * Walk complete days oldest → newest. The first day is good; each later day is
 * good only when its fresh count is not below 90% of the prior *good* day.
 * Returns that most recent good day — not necessarily the last complete day.
 */
export function selectFreshCoverageBaseline(
  days: readonly DailyFreshCoverage[],
  minRatio = KPI_BASELINE_MIN_RATIO,
): DailyFreshCoverage | null {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let baseline: DailyFreshCoverage | null = null;
  for (const day of ordered) {
    if (baseline == null || day.freshCount >= minRatio * baseline.freshCount) {
      baseline = day;
    }
  }
  return baseline;
}

/** True when `todayCount` is within ±tolerance of `baselineCount`. */
export function isFreshCountWithinTolerance(
  todayCount: number,
  baselineCount: number,
  tolerance = KPI_FRESH_COVERAGE_TOLERANCE,
): boolean {
  if (baselineCount <= 0) {
    return todayCount === 0;
  }
  return Math.abs(todayCount - baselineCount) <= tolerance * baselineCount;
}

export function freshShare(freshCount: number, eligibleCount: number): number {
  if (eligibleCount <= 0) {
    return 0;
  }
  return freshCount / eligibleCount;
}

export function minFreshShareForSource(source: KpiSource): number | undefined {
  if (source === "github") {
    return KPI_MIN_FRESH_SHARE.github;
  }
  return undefined;
}

export function decideKpiFreshCoverage(
  source: KpiSource,
  days: readonly DailyFreshCoverage[],
  todayDate: string | null,
): KpiCoverageDecision {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const baseline = selectFreshCoverageBaseline(ordered);
  const today = todayDate
    ? (ordered.find((day) => day.date === todayDate) ?? null)
    : (ordered.at(-1) ?? null);
  if (!today || !baseline) {
    return { held: true, reason: "no_baseline", today, baseline };
  }
  const minShare = minFreshShareForSource(source);
  if (minShare != null && (today.eligibleCount <= 0 || freshShare(today.freshCount, today.eligibleCount) < minShare)) {
    return { held: true, reason: "low_fresh_share", today, baseline };
  }
  if (!isFreshCountWithinTolerance(today.freshCount, baseline.freshCount)) {
    return { held: true, reason: "low_fresh_coverage", today, baseline };
  }
  return { held: false, reason: "ok", today, baseline };
}

export function coverageSeriesForSource(
  completeDates: readonly string[],
  rowsByDate: Map<string, readonly KpiFreshRow[]> | Record<string, readonly KpiFreshRow[]>,
  source: KpiSource,
): DailyFreshCoverage[] {
  return completeDates.map((date) => dailyFreshCoverage(date, rowsForDate(rowsByDate, date), source));
}

function rowsForDate(
  rowsByDate: Map<string, readonly KpiFreshRow[]> | Record<string, readonly KpiFreshRow[]>,
  date: string,
): readonly KpiFreshRow[] {
  if (rowsByDate instanceof Map) {
    return rowsByDate.get(date) ?? [];
  }
  return rowsByDate[date] ?? [];
}
