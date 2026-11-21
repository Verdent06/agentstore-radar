import { isFreshRow } from "./coverage.ts";
import type { LastFetchedMap } from "./rolling.ts";
import { prioritizeStalestFirst } from "./rolling.ts";
import type { SourceManifest, SourceName, SourceRow } from "./schema.ts";

/**
 * Minimum share of yesterday's ids that must get a fresh row today.
 * Fresh means `carried_forward !== true` and `frozen !== true`.
 */
export const REFETCH_EXISTING_MIN_SHARE = 0.9;

/** Sources that record existing/refetched counts. A/B need a popularity field. */
export const REFETCH_COUNT_SOURCES = ["github", "npm", "mcp-registry"] as const;

export type RefetchCountSource = (typeof REFETCH_COUNT_SOURCES)[number];

const POPULARITY_FIELD: Partial<Record<RefetchCountSource, "stars" | "npm_weekly_downloads">> = {
  github: "stars",
  npm: "npm_weekly_downloads",
};

export type RefetchStats = {
  existingRows: number;
  refetchedExisting: number;
  refetchedExistingShare: number;
  /** A: popularity changed vs the previous snapshot, but the row is not fresh. */
  mismatchChangedNotFresh?: number;
  /** B: row is fresh, but the popularity value is unchanged. */
  mismatchFreshUnchanged?: number;
};

export type ExistingRefetchPlan = {
  /** Fetch order: stalest existing floor, then new ids, then the remaining existing. */
  keys: string[];
  newKeys: string[];
  existingKeys: string[];
  existingTarget: number;
};

export function isRefetchCountSource(source: string): source is RefetchCountSource {
  return (REFETCH_COUNT_SOURCES as readonly string[]).includes(source);
}

export function meetsRefetchedExistingCoverage(
  share: number,
  minShare = REFETCH_EXISTING_MIN_SHARE,
): boolean {
  return share >= minShare;
}

function takeUpTo(keys: string[], limit: number): string[] {
  if (!Number.isFinite(limit) || limit <= 0) {
    return [];
  }
  return keys.slice(0, Math.floor(limit));
}

/**
 * Split due keys into never-observed ids and existing rows, then order the
 * batch so a cap cannot be filled by new ids alone.
 *
 * On 2026-11-01 `prioritizeStalestFirst` treated a missing `last_fetched` as
 * the oldest timestamp. Unresolved repos are not stamped, so they sorted with
 * brand-new ids. `GITHUB_RUN_BATCH` was 4,000 and that whole batch was 3,773
 * NOT_FOUND aliases plus 227 new repos (`truncated: false`), so every existing
 * repo was carried forward. The floor below is the stalest existing keys and
 * is kept even when `limit` is smaller than the floor plus new ids.
 */
export function planExistingRefetch(
  dueKeys: readonly string[],
  lastFetched: LastFetchedMap,
  limit: number,
  options?: {
    hasPrior?: (key: string) => boolean;
    scoreOf?: (key: string) => number;
    minShare?: number;
  },
): ExistingRefetchPlan {
  const minShare = options?.minShare ?? REFETCH_EXISTING_MIN_SHARE;
  const hasPrior = options?.hasPrior ?? ((key: string) => Boolean(lastFetched[key]));
  const existing: string[] = [];
  const newKeys: string[] = [];
  for (const key of dueKeys) {
    if (hasPrior(key)) {
      existing.push(key);
    } else {
      newKeys.push(key);
    }
  }
  const existingKeys = prioritizeStalestFirst(existing, lastFetched, options?.scoreOf);
  const existingTarget = Math.ceil(existingKeys.length * minShare);
  const floor = existingKeys.slice(0, existingTarget);
  const rest = existingKeys.slice(existingTarget);
  const protectedCount = floor.length + newKeys.length;
  const restTaken = limit >= protectedCount ? takeUpTo(rest, limit - protectedCount) : [];
  return {
    keys: [...floor, ...newKeys, ...restTaken],
    newKeys,
    existingKeys,
    existingTarget,
  };
}

function metricValue(row: SourceRow, field: "stars" | "npm_weekly_downloads"): number | null {
  const value = row[field];
  return typeof value === "number" ? value : null;
}

