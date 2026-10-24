import { addUtcDays } from "../lib/dates.ts";
import { answerShareForApp } from "./answer-share.ts";
import { jaccardTokens, tokenize } from "./classify.ts";
import {
  COMPETITORS_CAP,
  MOVERS_PER_SIDE,
  PUBLIC_DEFAULT_LIMIT,
  PUBLIC_MAX_LIMIT,
  PUBLIC_TOP_N,
  completeSnapshotDates,
  growthBucket,
  roundCount,
} from "./public.ts";
import {
  CATEGORY_LABELS,
  CHART_IDS,
  CHART_META,
  METRIC_LABELS,
  type Aggregate,
  type AppSummary,
  type CategorySlug,
  type CategorySummary,
  type CategoryTrendPoint,
  type ChartId,
  type CompactSeries,
  type HistoryPoint,
  type MetricKey,
  type MoverRow,
  type AnswerSharePublic,
  type AnswerShareRowPublic,
  type RankedApp,
} from "./types.ts";

/** Default movers rank fresh npm downloads only until stars pass data audit. `use_count` stays out. */
export const DEFAULT_MOVER_METRICS: MetricKey[] = ["npm_weekly_downloads"];

export function clampLimit(limit: number | undefined, fallback = PUBLIC_DEFAULT_LIMIT): number {
  if (limit == null || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.max(1, Math.min(PUBLIC_MAX_LIMIT, Math.floor(limit)));
}

export function findApp(agg: Aggregate, id: string): AppSummary | undefined {
  const needle = id.trim().toLowerCase();
  return agg.apps.find((app) => app.id.toLowerCase() === needle);
}

export function seriesToPoints(agg: Aggregate, id: string): HistoryPoint[] {
  const packed = agg.series[id];
  if (!packed) {
    return [];
  }
  return agg.meta.snapshotDates.map((date, index) => ({
    date,
    stars: packed.s?.[index] ?? null,
    useCount: packed.u?.[index] ?? null,
    npmWeeklyDownloads: packed.n?.[index] ?? null,
    pypiLastWeekDownloads: packed.p?.[index] ?? null,
    geminiStars: packed.g?.[index] ?? null,
    starsCarriedForward: packed.sc?.[index] === 1,
    useCountCarriedForward: packed.uc?.[index] === 1,
    npmCarriedForward: packed.nc?.[index] === 1,
    pypiCarriedForward: packed.pc?.[index] === 1,
    starsSource: packed.ss?.[index] ?? null,
  }));
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

export function metricFromPoint(point: HistoryPoint, metric: MetricKey): number | null {
  switch (metric) {
    case "use_count":
      return point.useCount;
    case "stars":
      return point.stars;
    case "npm_weekly_downloads":
      return point.npmWeeklyDownloads;
    case "pypi_last_week_downloads":
      return point.pypiLastWeekDownloads;
    case "gemini_stars":
      return point.geminiStars;
  }
}

export function metricFromSeries(series: CompactSeries | undefined, metric: MetricKey, index: number): number | null {
  if (!series) {
    return null;
  }
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

export function metricCarriedForward(series: CompactSeries | undefined, metric: MetricKey, index: number): boolean {
  if (!series) {
    return false;
  }
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

function previousFreshIndex(
  agg: Aggregate,
  series: CompactSeries | undefined,
  metric: MetricKey,
  fromIndex: number,
  walkBack: boolean,
): number | null {
  const partial = new Set(agg.meta.partialDates ?? []);
  const skip = (index: number): boolean =>
    partial.has(agg.meta.snapshotDates[index] ?? "") || metricCarriedForward(series, metric, index);
  if (walkBack) {
    for (let index = fromIndex; index >= 0; index -= 1) {
      if (skip(index)) {
        continue;
      }
      if (metricFromSeries(series, metric, index) != null) {
        return index;
      }
    }
    return null;
  }
  if (skip(fromIndex) || metricFromSeries(series, metric, fromIndex) == null) {
    return null;
  }
  return fromIndex;
}

export function previousFreshValue(
  agg: Aggregate,
  series: CompactSeries | undefined,
  metric: MetricKey,
  fromIndex: number,
  walkBack: boolean,
): number | null {
  const index = previousFreshIndex(agg, series, metric, fromIndex, walkBack);
  return index == null ? null : metricFromSeries(series, metric, index);
}

function starsSourceAt(series: CompactSeries | undefined, index: number): string | null {
  return series?.ss?.[index] ?? null;
}

/** A `stars_source` change between the two days used for a delta is a series break. */
export function starsSourceBreak(
  series: CompactSeries | undefined,
  metric: MetricKey,
  fromIndex: number,
  toIndex: number,
): boolean {
  if (metric !== "stars") {
    return false;
  }
  return starsSourceAt(series, fromIndex) !== starsSourceAt(series, toIndex);
}

export function dateIndex(agg: Aggregate, date: string | null | undefined): number {
  if (!date) {
    return -1;
  }
  return agg.meta.snapshotDates.indexOf(date);
}

export function growthWindow(
  agg: Aggregate,
  window: "1d" | "7d",
): { fromDate: string; toDate: string; fromIndex: number; toIndex: number } | null {
  const complete = completeSnapshotDates(agg);
  const toDate = complete.at(-1);
  if (!toDate) {
    return null;
  }
  let fromDate: string | undefined;
  if (window === "7d") {
    const target = addUtcDays(toDate, -7);
    fromDate = complete.filter((date) => date <= target).at(-1) ?? complete[0];
  } else {
    fromDate = complete.length >= 2 ? complete.at(-2) : undefined;
  }
  if (!fromDate || fromDate === toDate) {
    return null;
  }
  const fromIndex = dateIndex(agg, fromDate);
  const toIndex = dateIndex(agg, toDate);
  if (fromIndex < 0 || toIndex < 0) {
    return null;
  }
  return { fromDate, toDate, fromIndex, toIndex };
}

function toMoverRow(app: AppSummary, metric: MetricKey, previous: number, current: number): MoverRow {
  const delta = current - previous;
  return {
    id: app.id,
    name: app.displayName,
    category: app.category,
    metric,
    previous,
    current,
    delta,
    growth: previous === 0 ? null : growthBucket(delta / previous),
  };
}

function rankedFromMovers(agg: Aggregate, rows: MoverRow[], cap: number): RankedApp[] {
  return rows.slice(0, cap).map((row, index) => {
    const app = findApp(agg, row.id);
    if (!app) {
      throw new Error(`Missing app ${row.id}`);
    }
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

export function topChart(agg: Aggregate, chart: ChartId, limit?: number): RankedApp[] {
  const { metric } = CHART_META[chart];
  const rows = agg.apps
    .map((app) => ({ app, value: metricFromApp(app, metric) }))
    .filter((row): row is { app: AppSummary; value: number } => row.value != null)
    .sort((a, b) => b.value - a.value || a.app.id.localeCompare(b.app.id));

  const prevDate = agg.meta.previousCompleteDate ?? agg.meta.previousDate;
  const prevIndex = dateIndex(agg, prevDate);
  const prevRank = new Map<string, number>();
  if (prevIndex >= 0) {
    const previous = agg.apps
      .map((app) => ({
        id: app.id,
        value: metricCarriedForward(agg.series[app.id], metric, prevIndex)
          ? null
          : metricFromSeries(agg.series[app.id], metric, prevIndex),
      }))
      .filter((row): row is { id: string; value: number } => row.value != null)
      .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
    previous.forEach((row, index) => prevRank.set(row.id, index + 1));
  }

  return rows.slice(0, clampLimit(limit, PUBLIC_TOP_N)).map((row, index) => {
    const previousValue =
      prevIndex >= 0 && !metricCarriedForward(agg.series[row.app.id], metric, prevIndex)
        ? metricFromSeries(agg.series[row.app.id], metric, prevIndex)
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

/** Metric used to rank the homepage list, or null when falling back to the npm chart. */
export function homeMoverMetric(agg: Aggregate): MetricKey | null {
  if (movers(agg, { window: "1d", metric: "npm_weekly_downloads", limit: 1 }).length > 0) {
    return "npm_weekly_downloads";
  }
  return null;
}

export function homeLeaders(agg: Aggregate, limit?: number): RankedApp[] {
  const cap = clampLimit(limit, PUBLIC_TOP_N);
  const npmMovers = movers(agg, { window: "1d", metric: "npm_weekly_downloads", limit: cap });
  if (npmMovers.length > 0) {
    return rankedFromMovers(agg, npmMovers, cap);
  }
  return topChart(agg, "npm", cap);
}

export function movers(
  agg: Aggregate,
  options?: { window?: "1d" | "7d"; metric?: MetricKey; limit?: number },
): MoverRow[] {
  const window = options?.window ?? "1d";
  const range = growthWindow(agg, window);
  if (!range) {
    return [];
  }
  const { fromIndex, toIndex } = range;
  const metrics: MetricKey[] = options?.metric ? [options.metric] : DEFAULT_MOVER_METRICS;
  const limit = clampLimit(options?.limit, MOVERS_PER_SIDE);
  const out: MoverRow[] = [];
  for (const metric of metrics) {
    const scored: MoverRow[] = [];
    for (const app of agg.apps) {
      const series = agg.series[app.id];
      if (metricCarriedForward(series, metric, toIndex)) {
        continue;
      }
      const current = metricFromSeries(series, metric, toIndex);
      const prevIndex = previousFreshIndex(agg, series, metric, fromIndex, window === "7d");
      if (prevIndex == null || current == null) {
        continue;
      }
      if (starsSourceBreak(series, metric, prevIndex, toIndex)) {
        continue;
      }
      const previous = metricFromSeries(series, metric, prevIndex);
      if (previous == null) {
        continue;
      }
      const delta = current - previous;
      if (delta === 0) {
        continue;
      }
      scored.push(toMoverRow(app, metric, previous, current));
    }
    const up = scored.filter((row) => row.delta > 0).sort((a, b) => b.delta - a.delta || a.id.localeCompare(b.id)).slice(0, limit);
    const down = scored.filter((row) => row.delta < 0).sort((a, b) => a.delta - b.delta || a.id.localeCompare(b.id)).slice(0, limit);
    out.push(...up, ...down);
  }
  return out;
}

export function searchApps(
  agg: Aggregate,
  query: string,
  options?: { category?: CategorySlug; limit?: number },
): AppSummary[] {
  const q = query.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const limit = clampLimit(options?.limit, PUBLIC_TOP_N);
  return agg.apps
    .filter((app) => {
      if (options?.category && app.category !== options.category) {
        return false;
      }
      if (tokens.length === 0) {
        return true;
      }
      const hay = `${app.id} ${app.name} ${app.displayName} ${app.description ?? ""} ${app.npmPackage ?? ""} ${app.pypiPackage ?? ""}`.toLowerCase();
      return tokens.every((token) => hay.includes(token));
    })
    .sort((a, b) => (b.useCount ?? -1) - (a.useCount ?? -1) || a.displayName.localeCompare(b.displayName))
    .slice(0, limit);
}

export function multiStoreApps(agg: Aggregate, limit?: number): AppSummary[] {
  return agg.apps
    .filter((app) => app.stores.length >= 2)
    .sort((a, b) => b.stores.length - a.stores.length || (b.useCount ?? -1) - (a.useCount ?? -1) || a.id.localeCompare(b.id))
    .slice(0, clampLimit(limit, PUBLIC_TOP_N));
}

export function newArrivals(agg: Aggregate, limit?: number): AppSummary[] {
  const latest = agg.meta.latestDate;
  if (!latest) {
    return [];
  }
  return agg.apps
    .filter((app) => app.firstSeen === latest)
    .sort((a, b) => (b.useCount ?? b.stars ?? 0) - (a.useCount ?? a.stars ?? 0) || a.displayName.localeCompare(b.displayName))
    .slice(0, clampLimit(limit, PUBLIC_TOP_N));
}

export function categories(agg: Aggregate): CategorySummary[] {
  const latest = agg.meta.latestDate;
  const map = new Map<CategorySlug, CategorySummary>();
  for (const slug of Object.keys(CATEGORY_LABELS) as CategorySlug[]) {
    map.set(slug, {
      slug,
      label: CATEGORY_LABELS[slug],
      appCount: 0,
      useCount: 0,
      stars: 0,
      newThisSnapshot: 0,
    });
  }
  for (const app of agg.apps) {
    const row = map.get(app.category);
    if (!row) {
      continue;
    }
    row.appCount += 1;
    row.useCount += app.useCount ?? 0;
    row.stars += app.stars ?? 0;
    if (latest && app.firstSeen === latest) {
      row.newThisSnapshot += 1;
    }
  }
  return [...map.values()]
    .filter((row) => row.appCount > 0)
    .map((row) => ({
      ...row,
      useCount: roundCount(row.useCount) ?? 0,
      stars: roundCount(row.stars) ?? 0,
    }))
    .sort((a, b) => b.appCount - a.appCount || a.slug.localeCompare(b.slug));
}

export function appsInCategory(agg: Aggregate, slug: CategorySlug, limit?: number): AppSummary[] {
  return agg.apps
    .filter((app) => app.category === slug)
    .sort((a, b) => (b.useCount ?? -1) - (a.useCount ?? -1) || (b.stars ?? -1) - (a.stars ?? -1) || a.id.localeCompare(b.id))
    .slice(0, clampLimit(limit, PUBLIC_TOP_N));
}

export function categoryTrends(agg: Aggregate, slug?: CategorySlug): CategoryTrendPoint[] {
  return agg.meta.snapshotDates.map((date, index) => {
    let appCount = 0;
    let useCount = 0;
    let stars = 0;
    for (const app of agg.apps) {
      if (slug && app.category !== slug) {
        continue;
      }
      const series = agg.series[app.id];
      const appeared = series && (series.s?.[index] != null || series.u?.[index] != null || series.n?.[index] != null || series.p?.[index] != null || series.g?.[index] != null);
      const knownByThen = app.firstSeen <= date && app.lastSeen >= date;
      if (!appeared && !knownByThen) {
        continue;
      }
      appCount += 1;
      useCount += metricFromSeries(series, "use_count", index) ?? 0;
      stars += metricFromSeries(series, "stars", index) ?? 0;
    }
    return { date, appCount, useCount: roundCount(useCount) ?? 0, stars: roundCount(stars) ?? 0 };
  });
}

export function rankHistory(agg: Aggregate, id: string, metric: MetricKey): Array<{ date: string; rank: number | null; value: number | null }> {
  const app = findApp(agg, id);
  if (!app) {
    return [];
  }
  return agg.meta.snapshotDates.map((date, index) => {
    const scored = agg.apps
      .map((candidate) => ({ id: candidate.id, value: metricFromSeries(agg.series[candidate.id], metric, index) }))
      .filter((row): row is { id: string; value: number } => row.value != null)
      .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
    const rank = scored.findIndex((row) => row.id === app.id);
    const value = metricFromSeries(agg.series[app.id], metric, index);
    return { date, rank: rank === -1 ? null : rank + 1, value };
  });
}

export function competitors(agg: Aggregate, id: string, limit?: number): Array<AppSummary & { score: number }> {
  const app = findApp(agg, id);
  if (!app) {
    return [];
  }
  const selfTokens = tokenize(`${app.displayName} ${app.description ?? ""}`);
  const scored = agg.apps
    .filter((other) => other.id !== app.id)
    .map((other) => {
      const tokens = tokenize(`${other.displayName} ${other.description ?? ""}`);
      let score = jaccardTokens(selfTokens, tokens);
      if (other.category === app.category) {
        score += 0.2;
      }
      const shared = other.stores.filter((store) => app.stores.includes(store)).length;
      score += shared * 0.05;
      return { ...other, score };
    })
    .filter((row) => row.score > 0.05)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, clampLimit(limit, COMPETITORS_CAP));
}

export function appDetail(agg: Aggregate, id: string) {
  const app = findApp(agg, id);
  if (!app) {
    return null;
  }
  return {
    app,
    history: seriesToPoints(agg, app.id),
    ranks: {
      use_count: rankHistory(agg, app.id, "use_count"),
      stars: rankHistory(agg, app.id, "stars"),
    },
    competitors: competitors(agg, app.id, COMPETITORS_CAP),
    answerShare: answerShareForApp(agg.answerShare, app.id),
  };
}

export function publicAnswerShare(
  agg: Aggregate,
  options?: { provider?: string; limit?: number },
): { available: false } | { available: true; probe: Omit<AnswerSharePublic, "overall" | "byProvider">; rows: AnswerShareRowPublic[] } {
  const share = agg.answerShare;
  if (!share) {
    return { available: false };
  }
  const rows = options?.provider ? (share.byProvider[options.provider] ?? []) : share.overall;
  return {
    available: true,
    probe: { probeDate: share.probeDate, promptVersion: share.promptVersion, meanJaccard: share.meanJaccard },
    rows: rows.slice(0, clampLimit(options?.limit, PUBLIC_TOP_N)),
  };
}

export function metricLabel(metric: MetricKey): string {
  return METRIC_LABELS[metric];
}

/** Union of apps that appear in a public top-10 list (charts ∪ movers ∪ home). */
export function publicAppIds(agg: Aggregate): Set<string> {
  const ids = new Set<string>();
  for (const chart of CHART_IDS) {
    for (const row of topChart(agg, chart, PUBLIC_TOP_N)) {
      ids.add(row.app.id);
    }
  }
  for (const row of homeLeaders(agg, PUBLIC_TOP_N)) {
    ids.add(row.app.id);
  }
  for (const window of ["1d", "7d"] as const) {
    for (const metric of DEFAULT_MOVER_METRICS) {
      for (const row of movers(agg, { window, metric, limit: PUBLIC_TOP_N })) {
        ids.add(row.id);
      }
    }
  }
  return ids;
}
