import { growthBucket, round2sf } from "./format";
import {
  CATEGORY_LABELS,
  CHART_IDS,
  CHART_META,
  type Aggregate,
  type AppSummary,
  type CategorySlug,
  type ChartId,
  type HistoryGap,
  type HistoryPoint,
  type MetricKey,
  type MoverRow,
  type RankedApp,
} from "./types";

export const PUBLIC_TOP_N = 10;
export const MOVERS_PER_SIDE = 5;
export const COMPETITORS_CAP = 5;
export const HISTORY_CAP_DAYS = 14;

/** Default movers rank fresh npm downloads only until stars pass data audit. `use_count` stays out. */
export const DEFAULT_MOVER_METRICS: MetricKey[] = ["npm_weekly_downloads"];

function clamp(limit: number | undefined, fallback: number, max = PUBLIC_TOP_N): number {
  if (limit == null || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

function addUtcDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function partialDates(agg: Aggregate): Set<string> {
  return new Set(agg.meta.partialDates ?? []);
}

function completeDates(agg: Aggregate): string[] {
  const partial = partialDates(agg);
  return agg.meta.snapshotDates.filter((date) => !partial.has(date));
}

function growthWindow(
  agg: Aggregate,
  window: "1d" | "7d",
): { fromDate: string; toDate: string; fromIndex: number; toIndex: number } | null {
  const complete = completeDates(agg);
  const toDate = complete.at(-1);
  if (!toDate) return null;
  let fromDate: string | undefined;
  if (window === "7d") {
    const target = addUtcDays(toDate, -7);
    fromDate = complete.filter((date) => date <= target).at(-1) ?? complete[0];
  } else {
    fromDate = complete.length >= 2 ? complete.at(-2) : undefined;
  }
  if (!fromDate || fromDate === toDate) return null;
  const fromIndex = agg.meta.snapshotDates.indexOf(fromDate);
  const toIndex = agg.meta.snapshotDates.indexOf(toDate);
  if (fromIndex < 0 || toIndex < 0) return null;
  return { fromDate, toDate, fromIndex, toIndex };
}

export function findApp(agg: Aggregate, id: string): AppSummary | undefined {
  const needle = decodeURIComponent(id).trim().toLowerCase();
  return agg.apps.find((app) => app.id.toLowerCase() === needle);
}

export function metricFromApp(app: AppSummary, metric: MetricKey): number | null {
  switch (metric) {
    case "use_count":
      return null;
    case "stars":
      return app.stars;
    case "npm_weekly_downloads":
      return app.npmWeeklyDownloads;
    case "pypi_last_week_downloads":
      return app.pypiLastWeekDownloads;
    case "gemini_stars":
      return app.geminiStars;
  }
}

function seriesValue(agg: Aggregate, id: string, metric: MetricKey, index: number): number | null {
  const series = agg.series[id];
  if (!series || index < 0) return null;
  if (metric === "use_count") return null;
  const column =
    metric === "stars"
      ? series.s
      : metric === "npm_weekly_downloads"
        ? series.n
        : metric === "pypi_last_week_downloads"
          ? series.p
          : series.g;
  return column?.[index] ?? null;
}

function seriesCarried(agg: Aggregate, id: string, metric: MetricKey, index: number): boolean {
  const series = agg.series[id];
  if (!series || index < 0) return false;
  if (metric === "use_count") return false;
  const column =
    metric === "stars"
      ? series.sc
      : metric === "npm_weekly_downloads"
        ? series.nc
        : metric === "pypi_last_week_downloads"
          ? series.pc
          : undefined;
  return column?.[index] === 1;
}

function previousFreshIndex(
  agg: Aggregate,
  id: string,
  metric: MetricKey,
  fromIndex: number,
  walkBack: boolean,
): number | null {
  const partial = partialDates(agg);
  const skip = (index: number) =>
    partial.has(agg.meta.snapshotDates[index] ?? "") || seriesCarried(agg, id, metric, index);
  if (walkBack) {
    for (let index = fromIndex; index >= 0; index -= 1) {
      if (skip(index)) continue;
      if (seriesValue(agg, id, metric, index) != null) return index;
    }
    return null;
  }
  if (skip(fromIndex) || seriesValue(agg, id, metric, fromIndex) == null) return null;
  return fromIndex;
}

function starsSourceBreak(agg: Aggregate, id: string, metric: MetricKey, fromIndex: number, toIndex: number): boolean {
  if (metric !== "stars") return false;
  const series = agg.series[id];
  return (series?.ss?.[fromIndex] ?? null) !== (series?.ss?.[toIndex] ?? null);
}

type PublicHistoryDay = { date: string; index: number | null; gap: HistoryGap | null };
type PublicMetricPoint = { date: string; value: number | null; growth: string | null; gap: HistoryGap | null };

function publicHistoryWindow(agg: Aggregate, capDays = HISTORY_CAP_DAYS): PublicHistoryDay[] {
  const complete = completeDates(agg);
  const toDate = complete.at(-1);
  if (!toDate) return [];
  const fromDate = complete.at(-capDays) ?? complete[0]!;
  const partial = partialDates(agg);
  const indexOf = new Map(agg.meta.snapshotDates.map((date, index) => [date, index]));
  const days: PublicHistoryDay[] = [];
  for (let date = fromDate; date <= toDate; date = addUtcDays(date, 1)) {
    const index = indexOf.get(date);
    if (index == null) {
      days.push({ date, index: null, gap: "missing" });
      continue;
    }
    days.push({ date, index, gap: partial.has(date) ? "partial" : null });
  }
  return days;
}

function publicMetricSeries(agg: Aggregate, id: string, metric: MetricKey): PublicMetricPoint[] {
  let previous: { index: number; value: number } | null = null;
  return publicHistoryWindow(agg).map((day) => {
    if (day.gap) {
      previous = null;
      return { date: day.date, value: null, growth: null, gap: day.gap };
    }
    const index = day.index;
    if (index == null) {
      previous = null;
      return { date: day.date, value: null, growth: null, gap: "missing" };
    }
    if (seriesCarried(agg, id, metric, index)) {
      previous = null;
      return { date: day.date, value: null, growth: null, gap: "carried_forward" };
    }
    const raw = seriesValue(agg, id, metric, index);
    const value = raw == null ? null : round2sf(raw);
    if (value == null) {
      previous = null;
      return { date: day.date, value: null, growth: null, gap: "missing" };
    }
    const broken = previous != null && starsSourceBreak(agg, id, metric, previous.index, index);
    const growth = broken || previous == null || previous.value === 0 ? null : growthBucket((value - previous.value) / previous.value);
    previous = { index, value };
    return { date: day.date, value, growth, gap: null };
  });
}

export function seriesToPoints(agg: Aggregate, id: string): HistoryPoint[] {
  const stars = publicMetricSeries(agg, id, "stars");
  const npm = publicMetricSeries(agg, id, "npm_weekly_downloads");
  const pypi = publicMetricSeries(agg, id, "pypi_last_week_downloads");
  const gemini = publicMetricSeries(agg, id, "gemini_stars");
  return stars.map((point, index) => ({
    date: point.date,
    stars: point.value,
    npmWeeklyDownloads: npm[index]?.value ?? null,
    pypiLastWeekDownloads: pypi[index]?.value ?? null,
    geminiStars: gemini[index]?.value ?? null,
    starsGap: point.gap,
    npmGap: npm[index]?.gap ?? null,
    pypiGap: pypi[index]?.gap ?? null,
    geminiGap: gemini[index]?.gap ?? null,
    starsGrowth: point.growth,
    npmGrowth: npm[index]?.growth ?? null,
    pypiGrowth: pypi[index]?.growth ?? null,
    geminiGrowth: gemini[index]?.growth ?? null,
  }));
}

export function sparkValues(agg: Aggregate, id: string, metric: MetricKey): Array<number | null> {
  return publicMetricSeries(agg, id, metric).map((point) => point.value);
}

export function topChart(agg: Aggregate, chart: ChartId, limit = PUBLIC_TOP_N): RankedApp[] {
  const { metric } = CHART_META[chart];
  const rows = agg.apps
    .map((app) => ({ app, value: metricFromApp(app, metric) }))
    .filter((row): row is { app: AppSummary; value: number } => row.value != null)
    .sort((a, b) => b.value - a.value || a.app.id.localeCompare(b.app.id));
  const prevDate = agg.meta.previousCompleteDate ?? agg.meta.previousDate;
  const prevIndex = prevDate ? agg.meta.snapshotDates.indexOf(prevDate) : -1;
  const prevRank = new Map<string, number>();
  if (prevIndex >= 0) {
    agg.apps
      .map((app) => ({
        id: app.id,
        value: seriesCarried(agg, app.id, metric, prevIndex) ? null : seriesValue(agg, app.id, metric, prevIndex),
      }))
      .filter((row): row is { id: string; value: number } => row.value != null)
      .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
      .forEach((row, index) => prevRank.set(row.id, index + 1));
  }
  return rows.slice(0, clamp(limit, PUBLIC_TOP_N)).map((row, index) => {
    const previousValue =
      prevIndex >= 0 && !seriesCarried(agg, row.app.id, metric, prevIndex)
        ? seriesValue(agg, row.app.id, metric, prevIndex)
        : null;
    return {
      rank: index + 1,
      previousRank: prevRank.get(row.app.id) ?? null,
      app: row.app,
      value: row.value,
      previousValue,
      delta: previousValue == null ? null : row.value - previousValue,
    };
  });
}

export function movers(
  agg: Aggregate,
  options?: { window?: "1d" | "7d"; metric?: MetricKey; limit?: number },
): MoverRow[] {
  const window = options?.window ?? "1d";
  const range = growthWindow(agg, window);
  if (!range) return [];
  const { fromIndex, toIndex } = range;
  const metrics: MetricKey[] = options?.metric ? [options.metric] : DEFAULT_MOVER_METRICS;
  const limit = clamp(options?.limit, MOVERS_PER_SIDE);
  const out: MoverRow[] = [];
  for (const metric of metrics) {
    const scored: MoverRow[] = [];
    for (const app of agg.apps) {
      if (seriesCarried(agg, app.id, metric, toIndex)) continue;
      const current = seriesValue(agg, app.id, metric, toIndex);
      const prevIndex = previousFreshIndex(agg, app.id, metric, fromIndex, window === "7d");
      if (prevIndex == null || current == null) continue;
      if (starsSourceBreak(agg, app.id, metric, prevIndex, toIndex)) continue;
      const previous = seriesValue(agg, app.id, metric, prevIndex);
      if (previous == null || current === previous) continue;
      const delta = current - previous;
      scored.push({
        id: app.id,
        name: app.displayName,
        category: app.category,
        metric,
        previous,
        current,
        delta,
        growth: previous === 0 ? null : growthBucket(delta / previous),
      });
    }
    const up = scored.filter((row) => row.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, limit);
    const down = scored.filter((row) => row.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, limit);
    out.push(...up, ...down);
  }
  return out;
}

export function homeMoverMetric(agg: Aggregate): MetricKey | null {
  if (movers(agg, { window: "1d", metric: "npm_weekly_downloads", limit: 1 }).length > 0) return "npm_weekly_downloads";
  return null;
}

export function homeRows(agg: Aggregate, limit = PUBLIC_TOP_N): RankedApp[] {
  const cap = clamp(limit, PUBLIC_TOP_N);
  const npmMovers = movers(agg, { window: "1d", metric: "npm_weekly_downloads", limit: cap });
  if (npmMovers.length > 0) {
    return npmMovers.slice(0, cap).map((row, index) => {
      const app = findApp(agg, row.id)!;
      return {
        rank: index + 1,
        previousRank: null,
        app,
        value: row.current,
        previousValue: row.previous,
        delta: row.delta,
      };
    });
  }
  return topChart(agg, "npm", cap);
}

export function searchApps(agg: Aggregate, query: string, limit = PUBLIC_TOP_N): AppSummary[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return agg.apps
    .filter((app) => {
      if (tokens.length === 0) return true;
      const hay = `${app.id} ${app.name} ${app.displayName} ${app.description ?? ""}`.toLowerCase();
      return tokens.every((token) => hay.includes(token));
    })
    .sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
    .slice(0, clamp(limit, PUBLIC_TOP_N));
}

export function multiStoreApps(agg: Aggregate, limit = PUBLIC_TOP_N): AppSummary[] {
  return agg.apps
    .filter((app) => app.stores.length >= 2)
    .sort((a, b) => b.stores.length - a.stores.length || (b.stars ?? -1) - (a.stars ?? -1))
    .slice(0, clamp(limit, PUBLIC_TOP_N));
}

export function newArrivals(agg: Aggregate, limit = PUBLIC_TOP_N): AppSummary[] {
  const latest = agg.meta.latestDate;
  if (!latest) return [];
  return agg.apps
    .filter((app) => app.firstSeen === latest)
    .sort((a, b) => (b.stars ?? b.npmWeeklyDownloads ?? 0) - (a.stars ?? a.npmWeeklyDownloads ?? 0))
    .slice(0, clamp(limit, PUBLIC_TOP_N));
}

export function categorySummaries(agg: Aggregate) {
  const latest = agg.meta.latestDate;
  const map = new Map<CategorySlug, { slug: CategorySlug; label: string; appCount: number; stars: number; newThisSnapshot: number }>();
  for (const app of agg.apps) {
    const row = map.get(app.category) ?? {
      slug: app.category,
      label: CATEGORY_LABELS[app.category],
      appCount: 0,
      stars: 0,
      newThisSnapshot: 0,
    };
    row.appCount += 1;
    row.stars += app.stars ?? 0;
    if (latest && app.firstSeen === latest) row.newThisSnapshot += 1;
    map.set(app.category, row);
  }
  return [...map.values()].sort((a, b) => b.appCount - a.appCount);
}

export function appsInCategory(agg: Aggregate, slug: CategorySlug, limit = PUBLIC_TOP_N): AppSummary[] {
  return agg.apps
    .filter((app) => app.category === slug)
    .sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
    .slice(0, clamp(limit, PUBLIC_TOP_N));
}

export function appPageParams(agg: Aggregate): Array<{ id: string }> {
  return agg.apps.map((app) => ({ id: app.id }));
}

export function isChartId(value: string): value is ChartId {
  return (CHART_IDS as readonly string[]).includes(value);
}

export function isCategorySlug(value: string): value is CategorySlug {
  return value in CATEGORY_LABELS;
}

export function isPartialDay(agg: Aggregate, date: string): boolean {
  return partialDates(agg).has(date);
}
