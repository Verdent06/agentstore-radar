import { addUtcDays } from "../lib/dates.ts";
import type { Aggregate, AppSummary, CompactSeries, HeadlineStats } from "./types.ts";

/** Last N complete snapshot days kept on the public aggregate (partials in that span stay as gaps). */
export const HISTORY_CAP_DAYS = 14;

/** Top-N for every public list (charts, movers per side, search, home, MCP max). */
export const PUBLIC_TOP_N = 10;

/** MCP tools default to 5; every public limit is capped at PUBLIC_TOP_N. */
export const PUBLIC_DEFAULT_LIMIT = 5;

export const PUBLIC_MAX_LIMIT = PUBLIC_TOP_N;

export const MOVERS_PER_SIDE = 5;

export const COMPETITORS_CAP = 5;

const GROWTH_EDGES: Array<{ max: number; label: string }> = [
  { max: 0.01, label: "<1%" },
  { max: 0.05, label: "1–5%" },
  { max: 0.1, label: "5–10%" },
  { max: 0.25, label: "10–25%" },
  { max: 0.5, label: "25–50%" },
  { max: 1, label: "50–100%" },
];

/** Earliest snapshot date kept when `latest` is the newest day (inclusive 14-day window). */
export function historyCutoffDate(latest: string, capDays = HISTORY_CAP_DAYS): string {
  return addUtcDays(latest, -(capDays - 1));
}

/** Inclusive bounds of the public history window: last `capDays` complete snapshot dates. */
export function completeHistoryBounds(
  agg: Pick<Aggregate, "meta">,
  capDays = HISTORY_CAP_DAYS,
): { fromDate: string; toDate: string } | null {
  const complete = completeSnapshotDates(agg);
  const toDate = complete.at(-1);
  if (!toDate) {
    return null;
  }
  return { fromDate: complete.at(-capDays) ?? complete[0]!, toDate };
}

/** Round to 2 significant figures (12,345 → 12,000; 987 → 990). */
export function round2sf(value: number): number {
  if (value === 0 || !Number.isFinite(value)) {
    return value;
  }
  const sign = Math.sign(value);
  const abs = Math.abs(value);
  const exp = Math.floor(Math.log10(abs));
  const factor = 10 ** (exp - 1);
  return sign * Math.round(abs / factor) * factor;
}

export function roundCount(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  return round2sf(value);
}

/**
 * Map a fraction (0.05 = 5%) to a public growth bucket.
 * Negative values use the same buckets with a minus prefix.
 */
export function growthBucket(pct: number | null | undefined): string | null {
  if (pct == null || !Number.isFinite(pct)) {
    return null;
  }
  const abs = Math.abs(pct);
  let label = ">100%";
  for (const edge of GROWTH_EDGES) {
    if (abs < edge.max) {
      label = edge.label;
      break;
    }
  }
  if (abs >= 1) {
    label = ">100%";
  }
  return pct < 0 ? `−${label}` : label;
}

export function isPartialDate(agg: Pick<Aggregate, "meta">, date: string | null | undefined): boolean {
  if (!date) {
    return false;
  }
  return (agg.meta.partialDates ?? []).includes(date);
}

export function completeSnapshotDates(agg: Pick<Aggregate, "meta">): string[] {
  const partial = new Set(agg.meta.partialDates ?? []);
  return agg.meta.snapshotDates.filter((date) => !partial.has(date));
}

export function roundAppMetrics(app: AppSummary): AppSummary {
  const { useCount: _useCount, ...rest } = app as AppSummary & { useCount?: unknown };
  return {
    ...rest,
    stars: roundCount(rest.stars),
    forks: roundCount(rest.forks),
    openIssues: roundCount(rest.openIssues),
    npmWeeklyDownloads: roundCount(rest.npmWeeklyDownloads),
    pypiLastWeekDownloads: roundCount(rest.pypiLastWeekDownloads),
    geminiStars: roundCount(rest.geminiStars),
  };
}

export function roundSeries(series: CompactSeries): CompactSeries {
  const roundColumn = (column: Array<number | null> | undefined): Array<number | null> | undefined =>
    column?.map((value) => roundCount(value));
  const { u: _u, uc: _uc, ...rest } = series as CompactSeries & { u?: unknown; uc?: unknown };
  const next: CompactSeries = {
    s: roundColumn(rest.s),
    n: roundColumn(rest.n),
    p: roundColumn(rest.p),
    g: roundColumn(rest.g),
    sc: rest.sc,
    nc: rest.nc,
    pc: rest.pc,
    ss: rest.ss,
  };
  const pruneValues = (key: "s" | "n" | "p" | "g") => {
    if (next[key]?.every((value) => value == null)) {
      delete next[key];
    }
  };
  const pruneFlags = (key: "sc" | "nc" | "pc") => {
    if (next[key]?.every((value) => value == null || value === 0)) {
      delete next[key];
    }
  };
  pruneValues("s");
  pruneValues("n");
  pruneValues("p");
  pruneValues("g");
  pruneFlags("sc");
  pruneFlags("nc");
  pruneFlags("pc");
  if (next.ss?.every((value) => value == null)) {
    delete next.ss;
  }
  return next;
}

export function roundHeadlineStats(stats: HeadlineStats): HeadlineStats {
  return {
    ...stats,
    appCount: round2sf(stats.appCount),
    totalStars: round2sf(stats.totalStars),
    totalNpmWeekly: round2sf(stats.totalNpmWeekly),
    multiStoreCount: round2sf(stats.multiStoreCount),
    newArrivalCount: round2sf(stats.newArrivalCount),
    categoryCount: round2sf(stats.categoryCount),
    starsFreshCount: round2sf(stats.starsFreshCount),
    npmFreshCount: round2sf(stats.npmFreshCount),
    pypiFreshCount: round2sf(stats.pypiFreshCount),
  };
}
