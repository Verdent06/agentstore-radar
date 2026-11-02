import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { adaptersByKind } from "../adapters/index.ts";
import { createDiscoveredRefs, sourceStoppedAt, type CollectContext, type SourceAdapter, type SourceResult } from "../adapters/types.ts";
import { SOURCE_COLLECT_ATTEMPTS } from "../lib/config.ts";
import { computeCoverage, computeFetchedShare } from "../lib/coverage.ts";
import { utcDateString } from "../lib/dates.ts";
import { createHttpClient, type HttpClient } from "../lib/http.ts";
import {
  backupNormalizedSnapshot,
  cleanupBrokenNormalizedEntries,
  dataPaths,
  inspectSnapshot,
  readManifest,
  resolveDataDir,
  restoreNormalizedSnapshot,
  snapshotBackupStamp,
  tryGitHead,
  writeJsonSnapshot,
  writeNormalized,
} from "../lib/io.ts";
import { createLogger, type Logger } from "../lib/logger.ts";
import { linkSourceRows } from "../lib/matching.ts";
import { mergeApps } from "../lib/merge.ts";
import { retryAsync, type SleepFn } from "../lib/retry.ts";
import type { SnapshotManifest, SourceManifest, SourceName, SourceRow } from "../lib/schema.ts";
import { SOURCE_NAMES } from "../lib/schema.ts";
import { errorMessage, sleep as defaultSleep } from "../lib/util.ts";

export type CollectOptions = {
  date?: string;
  dataDir?: string;
  sources?: string[];
  maxPages?: number;
  env?: NodeJS.ProcessEnv;
  http?: HttpClient;
  log?: Logger;
  now?: Date;
  ifIncomplete?: boolean;
  force?: boolean;
  runId?: string;
  sourceAttempts?: number;
  sleep?: SleepFn;
};

export type CollectOutcome = {
  ok: boolean;
  skipped: boolean;
  skipReason?: string;
  wrote: boolean;
  manifest?: SnapshotManifest;
  failedSources: SourceName[];
  cleaned: string[];
  date: string;
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

function failedResult(source: SourceName, collectedAt: string, error: unknown): SourceResult {
  const stoppedAt = sourceStoppedAt(source, error);
  return {
    source,
    collectedAt,
    rowCount: 0,
    skipped: true,
    failed: true,
    skipReason: `collect failed: ${stoppedAt.error}`,
    error: stoppedAt.error,
    stoppedAt,
    raw: { failed: true, error: stoppedAt.error, stoppedAt },
    records: [],
    eligibleCount: 0,
    freshTodayCount: 0,
    freshWithin7dCount: 0,
    fetchedThisRunCount: 0,
  };
}

function sourceCompleted(result: SourceResult): boolean {
  return !result.failed && !result.truncated && !result.skipped;
}

function sourceIncomplete(result: SourceResult): boolean {
  return Boolean(result.failed || result.truncated);
}

async function collectAdapter(
  adapter: SourceAdapter,
  ctx: CollectContext,
  attempts: number,
  sleep: SleepFn,
): Promise<SourceResult> {
  try {
    return await retryAsync(() => adapter.collect(ctx), {
      attempts,
      sleep,
      onRetry(attempt, error, waitMs) {
        ctx.log.warn(`retrying ${adapter.name}`, {
          attempt: attempt + 1,
          waitMs,
          error: errorMessage(error),
        });
      },
    });
  } catch (error) {
    ctx.log.error(`source ${adapter.name} failed; continuing with remaining sources`, {
      error: errorMessage(error),
    });
    return failedResult(adapter.name, ctx.collectedAt, error);
  }
}

export async function collect(options: CollectOptions = {}): Promise<CollectOutcome> {
  const now = options.now ?? new Date();
  const snapshotDate = options.date ?? utcDateString(now);
  const today = utcDateString(now);
  const dataDir = resolveDataDir(options.dataDir, options.env);
  const log = options.log ?? createLogger();
  const http = options.http ?? createHttpClient();
  const sleep = options.sleep ?? defaultSleep;
  const sourceAttempts = options.sourceAttempts ?? SOURCE_COLLECT_ATTEMPTS;
  const names = new Set(selectedNames(options.sources));
  const cleaned = cleanupBrokenNormalizedEntries(dataDir);

  if (cleaned.length > 0) {
    log.warn("removed broken snapshot entries", { entries: cleaned });
  }

  const inspection = inspectSnapshot(snapshotDate, dataDir);
  if (!options.force && inspection.usable && !inspection.needsRetry) {
    log.info("snapshot already complete; refusing to overwrite", { date: snapshotDate });
    return {
      ok: true,
      skipped: true,
      skipReason: `snapshot ${snapshotDate} already complete; pass --force to overwrite`,
      wrote: false,
      manifest: inspection.hasManifest ? readManifest(snapshotDate, dataDir) : undefined,
      failedSources: [],
      cleaned,
      date: snapshotDate,
    };
  }
  if (options.ifIncomplete) {
    log.info("snapshot missing or incomplete; collecting", {
      date: snapshotDate,
      reason: inspection.reason ?? "missing",
    });
  }

  const collectedAt = now.toISOString();
  const runId = options.runId ?? envRunId(options.env);
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
    sleep,
  };

  const results: SourceResult[] = [];
  for (const kind of ["catalog", "enrichment"] as const) {
    for (const adapter of adaptersByKind(kind)) {
      if (!names.has(adapter.name)) {
        continue;
      }
      log.info(`collecting ${adapter.name}`);
      results.push(await collectAdapter(adapter, ctx, sourceAttempts, sleep));
    }
  }

  const failedSources = results.filter((result) => result.failed).map((result) => result.source);
  const incompleteSources = results.filter(sourceIncomplete).map((result) => result.source);
  const completedSources = results.filter(sourceCompleted).map((result) => result.source);
  const sourceRows: SourceRow[] = linkSourceRows(results.flatMap((result) => result.records));
  if (sourceRows.length === 0) {
    log.error("all sources failed or produced no rows; not writing an empty snapshot", {
      date: snapshotDate,
      failedSources,
    });
    return {
      ok: false,
      skipped: false,
      skipReason: failedSources.length > 0 ? `all sources failed: ${failedSources.join(", ")}` : "no source rows collected",
      wrote: false,
      failedSources,
      cleaned,
      date: snapshotDate,
    };
  }
  const apps = mergeApps(snapshotDate, sourceRows);
  const sourceManifests: SourceManifest[] = [];

  for (const result of results) {
    let rawFile: string | undefined;
    const writeRaw = result.records.length > 0 || (!result.skipped && !result.failed);
    if (writeRaw) {
      rawFile = await writeJsonSnapshot(result.source, snapshotDate, today, result.raw, dataDir);
      log.info(`wrote ${rawFile}`, { source: result.source, rows: result.rowCount });
    }
    sourceManifests.push(toSourceManifest(result, rawFile));
  }

  const partial = incompleteSources.length > 0;
  const dest = dataPaths(dataDir).normalizedDir(snapshotDate);
  let previousBackupPath: string | undefined;
  let overwrite: SnapshotManifest["overwrite"] = undefined;
  if (options.force && existsSync(dest) && statSync(dest).isDirectory()) {
    let previous: SnapshotManifest | undefined;
    if (inspection.hasManifest) {
      try {
        previous = readManifest(snapshotDate, dataDir);
      } catch {
        previous = undefined;
      }
    }
    const stamp = snapshotBackupStamp(previous?.collectedAt, previous?.runId);
    previousBackupPath = backupNormalizedSnapshot(snapshotDate, dataDir, stamp);
    const previousCommit = tryGitHead(dataDir) ?? tryGitHead(dirname(dataDir));
    const newSha = envGitSha(options.env) ?? tryGitHead(process.cwd());
    overwrite = {
      overwrittenAt: collectedAt,
      previousBackupPath,
      previousCollectedAt: previous?.collectedAt,
      previousRunId: previous?.runId,
      previousGitSha: previousCommit,
      previousCommit,
      runId,
      reason: "force overwrite of existing snapshot",
      newSha,
    };
    log.warn("force overwrite of existing snapshot; previous day kept as backup", overwrite);
  }

  const manifest: SnapshotManifest = {
    snapshotDate,
    collectedAt,
    sources: sourceManifests,
    appCount: apps.length,
    sourceRowCount: sourceRows.length,
    partial,
    completedSources,
    failedSourceCount: failedSources.length,
    runId,
    overwrite,
  };

  try {
    writeNormalized(snapshotDate, sourceRows, apps, manifest, dataDir);
  } catch (error) {
    if (previousBackupPath) {
      restoreNormalizedSnapshot(previousBackupPath, snapshotDate, dataDir);
    }
    throw error;
  }
  log.info("normalized snapshot written", {
    date: snapshotDate,
    apps: apps.length,
    sourceRows: sourceRows.length,
    failedSources,
    incompleteSources,
    completedSources,
  });
  return {
    ok: true,
    skipped: false,
    wrote: true,
    manifest,
    failedSources,
    cleaned,
    date: snapshotDate,
  };
}

