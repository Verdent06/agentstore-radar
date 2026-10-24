import {
  CATEGORY_LABELS,
  CHART_META,
  type Aggregate,
  type AppSummary,
  type CategorySlug,
  type ChartId,
  type HistoryPoint,
  type MetricKey,
  type MoverRow,
  type RankedApp,
} from "./types";

function clamp(limit: number | undefined, fallback: number, max = 100): number {
  if (limit == null || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

export function findApp(agg: Aggregate, id: string): AppSummary | undefined {
  const needle = decodeURIComponent(id).trim().toLowerCase();
  return agg.apps.find((app) => app.id.toLowerCase() === needle);
}

export function metricFromApp(app: AppSummary, metric: MetricKey): number | null {
  switch (metric) {
    case "use_count":
      return app.useCount;
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
  const column =
    metric === "use_count"
      ? series.u
      : metric === "stars"
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
  const column =
    metric === "use_count"
      ? series.uc
      : metric === "stars"
        ? series.sc
        : metric === "npm_weekly_downloads"
          ? series.nc
          : metric === "pypi_last_week_downloads"
            ? series.pc
            : undefined;
  return column?.[index] === 1;
}

function completeDates(agg: Aggregate): string[] {
  const partial = new Set(agg.meta.partialDates ?? []);
  return agg.meta.snapshotDates.filter((date) => !partial.has(date));
}

function previousFreshValue(agg: Aggregate, id: string, metric: MetricKey, fromIndex: number, walkBack: boolean): number | null {
  const partial = new Set(agg.meta.partialDates ?? []);
  const skip = (index: number) =>
    partial.has(agg.meta.snapshotDates[index] ?? "") || seriesCarried(agg, id, metric, index);
  if (walkBack) {
    for (let index = fromIndex; index >= 0; index -= 1) {
      if (skip(index)) continue;
      const value = seriesValue(agg, id, metric, index);
      if (value != null) return value;
    }
    return null;
  }
  if (skip(fromIndex)) return null;
  return seriesValue(agg, id, metric, fromIndex);
}

export function seriesToPoints(agg: Aggregate, id: string): HistoryPoint[] {
  const packed = agg.series[id];
  if (!packed) return [];
  return agg.meta.snapshotDates.map((date, index) => ({
    date,
    stars: packed.s?.[index] ?? null,
    useCount: packed.u?.[index] ?? null,
    npmWeeklyDownloads: packed.n?.[index] ?? null,
    pypiLastWeekDownloads: packed.p?.[index] ?? null,
    geminiStars: packed.g?.[index] ?? null,
  }));
}

export function sparkValues(agg: Aggregate, id: string, metric: MetricKey): Array<number | null> {
  return agg.meta.snapshotDates.map((_, index) => seriesValue(agg, id, metric, index));
}

export function topChart(agg: Aggregate, chart: ChartId, limit = 50): RankedApp[] {
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
  return rows.slice(0, clamp(limit, 50)).map((row, index) => {
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
  const complete = completeDates(agg);
  const toDate = complete.at(-1);
  if (!toDate) return [];
  let fromDate: string | undefined;
  if (options?.window === "7d") {
    const target = new Date(`${toDate}T00:00:00Z`);
    target.setUTCDate(target.getUTCDate() - 7);
    const wanted = target.toISOString().slice(0, 10);
    fromDate = complete.filter((date) => date <= wanted).at(-1) ?? complete[0];
  } else {
    fromDate = complete.length >= 2 ? complete.at(-2) : undefined;
  }
  if (!fromDate || fromDate === toDate) return [];
  const fromIndex = agg.meta.snapshotDates.indexOf(fromDate);
  const toIndex = agg.meta.snapshotDates.indexOf(toDate);
  const metrics: MetricKey[] = options?.metric
    ? [options.metric]
    : ["use_count", "stars", "npm_weekly_downloads", "gemini_stars"];
  const limit = clamp(options?.limit, 10);
  const out: MoverRow[] = [];
  for (const metric of metrics) {
    const scored: MoverRow[] = [];
    for (const app of agg.apps) {
      if (seriesCarried(agg, app.id, metric, toIndex)) continue;
      const current = seriesValue(agg, app.id, metric, toIndex);
      const previous = previousFreshValue(agg, app.id, metric, fromIndex, options?.window === "7d");
      if (previous == null || current == null || current === previous) continue;
      const delta = current - previous;
      scored.push({
        id: app.id,
        name: app.displayName,
        category: app.category,
        metric,
        previous,
        current,
        delta,
        pct: previous === 0 ? null : delta / previous,
      });
    }
    scored.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    out.push(...scored.slice(0, limit));
  }
  return out;
}

export function homeRows(agg: Aggregate, limit = 15): RankedApp[] {
  if (agg.meta.snapshotDates.length >= 2) {
    return movers(agg, { window: "1d", metric: "use_count", limit }).map((row, index) => {
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
  return topChart(agg, "smithery", limit);
}

export function searchApps(agg: Aggregate, query: string, limit = 40): AppSummary[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return agg.apps
    .filter((app) => {
      if (tokens.length === 0) return true;
      const hay = `${app.id} ${app.name} ${app.displayName} ${app.description ?? ""}`.toLowerCase();
      return tokens.every((token) => hay.includes(token));
    })
    .sort((a, b) => (b.useCount ?? -1) - (a.useCount ?? -1))
    .slice(0, clamp(limit, 40));
}

export function multiStoreApps(agg: Aggregate): AppSummary[] {
  return agg.apps
    .filter((app) => app.stores.length >= 2)
    .sort((a, b) => b.stores.length - a.stores.length || (b.useCount ?? -1) - (a.useCount ?? -1));
}

export function newArrivals(agg: Aggregate): AppSummary[] {
  const latest = agg.meta.latestDate;
  if (!latest) return [];
  return agg.apps
    .filter((app) => app.firstSeen === latest)
    .sort((a, b) => (b.useCount ?? b.stars ?? 0) - (a.useCount ?? a.stars ?? 0));
}

export function categorySummaries(agg: Aggregate) {
  const latest = agg.meta.latestDate;
  const map = new Map<CategorySlug, { slug: CategorySlug; label: string; appCount: number; useCount: number; stars: number; newThisSnapshot: number }>();
  for (const app of agg.apps) {
    const row = map.get(app.category) ?? {
      slug: app.category,
      label: CATEGORY_LABELS[app.category],
      appCount: 0,
      useCount: 0,
      stars: 0,
      newThisSnapshot: 0,
    };
    row.appCount += 1;
    row.useCount += app.useCount ?? 0;
    row.stars += app.stars ?? 0;
    if (latest && app.firstSeen === latest) row.newThisSnapshot += 1;
    map.set(app.category, row);
  }
  return [...map.values()].sort((a, b) => b.appCount - a.appCount);
}

export function appsInCategory(agg: Aggregate, slug: CategorySlug): AppSummary[] {
  return agg.apps
    .filter((app) => app.category === slug)
    .sort((a, b) => (b.useCount ?? -1) - (a.useCount ?? -1) || (b.stars ?? -1) - (a.stars ?? -1));
}

export function isChartId(value: string): value is ChartId {
  return value === "smithery" || value === "npm" || value === "github" || value === "gemini";
}

export function isCategorySlug(value: string): value is CategorySlug {
  return value in CATEGORY_LABELS;
}
