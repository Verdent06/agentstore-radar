import {
  appDetail,
  appsInCategory,
  categories,
  categoryTrends,
  competitors,
  growthWindow,
  homeLeaders,
  metricLabel,
  movers,
  multiStoreApps,
  newArrivals,
  publicAnswerShare,
  rankHistory,
  searchApps,
  topChart,
} from "./query.ts";
import { PUBLIC_DEFAULT_LIMIT, PUBLIC_TOP_N, growthBucket, roundCount } from "./public.ts";
import { CHART_IDS, CATEGORY_SLUGS, METRIC_KEYS, type Aggregate, type CategorySlug, type ChartId, type MetricKey } from "./types.ts";

export const TOOL_NAMES = [
  "search_apps",
  "app_details",
  "rank_history",
  "top_charts",
  "movers",
  "competitors",
  "category_trends",
  "multi_store",
  "answer_share",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

function asChart(value: string | undefined): ChartId {
  if (value && (CHART_IDS as readonly string[]).includes(value)) {
    return value as ChartId;
  }
  return "smithery";
}

/** Missing metric defaults to npm downloads. Unknown names are rejected. */
function asMetric(value: string | undefined): MetricKey | { error: string } {
  if (value == null || value === "") {
    return "npm_weekly_downloads";
  }
  if ((METRIC_KEYS as readonly string[]).includes(value)) {
    return value as MetricKey;
  }
  return { error: `unknown metric: ${value}` };
}

function asCategory(value: string | undefined): CategorySlug | undefined {
  if (value && (CATEGORY_SLUGS as readonly string[]).includes(value)) {
    return value as CategorySlug;
  }
  return undefined;
}

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function runTool(
  agg: Aggregate,
  name: ToolName,
  args: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  switch (name) {
    case "search_apps": {
      const query = String(args.query ?? args.q ?? "");
      const rows = searchApps(agg, query, {
        category: asCategory(typeof args.category === "string" ? args.category : undefined),
        limit: typeof args.limit === "number" ? args.limit : PUBLIC_DEFAULT_LIMIT,
      });
      return jsonResult({
        query,
        count: rows.length,
        apps: rows.map((app) => ({
          id: app.id,
          name: app.displayName,
          category: app.category,
          stores: app.stores,
          stars: app.stars,
          description: app.description,
        })),
      });
    }
    case "app_details": {
      const id = String(args.app_id ?? args.id ?? "");
      const detail = appDetail(agg, id);
      if (!detail) {
        return jsonResult({ error: `unknown app_id: ${id}` });
      }
      return jsonResult(detail);
    }
    case "rank_history": {
      const id = String(args.app_id ?? args.id ?? "");
      const metric = asMetric(typeof args.metric === "string" ? args.metric : undefined);
      if (typeof metric !== "string") {
        return jsonResult(metric);
      }
      return jsonResult({
        app_id: id,
        metric,
        label: metricLabel(metric),
        points: rankHistory(agg, id, metric),
      });
    }
    case "top_charts": {
      const chart = asChart(typeof args.chart === "string" ? args.chart : undefined);
      const limit = typeof args.limit === "number" ? args.limit : PUBLIC_DEFAULT_LIMIT;
      return jsonResult({
        chart,
        rows: topChart(agg, chart, limit).map((row) => ({
          rank: row.rank,
          previousRank: row.previousRank,
          id: row.app.id,
          name: row.app.displayName,
          category: row.app.category,
          value: roundCount(row.value),
          growth:
            row.previousValue == null || row.previousValue === 0
              ? null
              : growthBucket((row.value - row.previousValue) / row.previousValue),
        })),
      });
    }
    case "movers": {
      const window = args.window === "7d" ? "7d" : "1d";
      let metric: MetricKey | undefined;
      if (typeof args.metric === "string") {
        const parsed = asMetric(args.metric);
        if (typeof parsed !== "string") {
          return jsonResult(parsed);
        }
        metric = parsed;
      }
      const ends = growthWindow(agg, window);
      return jsonResult({
        window,
        from: ends?.fromDate ?? null,
        to: ends?.toDate ?? null,
        partialDates: agg.meta.partialDates ?? [],
        rows: movers(agg, { window, metric, limit: typeof args.limit === "number" ? args.limit : PUBLIC_DEFAULT_LIMIT }),
      });
    }
    case "competitors": {
      const id = String(args.app_id ?? args.id ?? "");
      return jsonResult({
        app_id: id,
        rows: competitors(agg, id, typeof args.limit === "number" ? args.limit : PUBLIC_DEFAULT_LIMIT).map((row) => ({
          id: row.id,
          name: row.displayName,
          category: row.category,
          score: roundCount(row.score),
          stars: row.stars,
          description: row.description,
        })),
      });
    }
    case "category_trends": {
      const slug = asCategory(typeof args.category === "string" ? args.category : undefined);
      return jsonResult({
        category: slug ?? "all",
        categories: slug ? undefined : categories(agg),
        apps: slug ? appsInCategory(agg, slug, PUBLIC_TOP_N).map((app) => ({ id: app.id, name: app.displayName, stars: app.stars })) : undefined,
        points: categoryTrends(agg, slug),
      });
    }
    case "answer_share": {
      return jsonResult(
        publicAnswerShare(agg, {
          provider: typeof args.provider === "string" ? args.provider : undefined,
          limit: typeof args.limit === "number" ? args.limit : PUBLIC_DEFAULT_LIMIT,
        }),
      );
    }
    case "multi_store": {
      const newest = Boolean(args.new_arrivals);
      const rows = newest
        ? newArrivals(agg, typeof args.limit === "number" ? args.limit : PUBLIC_DEFAULT_LIMIT)
        : multiStoreApps(agg, typeof args.limit === "number" ? args.limit : PUBLIC_DEFAULT_LIMIT);
      return jsonResult({
        kind: newest ? "new_arrivals" : "multi_store",
        rows: rows.map((app) => ({
          id: app.id,
          name: app.displayName,
          stores: app.stores,
          category: app.category,
          firstSeen: app.firstSeen,
          stars: app.stars,
        })),
        homeLeaders: homeLeaders(agg, PUBLIC_DEFAULT_LIMIT).map((row) => ({
          id: row.app.id,
          name: row.app.displayName,
          value: roundCount(row.value),
          growth:
            row.previousValue == null || row.previousValue === 0 || row.delta == null
              ? null
              : growthBucket(row.delta / row.previousValue),
        })),
      });
    }
    default: {
      const _never: never = name;
      return jsonResult({ error: `unknown tool ${_never}` });
    }
  }
}
