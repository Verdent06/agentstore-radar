import { normalizeNpmPoint } from "../adapters/npm.ts";
import { normalizePypiRecent } from "../adapters/pypi.ts";
import { listSnapshotDates, readSourceRows } from "./io.ts";
import { loadCheckpoint, loadEntityCache, loadLastFetched } from "./rolling.ts";
import { emptySourceRow, type SourceName, type SourceRow } from "./schema.ts";

function freezeForward(row: SourceRow, snapshotDate: string): SourceRow {
  return {
    ...row,
    snapshot_date: snapshotDate,
    carried_forward: true,
    frozen: true,
  };
}

function priorSnapshotRows(dataDir: string, source: SourceName, snapshotDate: string): SourceRow[] {
  const earlier = listSnapshotDates(dataDir).filter((date) => date < snapshotDate).reverse();
  for (const date of [snapshotDate, ...earlier]) {
    try {
      const rows = readSourceRows(date, dataDir).filter((row) => row.source === source);
      if (rows.length > 0) {
        return rows.map((row) => freezeForward(row, snapshotDate));
      }
    } catch {
      // That day has no readable source rows.
    }
  }
  return [];
}

function rowsFromNpmCache(dataDir: string, snapshotDate: string): SourceRow[] {
  const cache = loadEntityCache(dataDir, "npm");
  const checkpoint = loadCheckpoint(dataDir, "npm");
  const keys = checkpoint?.dueKeys?.length ? checkpoint.dueKeys : Object.keys(cache);
  const rows: SourceRow[] = [];
  for (const name of keys) {
    const row = normalizeNpmPoint(snapshotDate, name, cache[name]);
    if (row) {
      rows.push(freezeForward(row, snapshotDate));
    }
  }
  return rows;
}

function rowsFromPypiCache(dataDir: string, snapshotDate: string): SourceRow[] {
  const cache = loadEntityCache(dataDir, "pypi");
  const checkpoint = loadCheckpoint(dataDir, "pypi");
  const keys = checkpoint?.dueKeys?.length ? checkpoint.dueKeys : Object.keys(cache);
  const rows: SourceRow[] = [];
  for (const name of keys) {
    const row = normalizePypiRecent(snapshotDate, name, cache[name]);
    if (row) {
      rows.push(freezeForward(row, snapshotDate));
    }
  }
  return rows;
}

function rowsFromIdCache(dataDir: string, source: SourceName, snapshotDate: string): SourceRow[] {
  const cache = loadEntityCache<Record<string, unknown>>(dataDir, source);
  const lastFetched = loadLastFetched(dataDir, source);
  const checkpoint = loadCheckpoint(dataDir, source);
  const keys = checkpoint?.dueKeys?.length
    ? checkpoint.dueKeys
    : [...new Set([...Object.keys(cache), ...Object.keys(lastFetched)])];
  return keys.map((sourceId) =>
    freezeForward(
      emptySourceRow({
        snapshot_date: snapshotDate,
        source,
        source_id: sourceId,
        name: sourceId,
        app_id: `${source}:${sourceId}`,
        fetched_at: lastFetched[sourceId] ?? null,
      }),
      snapshotDate,
    ),
  );
}

/** Rows to keep when collect aborts at the source budget before the adapter returns. */
export function budgetPartialRows(dataDir: string, source: SourceName, snapshotDate: string): SourceRow[] {
  const prior = priorSnapshotRows(dataDir, source, snapshotDate);
  const cached =
    source === "npm"
      ? rowsFromNpmCache(dataDir, snapshotDate)
      : source === "pypi"
        ? rowsFromPypiCache(dataDir, snapshotDate)
        : rowsFromIdCache(dataDir, source, snapshotDate);
  if (prior.length === 0) {
    return cached;
  }
  const seen = new Set(prior.map((row) => row.source_id));
  return [...prior, ...cached.filter((row) => !seen.has(row.source_id))];
}
