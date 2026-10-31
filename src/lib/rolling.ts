import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./io.ts";

export const DEFAULT_REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type LastFetchedMap = Record<string, string>;
export type EntityCache<T = unknown> = Record<string, T>;

export type Checkpoint = {
  snapshotDate: string;
  dueKeys: string[];
  nextIndex: number;
  startedAt: string;
};

export function isStale(fetchedAt: string | undefined, now: Date, maxAgeMs = DEFAULT_REFRESH_MAX_AGE_MS): boolean {
  if (!fetchedAt) {
    return true;
  }
  const ts = Date.parse(fetchedAt);
  if (Number.isNaN(ts)) {
    return true;
  }
  return ts < now.getTime() - maxAgeMs;
}

/** Keys not fetched on this UTC snapshot date. Same-day cache hits are not due. */
export function selectDailyDueKeys(allKeys: string[], lastFetched: LastFetchedMap, snapshotDate: string): string[] {
  return allKeys.filter((key) => isCarriedForward(lastFetched[key], snapshotDate));
}

export function countFreshToday(allKeys: string[], lastFetched: LastFetchedMap, snapshotDate: string): number {
  return allKeys.length - selectDailyDueKeys(allKeys, lastFetched, snapshotDate).length;
}

export function prioritizeKeys(keys: string[], scoreOf: (key: string) => number): string[] {
  return keys
    .map((key, index) => ({ key, index, score: scoreOf(key) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.key);
}

function fetchedAtMs(lastFetched: LastFetchedMap, key: string): number {
  const raw = lastFetched[key];
  if (!raw) {
    return 0;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Oldest last_fetched first (missing first). Equal timestamps keep a higher score ahead. */
export function prioritizeStalestFirst(
  keys: string[],
  lastFetched: LastFetchedMap,
  scoreOf?: (key: string) => number,
): string[] {
  return keys
    .map((key, index) => ({
      key,
      index,
      fetchedAt: fetchedAtMs(lastFetched, key),
      score: scoreOf?.(key) ?? 0,
    }))
    .sort((a, b) => a.fetchedAt - b.fetchedAt || b.score - a.score || a.index - b.index)
    .map((row) => row.key);
}

export function takeRunBatch(keys: string[], limit: number): string[] {
  if (!Number.isFinite(limit) || limit <= 0) {
    return keys;
  }
  return keys.slice(0, Math.floor(limit));
}

export function selectRunBatch(
  dueKeys: string[],
  lastFetched: LastFetchedMap,
  limit: number,
  scoreOf?: (key: string) => number,
): string[] {
  return takeRunBatch(prioritizeStalestFirst(dueKeys, lastFetched, scoreOf), limit);
}

/** True when the stored value was not fetched for this snapshot day (and is not this run's live fetch). */
export function isCarriedForward(
  lastFetchedAt: string | null | undefined,
  snapshotDate: string,
  collectedAt?: string,
): boolean {
  if (!lastFetchedAt) {
    return true;
  }
  if (collectedAt && lastFetchedAt === collectedAt) {
    return false;
  }
  return lastFetchedAt.slice(0, 10) !== snapshotDate;
}

export function selectDueKeys(
  allKeys: string[],
  lastFetched: LastFetchedMap,
  now: Date,
  maxAgeMs = DEFAULT_REFRESH_MAX_AGE_MS,
): string[] {
  return allKeys.filter((key) => isStale(lastFetched[key], now, maxAgeMs));
}

export function countFresh(
  allKeys: string[],
  lastFetched: LastFetchedMap,
  now: Date,
  maxAgeMs = DEFAULT_REFRESH_MAX_AGE_MS,
): number {
  return allKeys.length - selectDueKeys(allKeys, lastFetched, now, maxAgeMs).length;
}

export function mergeLastFetched(previous: LastFetchedMap, fetchedKeys: string[], fetchedAt: string): LastFetchedMap {
  const next = { ...previous };
  for (const key of fetchedKeys) {
    next[key] = fetchedAt;
  }
  return next;
}

export function resumeDueKeys(
  allKeys: string[],
  lastFetched: LastFetchedMap,
  now: Date,
  snapshotDate: string,
  checkpoint: Checkpoint | null,
  maxAgeMs = DEFAULT_REFRESH_MAX_AGE_MS,
): { dueKeys: string[]; resumed: boolean } {
  const due = selectDueKeys(allKeys, lastFetched, now, maxAgeMs);
  return resumeFromCheckpoint(due, snapshotDate, checkpoint);
}

export function resumeDailyDueKeys(
  allKeys: string[],
  lastFetched: LastFetchedMap,
  snapshotDate: string,
  checkpoint: Checkpoint | null,
): { dueKeys: string[]; resumed: boolean } {
  const due = selectDailyDueKeys(allKeys, lastFetched, snapshotDate);
  return resumeFromCheckpoint(due, snapshotDate, checkpoint);
}

function resumeFromCheckpoint(
  due: string[],
  snapshotDate: string,
  checkpoint: Checkpoint | null,
): { dueKeys: string[]; resumed: boolean } {
  if (!checkpoint || checkpoint.snapshotDate !== snapshotDate) {
    return { dueKeys: due, resumed: false };
  }
  const stillDue = new Set(due);
  const remaining = checkpoint.dueKeys.slice(Math.max(0, checkpoint.nextIndex)).filter((key) => stillDue.has(key));
  const seen = new Set(checkpoint.dueKeys);
  const extra = due.filter((key) => !seen.has(key));
  return { dueKeys: [...remaining, ...extra], resumed: true };
}

export function stateDir(dataDir: string, sourceId: string): string {
  return join(dataDir, "state", sourceId);
}

function lastFetchedPath(dataDir: string, sourceId: string): string {
  return join(stateDir(dataDir, sourceId), "last_fetched.json");
}

function cachePath(dataDir: string, sourceId: string): string {
  return join(stateDir(dataDir, sourceId), "cache.json");
}

function checkpointPath(dataDir: string, sourceId: string): string {
  return join(stateDir(dataDir, sourceId), "checkpoint.json");
}

function unresolvedPath(dataDir: string, sourceId: string): string {
  return join(stateDir(dataDir, sourceId), "unresolved.json");
}

export function loadJsonState<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function persistJsonState(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value)}\n`);
}

export function clearStateFile(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function loadLastFetched(dataDir: string, sourceId: string): LastFetchedMap {
  const value = loadJsonState<LastFetchedMap>(lastFetchedPath(dataDir, sourceId), {});
  return value && typeof value === "object" ? value : {};
}

export function persistLastFetched(dataDir: string, sourceId: string, lastFetched: LastFetchedMap): void {
  persistJsonState(lastFetchedPath(dataDir, sourceId), lastFetched);
}

export function loadEntityCache<T = unknown>(dataDir: string, sourceId: string): EntityCache<T> {
  const value = loadJsonState<EntityCache<T>>(cachePath(dataDir, sourceId), {});
  return value && typeof value === "object" ? value : {};
}

export function persistEntityCache<T>(dataDir: string, sourceId: string, cache: EntityCache<T>): void {
  persistJsonState(cachePath(dataDir, sourceId), cache);
}

export function loadCheckpoint(dataDir: string, sourceId: string): Checkpoint | null {
  const value = loadJsonState<Checkpoint | null>(checkpointPath(dataDir, sourceId), null);
  if (!value || typeof value !== "object" || !Array.isArray(value.dueKeys)) {
    return null;
  }
  return value;
}

export function persistCheckpoint(dataDir: string, sourceId: string, checkpoint: Checkpoint): void {
  persistJsonState(checkpointPath(dataDir, sourceId), checkpoint);
}

export function clearCheckpoint(dataDir: string, sourceId: string): void {
  clearStateFile(checkpointPath(dataDir, sourceId));
}

/** Map of unresolved GitHub keys → when we last confirmed NOT_FOUND. */
export type UnresolvedMap = Record<string, string>;

export function loadUnresolved(dataDir: string, sourceId: string): UnresolvedMap {
  const value = loadJsonState<UnresolvedMap | string[]>(unresolvedPath(dataDir, sourceId), {});
  if (Array.isArray(value)) {
    return Object.fromEntries(value.filter((key) => typeof key === "string").map((key) => [key, ""]));
  }
  return value && typeof value === "object" ? value : {};
}

export function persistUnresolved(dataDir: string, sourceId: string, unresolved: UnresolvedMap): void {
  persistJsonState(unresolvedPath(dataDir, sourceId), unresolved);
}

/** Known-unresolved keys stay out of the daily batch unless the last check is stale. */
export function isDueUnresolved(checkedAt: string | undefined, now: Date, maxAgeMs = DEFAULT_REFRESH_MAX_AGE_MS): boolean {
  if (!checkedAt) {
    return true;
  }
  return isStale(checkedAt, now, maxAgeMs);
}
