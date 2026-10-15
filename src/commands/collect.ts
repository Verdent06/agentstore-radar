import { adaptersByKind } from "../adapters/index.ts";
import { createDiscoveredRefs, type CollectContext, type SourceResult } from "../adapters/types.ts";
import { computeCoverage } from "../lib/coverage.ts";
import { utcDateString } from "../lib/dates.ts";
import { createHttpClient, type HttpClient } from "../lib/http.ts";
import { resolveDataDir, writeJsonSnapshot, writeNormalized } from "../lib/io.ts";
import { createLogger, type Logger } from "../lib/logger.ts";
import { relinkPackageAppIds } from "../lib/matching.ts";
import { mergeApps } from "../lib/merge.ts";
import type { SnapshotManifest, SourceManifest, SourceName, SourceRow } from "../lib/schema.ts";
import { SOURCE_NAMES } from "../lib/schema.ts";

export type CollectOptions = {
  date?: string;
  dataDir?: string;
  sources?: string[];
  maxPages?: number;
  env?: NodeJS.ProcessEnv;
  http?: HttpClient;
  log?: Logger;
  now?: Date;
};

function selectedNames(requested?: string[]): SourceName[] {
  if (!requested || requested.length === 0) {
    return [...SOURCE_NAMES];
  }
  const unknown = requested.filter((name) => !SOURCE_NAMES.includes(name as SourceName));
  if (unknown.length > 0) {
    throw new Error(`Unknown sources: ${unknown.join(", ")}`);
  }
  return requested as SourceName[];
}

export async function collect(options: CollectOptions = {}): Promise<SnapshotManifest> {
  const now = options.now ?? new Date();
  const snapshotDate = options.date ?? utcDateString(now);
  const today = utcDateString(now);
  const dataDir = resolveDataDir(options.dataDir, options.env);
  const log = options.log ?? createLogger();
  const http = options.http ?? createHttpClient();
  const names = new Set(selectedNames(options.sources));
  const collectedAt = now.toISOString();
  const ctx: CollectContext = {
    snapshotDate,
    collectedAt,
    dataDir,
    now,
    env: options.env ?? process.env,
    http,
    log,
    discovered: createDiscoveredRefs(),
    maxPages: options.maxPages,
  };

  const results: SourceResult[] = [];
  for (const kind of ["catalog", "enrichment"] as const) {
    for (const adapter of adaptersByKind(kind)) {
      if (!names.has(adapter.name)) {
        continue;
      }
      log.info(`collecting ${adapter.name}`);
      results.push(await adapter.collect(ctx));
    }
  }

  const sourceRows: SourceRow[] = relinkPackageAppIds(results.flatMap((result) => result.records));
  const apps = mergeApps(snapshotDate, sourceRows);
  const sourceManifests: SourceManifest[] = [];

  for (const result of results) {
    let rawFile: string | undefined;
    if (!result.skipped) {
      rawFile = await writeJsonSnapshot(result.source, snapshotDate, today, result.raw, dataDir);
      log.info(`wrote ${rawFile}`, { source: result.source, rows: result.rowCount });
    }
    sourceManifests.push(toSourceManifest(result, rawFile));
  }

  const manifest: SnapshotManifest = {
    snapshotDate,
    collectedAt,
    sources: sourceManifests,
    appCount: apps.length,
    sourceRowCount: sourceRows.length,
  };

  writeNormalized(snapshotDate, sourceRows, apps, manifest, dataDir);
  log.info("normalized snapshot written", {
    date: snapshotDate,
    apps: apps.length,
    sourceRows: sourceRows.length,
  });
  return manifest;
}

function toSourceManifest(result: SourceResult, rawFile?: string): SourceManifest {
  const eligible = result.eligibleCount ?? (result.skipped ? 0 : result.rowCount);
  const fetched = result.fetchedCount ?? (result.skipped ? 0 : result.rowCount);
  const { coverage } = computeCoverage(eligible, fetched);
  return {
    source: result.source,
    rowCount: result.rowCount,
    skipped: result.skipped,
    skipReason: result.skipReason,
    rawFile,
    collectedAt: result.collectedAt,
    eligibleCount: eligible,
    fetchedCount: fetched,
    coverage: result.skipped && eligible === 0 ? undefined : result.coverage ?? coverage,
    lastFetchedAt: result.lastFetchedAt,
  };
}
