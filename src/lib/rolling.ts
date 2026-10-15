import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
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
