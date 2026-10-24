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
import { PUBLIC_DEFAULT_LIMIT, PUBLIC_TOP_N } from "./public.ts";
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

function asMetric(value: string | undefined): MetricKey {
  if (value && (METRIC_KEYS as readonly string[]).includes(value)) {
    return value as MetricKey;
  }
  return "use_count";
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
          useCount: app.useCount,
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
          value: row.value,
          delta: row.delta,
        })),
      });
    }
    case "movers": {
      const window = args.window === "7d" ? "7d" : "1d";
      const metric = typeof args.metric === "string" ? asMetric(args.metric) : undefined;
      const ends = growthWindow(agg, window);
      return jsonResult({
        window,
        from: ends?.from ?? null,
        to: ends?.to ?? null,
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
          score: Number(row.score.toFixed(3)),
          useCount: row.useCount,
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
        apps: slug ? appsInCategory(agg, slug, PUBLIC_TOP_N).map((app) => ({ id: app.id, name: app.displayName, useCount: app.useCount, stars: app.stars })) : undefined,
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
          useCount: app.useCount,
          stars: app.stars,
        })),
        homeLeaders: homeLeaders(agg, PUBLIC_DEFAULT_LIMIT).map((row) => ({
          id: row.app.id,
          name: row.app.displayName,
          value: row.value,
          delta: row.delta,
        })),
      });
    }
    default: {
      const _never: never = name;
      return jsonResult({ error: `unknown tool ${_never}` });
    }
  }
}
