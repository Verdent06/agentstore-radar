import { KPI_FRESH_COVERAGE_TOLERANCE, KPI_MIN_FRESH_SHARE } from "../lib/config.ts";

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

export function freshShare(freshCount: number, eligibleCount: number): number {
  if (eligibleCount <= 0) {
    return 0;
  }
  return freshCount / eligibleCount;
}

/**
 * A complete day is "good" for a source only when its own fresh share is at
 * least KPI_MIN_FRESH_SHARE. Days are never compared to the previous day.
 *
 * TODO: once the collector's per-source manifest `fetchedShare` field lands,
 * add a consistency check that fresh share <= fetchedShare. Do not replace
 * fresh share with fetchedShare: fetchedShare counts frozen-but-fetched rows.
 */
export function minFreshShareForSource(source: KpiSource): number {
  const bySource: Record<KpiSource, number> = {
    github: KPI_MIN_FRESH_SHARE,
    npm: KPI_MIN_FRESH_SHARE,
    pypi: KPI_MIN_FRESH_SHARE,
  };
  return bySource[source];
}

export function isGoodFreshCoverageDay(
  day: DailyFreshCoverage,
  minShare = KPI_MIN_FRESH_SHARE,
): boolean {
  return day.eligibleCount > 0 && freshShare(day.freshCount, day.eligibleCount) >= minShare;
}

/**
 * Most recent complete day whose own fresh share is at least 80%.
 * When `todayDate` is set, use the latest good day strictly before today so
 * today's count can be checked against that baseline; a good today with no
 * prior good day is its own baseline.
 */
export function selectFreshCoverageBaseline(
  days: readonly DailyFreshCoverage[],
  todayDate?: string | null,
  minShare = KPI_MIN_FRESH_SHARE,
): DailyFreshCoverage | null {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const good = ordered.filter((day) => isGoodFreshCoverageDay(day, minShare));
  if (todayDate) {
    const prior = good.filter((day) => day.date < todayDate);
    if (prior.length > 0) {
      return prior.at(-1) ?? null;
    }
    return good.find((day) => day.date === todayDate) ?? null;
  }
  return good.at(-1) ?? null;
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

export function decideKpiFreshCoverage(
  source: KpiSource,
  days: readonly DailyFreshCoverage[],
  todayDate: string | null,
): KpiCoverageDecision {
  const minShare = minFreshShareForSource(source);
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const today = todayDate
    ? (ordered.find((day) => day.date === todayDate) ?? null)
    : (ordered.at(-1) ?? null);
  const baseline = selectFreshCoverageBaseline(ordered, today?.date ?? todayDate, minShare);
  if (!today) {
    return { held: true, reason: "no_baseline", today, baseline };
  }
  if (!isGoodFreshCoverageDay(today, minShare)) {
    return { held: true, reason: baseline ? "low_fresh_share" : "no_baseline", today, baseline };
  }
  if (!baseline) {
    return { held: true, reason: "no_baseline", today, baseline };
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