function envRunId(env?: NodeJS.ProcessEnv): string | undefined {
  const value = (env ?? process.env).GITHUB_RUN_ID?.trim();
  return value && value.length > 0 ? value : undefined;
}

function envGitSha(env?: NodeJS.ProcessEnv): string | undefined {
  const value = (env ?? process.env).GITHUB_SHA?.trim();
  return value && /^[0-9a-f]{7,40}$/i.test(value) ? value : undefined;
}

function toSourceManifest(result: SourceResult, rawFile?: string): SourceManifest {
  const eligible = result.eligibleCount ?? (result.skipped ? 0 : result.rowCount);
  const freshToday = result.freshTodayCount ?? (result.skipped ? 0 : result.rowCount);
  const freshWithin7d = result.freshWithin7dCount ?? freshToday;
  const fetchedThisRun = result.fetchedThisRunCount ?? (result.skipped || result.failed ? 0 : result.rowCount);
  const unresolvedCount = result.unresolvedCount ?? 0;
  const { coverage } = computeCoverage(eligible, freshToday);
  const fetchedShare = result.fetchedShare ?? computeFetchedShare(fetchedThisRun, eligible, unresolvedCount);
  return {
    source: result.source,
    rowCount: result.rowCount,
    skipped: result.skipped,
    skipReason: result.skipReason,
    rawFile,
    collectedAt: result.collectedAt,
    eligibleCount: eligible,
    freshTodayCount: freshToday,
    freshWithin7dCount: freshWithin7d,
    fetchedThisRunCount: fetchedThisRun,
    fetchedShare: result.skipped && eligible === 0 ? undefined : fetchedShare,
    coverage: result.skipped && eligible === 0 ? undefined : result.coverage ?? coverage,
    lastFetchedAt: result.lastFetchedAt,
    unresolvedCount: result.unresolvedCount,
    unresolvedRepos: result.unresolvedRepos,
    failed: result.failed,
    error: result.error,
    truncated: result.truncated,
    backfilled: result.backfilled,
    backfilledFields: result.backfilledFields,
    stoppedAt: result.stoppedAt,
  };
}
