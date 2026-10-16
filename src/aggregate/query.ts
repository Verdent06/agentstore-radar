import { jaccardTokens, tokenize } from "./classify.ts";
import {
  CATEGORY_LABELS,
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
  type RankedApp,
} from "./types.ts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export function clampLimit(limit: number | undefined, fallback = DEFAULT_LIMIT): number {
  if (limit == null || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
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

export function dateIndex(agg: Aggregate, date: string | null | undefined): number {
  if (!date) {
    return -1;
  }
  return agg.meta.snapshotDates.indexOf(date);
}

export function topChart(agg: Aggregate, chart: ChartId, limit?: number): RankedApp[] {
  const { metric } = CHART_META[chart];
  const rows = agg.apps
    .map((app) => ({ app, value: metricFromApp(app, metric) }))
    .filter((row): row is { app: AppSummary; value: number } => row.value != null)
    .sort((a, b) => b.value - a.value || a.app.id.localeCompare(b.app.id));

  const prevDate = agg.meta.previousDate;
  const prevIndex = dateIndex(agg, prevDate);
  const prevRank = new Map<string, number>();
  if (prevIndex >= 0) {
    const previous = agg.apps
      .map((app) => ({ id: app.id, value: metricFromSeries(agg.series[app.id], metric, prevIndex) }))
      .filter((row): row is { id: string; value: number } => row.value != null)
      .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
    previous.forEach((row, index) => prevRank.set(row.id, index + 1));
  }

  return rows.slice(0, clampLimit(limit)).map((row, index) => {
    const previousValue =
      prevIndex >= 0 ? metricFromSeries(agg.series[row.app.id], metric, prevIndex) : null;
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

export function homeLeaders(agg: Aggregate, limit?: number): RankedApp[] {
  if (agg.meta.snapshotDates.length >= 2) {
    return movers(agg, { window: "1d", metric: "use_count", limit }).map((row, index) => {
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
  return topChart(agg, "smithery", limit);
}

export function movers(
  agg: Aggregate,
  options?: { window?: "1d" | "7d"; metric?: MetricKey; limit?: number },
): MoverRow[] {
  const window = options?.window ?? "1d";
  const fromDate = window === "7d" ? agg.meta.weekAgoDate : agg.meta.previousDate;
  const toDate = agg.meta.latestDate;
  if (!fromDate || !toDate || fromDate === toDate) {
    return [];
  }
  const fromIndex = dateIndex(agg, fromDate);
  const toIndex = dateIndex(agg, toDate);
  if (fromIndex < 0 || toIndex < 0) {
    return [];
  }
  const metrics: MetricKey[] = options?.metric ? [options.metric] : ["use_count", "stars", "npm_weekly_downloads", "gemini_stars"];
  const limit = clampLimit(options?.limit, 10);
  const out: MoverRow[] = [];
  for (const metric of metrics) {
    const scored: MoverRow[] = [];
    for (const app of agg.apps) {
      const previous = metricFromSeries(agg.series[app.id], metric, fromIndex);
      const current = metricFromSeries(agg.series[app.id], metric, toIndex);
      if (previous == null || current == null) {
        continue;
      }
      const delta = current - previous;
      if (delta === 0) {
        continue;
      }
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
    scored.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.id.localeCompare(b.id));
    out.push(...scored.slice(0, limit));
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
  const limit = clampLimit(options?.limit);
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
    .slice(0, clampLimit(limit, 50));
}

export function newArrivals(agg: Aggregate, limit?: number): AppSummary[] {
  const latest = agg.meta.latestDate;
  if (!latest) {
    return [];
  }
  return agg.apps
    .filter((app) => app.firstSeen === latest)
    .sort((a, b) => (b.useCount ?? b.stars ?? 0) - (a.useCount ?? a.stars ?? 0) || a.displayName.localeCompare(b.displayName))
    .slice(0, clampLimit(limit, 50));
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
  return [...map.values()].filter((row) => row.appCount > 0).sort((a, b) => b.appCount - a.appCount || a.slug.localeCompare(b.slug));
}

export function appsInCategory(agg: Aggregate, slug: CategorySlug, limit?: number): AppSummary[] {
  return agg.apps
    .filter((app) => app.category === slug)
    .sort((a, b) => (b.useCount ?? -1) - (a.useCount ?? -1) || (b.stars ?? -1) - (a.stars ?? -1) || a.id.localeCompare(b.id))
    .slice(0, clampLimit(limit, 50));
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
    return { date, appCount, useCount, stars };
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
  return scored.slice(0, clampLimit(limit, 8));
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
    competitors: competitors(agg, app.id, 6),
  };
}

export function metricLabel(metric: MetricKey): string {
  return METRIC_LABELS[metric];
}