function rowsById(rows: readonly SourceRow[], source: SourceName): Map<string, SourceRow> {
  const byId = new Map<string, SourceRow>();
  for (const row of rows) {
    if (row.source === source) {
      byId.set(row.source_id, row);
    }
  }
  return byId;
}

/** `existingRows === 0` (first snapshot) scores 1 so the check does not fail an empty baseline. */
export function refetchedExistingShare(refetchedExisting: number, existingRows: number): number {
  if (existingRows <= 0) {
    return 1;
  }
  return refetchedExisting / existingRows;
}

export function computeRefetchStats(
  source: SourceName,
  previous: readonly SourceRow[],
  current: readonly SourceRow[],
): RefetchStats | undefined {
  if (!isRefetchCountSource(source)) {
    return undefined;
  }
  const prior = rowsById(previous, source);
  const today = rowsById(current, source);
  let existingRows = 0;
  let refetchedExisting = 0;
  let mismatchChangedNotFresh = 0;
  let mismatchFreshUnchanged = 0;
  const field = POPULARITY_FIELD[source];
  for (const [id, previousRow] of prior) {
    const currentRow = today.get(id);
    // Dropped ids are not today's rows. Existing means the id is in both snapshots.
    if (!currentRow) {
      continue;
    }
    existingRows += 1;
    const fresh = isFreshRow(currentRow);
    if (fresh) {
      refetchedExisting += 1;
    }
    if (!field) {
      continue;
    }
    const changed = metricValue(previousRow, field) !== metricValue(currentRow, field);
    if (changed && !fresh) {
      mismatchChangedNotFresh += 1;
    } else if (!changed && fresh) {
      mismatchFreshUnchanged += 1;
    }
  }
  const stats: RefetchStats = {
    existingRows,
    refetchedExisting,
    refetchedExistingShare: refetchedExistingShare(refetchedExisting, existingRows),
  };
  if (field) {
    stats.mismatchChangedNotFresh = mismatchChangedNotFresh;
    stats.mismatchFreshUnchanged = mismatchFreshUnchanged;
  }
  return stats;
}

export function withRefetchStats(
  manifest: SourceManifest,
  currentRows: readonly SourceRow[],
  previousRows: readonly SourceRow[],
): SourceManifest {
  const stats = computeRefetchStats(manifest.source, previousRows, currentRows);
  if (!stats) {
    return manifest;
  }
  return {
    ...manifest,
    existingRows: stats.existingRows,
    refetchedExisting: stats.refetchedExisting,
    refetchedExistingShare: stats.refetchedExistingShare,
    ...(stats.mismatchChangedNotFresh != null
      ? {
          mismatchChangedNotFresh: stats.mismatchChangedNotFresh,
          mismatchFreshUnchanged: stats.mismatchFreshUnchanged,
        }
      : {}),
  };
}

function formatShare(share: number): string {
  return share.toFixed(3);
}

function checkLabel(share: number): string {
  return meetsRefetchedExistingCoverage(share) ? "pass" : "fail";
}

/** Markdown block for `GITHUB_STEP_SUMMARY`. */
export function formatRefetchStepSummary(snapshotDate: string, sources: readonly SourceManifest[]): string {
  const tracked = sources.filter((source) => isRefetchCountSource(source.source) && source.existingRows != null);
  const lines = [
    `### Refetch coverage ${snapshotDate}`,
    "",
    "Fresh means `carried_forward` is not true and `frozen` is not true. `refetchedExistingShare` is refetched existing ids divided by existing ids (1 when there is no previous row). The check passes at >=0.9. mcp-registry has no popularity metric, so A/B are omitted.",
    "",
    "| source | existingRows | refetchedExisting | refetchedExistingShare | mismatchChangedNotFresh (A) | mismatchFreshUnchanged (B) | >=0.9 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  if (tracked.length === 0) {
    lines.push("| (none) |  |  |  |  |  |  |");
  }
  for (const source of tracked) {
    const share = source.refetchedExistingShare ?? 0;
    const changed = source.mismatchChangedNotFresh != null ? String(source.mismatchChangedNotFresh) : "";
    const unchanged = source.mismatchFreshUnchanged != null ? String(source.mismatchFreshUnchanged) : "";
    lines.push(
      `| ${source.source} | ${source.existingRows ?? 0} | ${source.refetchedExisting ?? 0} | ${formatShare(share)} | ${changed} | ${unchanged} | ${checkLabel(share)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
