import { SOURCE_FREEZE_RATIO } from "./config.ts";
import { listSnapshotDates, readSourceRows } from "./io.ts";
import type { SourceName, SourceRow } from "./schema.ts";

export type MetricObservation = {
  date: string;
  value: number | null;
  fetchedAt?: string | null;
};

export type NumericSourceField = {
  [K in keyof SourceRow]: SourceRow[K] extends number | null ? K : never;
}[keyof SourceRow];

export type SourceFreezeDecision = {
  sourceFrozen: boolean;
  freezeRow: boolean[];
  unchangedCount: number;
  catalogSize: number;
  ratio: number;
};

export function smitheryFrozenDays(env: NodeJS.ProcessEnv = process.env, fallback = 3): number {
  const raw = env.SMITHERY_FROZEN_DAYS?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * True when `current` matches the value on the previous snapshot dates
 * going backward until `minDays` observations (including today). Missing
 * snapshot days are skipped, never invented — a gap such as 2026-10-23
 * does not pad the streak.
 */
export function isUnchangedForDays(
  current: number | null | undefined,
  history: MetricObservation[],
  previousSnapshotDates: string[],
  minDays = 3,
): boolean {
  if (typeof current !== "number" || minDays < 1) {
    return false;
  }
  if (minDays === 1) {
    return true;
  }
  const byDate = new Map(history.map((row) => [row.date, row.value]));
  let streak = 1;
  for (let index = previousSnapshotDates.length - 1; index >= 0; index -= 1) {
    const date = previousSnapshotDates[index];
    if (date == null || byDate.get(date) !== current) {
      break;
    }
    streak += 1;
    if (streak >= minDays) {
      return true;
    }
  }
  return streak >= minDays;
}

/**
 * Source-level freeze: when `>= ratio` of the catalog is unchanged for N days,
 * those unchanged rows are frozen. Otherwise N-day freeze is not applied
 * per-row, so genuinely flat/zero servers are not stuck frozen after a thaw.
 */
export function evaluateSourceFreeze(
  unchangedForNDays: boolean[],
  ratio = SOURCE_FREEZE_RATIO,
): SourceFreezeDecision {
  const catalogSize = unchangedForNDays.length;
  const unchangedCount = unchangedForNDays.filter(Boolean).length;
  const sourceFrozen = catalogSize > 0 && unchangedCount / catalogSize >= ratio;
  return {
    sourceFrozen,
    freezeRow: unchangedForNDays.map((unchanged) => sourceFrozen && unchanged),
    unchangedCount,
    catalogSize,
    ratio,
  };
}

export function loadPreviousMetricHistory(
  dataDir: string,
  snapshotDate: string,
  source: SourceName,
  field: NumericSourceField,
  limit = 3,
): { dates: string[]; byId: Map<string, MetricObservation[]> } {
  const dates = listSnapshotDates(dataDir)
    .filter((date) => date < snapshotDate)
    .slice(-Math.max(0, limit));
  const byId = new Map<string, MetricObservation[]>();
  for (const date of dates) {
    for (const row of readSourceRows(date, dataDir)) {
      if (row.source !== source) {
        continue;
      }
      const raw = row[field];
      const list = byId.get(row.source_id) ?? [];
      list.push({
        date,
        value: typeof raw === "number" ? raw : null,
        fetchedAt: row.fetched_at ?? null,
      });
      byId.set(row.source_id, list);
    }
  }
  return { dates, byId };
}
