import { appendFileSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { adaptersByKind } from "../adapters/index.ts";
import { npmAdapter } from "../adapters/npm.ts";
import { createDiscoveredRefs, sourceStoppedAt, type CollectContext, type SourceAdapter, type SourceResult } from "../adapters/types.ts";
import {
  BACKUP_CORE_SOURCES,
  decideIfIncompleteBackup,
  pausedSourceHasSavedRows,
  sourceDueOnIncompleteRun,
} from "../lib/backup-core.ts";
import { budgetExhausted, budgetExhaustedError, isBudgetExhaustedError, openSourceBudget } from "../lib/budget.ts";
import { budgetPartialRows } from "../lib/budget-partial.ts";
import { SOURCE_COLLECT_ATTEMPTS, sourceBudgetMs } from "../lib/config.ts";
import { computeCoverage, freshFetchedShare, isFreshRow } from "../lib/coverage.ts";
import { utcDateString } from "../lib/dates.ts";
import { createHttpClient, type HttpClient } from "../lib/http.ts";
import {
  backupNormalizedSnapshot,
  cleanupBrokenNormalizedEntries,
  dataPaths,
  inspectSnapshot,
  previousSnapshotDate,
  readManifest,
  readSourceRows,
  resolveDataDir,
  restoreNormalizedSnapshot,
  snapshotBackupStamp,
  tryGitHead,
  writeJsonSnapshot,
  writeNormalized,
} from "../lib/io.ts";
import { createLogger, type Logger } from "../lib/logger.ts";
import { linkCrossStore, linkSourceRows, ownerDecisionCounts, tieDecidedPackageOwners } from "../lib/matching.ts";
import { mergeApps } from "../lib/merge.ts";
import { formatNpmLaneSummary, type NpmProducer } from "../lib/npm-scoped-pace.ts";
import { decideNpmRecovery, NPM_RECOVERY_MARGIN_MS, nextUtcMidnightMs } from "../lib/npm-recovery.ts";
import {
  decideNpmChain,
  formatNpmChainSummary,
  readCollectChain,
  writeCollectOutputs,
  type NpmChainDecision,
  type NpmChainRequest,
} from "../lib/npm-chain.ts";
import { formatRefetchStepSummary, withRefetchStats } from "../lib/refetch-coverage.ts";
import { retryAsync, type SleepFn } from "../lib/retry.ts";
import {
  SOURCE_NAMES,
  sourceIsIncomplete,
  type SnapshotManifest,
  type SourceManifest,
  type SourceName,
  type SourceRow,
} from "../lib/schema.ts";
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
  monotonicNow?: () => number;
  /** Live UTC clock. Defaults to the real clock, or to `now` when a test froze it. */
  wallNow?: () => Date;
  /**
   * After the selected sources, run npm when today's manifest still has an
   * `npm:` coreClean reason. Every schedule passes this with `--if-incomplete`.
   */
  recoverNpm?: boolean;
  /**
   * Called when npm stops for its wall-clock budget and another full
   * `--if-incomplete --recover-npm` collect should be dispatched.
   * The workflow performs the GitHub dispatch from the step outputs.
   */
  dispatchCollect?: (request: NpmChainRequest) => Promise<void> | void;
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

type FreshChange = { source: string; previousFresh: number; nextFresh: number };

/** Core sources for the late-replace guard. Same list `coreClean` reads. */
const CORE_REPLACE_SOURCES = new Set<string>(BACKUP_CORE_SOURCES);

function freshCountsBySource(rows: readonly SourceRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const current = counts.get(row.source) ?? 0;
    counts.set(row.source, current + (isFreshRow(row) ? 1 : 0));
  }
  return counts;
}

function formatFreshChange(change: FreshChange): string {
  return `${change.source} fresh ${change.previousFresh} -> ${change.nextFresh}`;
}

function formatNonCoreDropSummary(date: string, dropped: readonly FreshChange[], improved: readonly FreshChange[]): string {
  return [
    `### Non-core fresh drop ${date}`,
    "",
    "A paused source lost fresh rows. No core source dropped, and a core source improved, so this snapshot was written.",
    "",
    "Non-core drop:",
    "",
    ...dropped.map((change) => `- ${change.source}: ${change.previousFresh} -> ${change.nextFresh}`),
    "",
    "Core improved:",
    "",
    ...improved.map((change) => `- ${change.source}: ${change.previousFresh} -> ${change.nextFresh}`),
    "",
  ].join("\n");
}

/** Visible in the Actions run summary. A missing env var means this is not a job step. */
function appendJobSummary(env: NodeJS.ProcessEnv | undefined, markdown: string): void {
  const path = env?.GITHUB_STEP_SUMMARY;
  if (!path) {
    return;
  }
  appendFileSync(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

function stampFetchWindow(result: SourceResult, startedMs: number, endedMs: number): SourceResult {
  return {
    ...result,
    fetchStartedAt: new Date(startedMs).toISOString(),
    fetchEndedAt: new Date(endedMs).toISOString(),
  };
}

function budgetPartialResult(adapter: SourceAdapter, ctx: CollectContext, error: unknown): SourceResult {
  const stoppedAt = sourceStoppedAt(adapter.name, error);
  const records = budgetPartialRows(ctx.dataDir, adapter.name, ctx.snapshotDate);
  const eligibleCount = records.length;
  return {
    source: adapter.name,
    collectedAt: ctx.collectedAt,
    rowCount: records.length,
    skipped: false,
    truncated: true,
    failed: false,
    error: stoppedAt.error,
    stoppedAt,
    raw: { truncated: true, budgetExhausted: true, keptRows: records.length },
    records,
    eligibleCount,
    freshTodayCount: 0,
    freshWithin7dCount: 0,
    fetchedThisRunCount: 0,
    fetchedShare: eligibleCount === 0 ? 0 : undefined,
    coverage: eligibleCount === 0 ? 0 : 0,
  };
}

/**
 * One budget for every attempt. A retry reuses the time left; once the budget
 * is spent the adapter is not called again, and exhaustion is a partial result.
 */
export async function collectAdapter(
  adapter: SourceAdapter,
  ctx: CollectContext,
  attempts: number,
  sleep: SleepFn,
): Promise<SourceResult> {
  const clock = ctx.monotonicNow ?? Date.now;
  const budget = openSourceBudget(ctx.env, adapter.name, clock);
  const sourceCtx: CollectContext = { ...ctx, budget };
  const fetchStartedMs = budget.startedAtMs;
  const finish = (result: SourceResult): SourceResult => stampFetchWindow(result, fetchStartedMs, clock());
  try {
    const result = await retryAsync(async (attempt) => {
      if (attempt > 0 && budgetExhausted(budget)) {
        throw budgetExhaustedError(budget, "before retry");
      }
      return adapter.collect(sourceCtx);
    }, {
      attempts,
      sleep,
      shouldRetry(error) {
        return !budgetExhausted(budget) && !isBudgetExhaustedError(error);
      },
      onRetry(attempt, error, waitMs) {
        ctx.log.warn(`retrying ${adapter.name}`, {
          attempt: attempt + 1,
          waitMs,
          error: errorMessage(error),
        });
      },
    });
    return finish(result);
  } catch (error) {
    if (budgetExhausted(budget) || isBudgetExhaustedError(error)) {
      ctx.log.warn(`source ${adapter.name} stopped at its wall-clock budget`, {
        error: errorMessage(error),
        budgetMs: budget.budgetMs,
      });
      return finish(budgetPartialResult(adapter, sourceCtx, error));
    }
    ctx.log.error(`source ${adapter.name} failed; continuing with remaining sources`, {
      error: errorMessage(error),
    });
    return finish(failedResult(adapter.name, ctx.collectedAt, error));
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
  const runtimeEnv = options.env ?? process.env;
  const chainCount = readCollectChain(runtimeEnv);
  const wallClock = (): Date => options.wallNow?.() ?? options.now ?? now;

  const recordChain = async (decision: NpmChainDecision, wrote: boolean): Promise<void> => {
    log.info(decision.dispatch ? "npm chain dispatch" : "npm chain stop", {
      reason: decision.reason,
      chain: decision.request?.chain ?? chainCount,
    });
    appendJobSummary(runtimeEnv, formatNpmChainSummary(decision));
    writeCollectOutputs(runtimeEnv, { wrote, decision });
    if (decision.dispatch && decision.request && options.dispatchCollect) {
      await options.dispatchCollect(decision.request);
    }
  };

  const dayCompleteDecision = (): NpmChainDecision =>
    decideNpmChain({
      nowMs: wallClock().getTime(),
      chain: chainCount,
      npmFetchedThisRun: 0,
      npmRan: false,
      dayComplete: true,
    });

  if (cleaned.length > 0) {
    log.warn("removed broken snapshot entries", { entries: cleaned });
  }

  const inspection = inspectSnapshot(snapshotDate, dataDir);
  // `--if-incomplete` uses window-guard `coreClean`. manifest.partial stays
  // the six-source flag and is not consulted here. Sources that are already
  // complete for this UTC date are not collected again. A paused source
  // (smithery, gemini-cli, pypi) that already has rows is kept.
  if (options.ifIncomplete && !options.force) {
    const decision = decideIfIncompleteBackup(snapshotDate, dataDir);
    if (!decision.proceed) {
      log.info("backup skipped; core sources are complete", { date: snapshotDate, reason: decision.reason });
      if (decision.summary) {
        appendJobSummary(runtimeEnv, decision.summary);
      }
      await recordChain(dayCompleteDecision(), false);
      return {
        ok: true,
        skipped: true,
        skipReason: decision.reason,
        wrote: false,
        manifest: decision.manifest,
        failedSources: [],
        cleaned,
        date: snapshotDate,
      };
    }
    log.info("core sources are incomplete; collecting", { date: snapshotDate, reason: decision.reason });
    if (inspection.hasManifest) {
      let onDisk: SnapshotManifest | undefined;
      try {
        onDisk = readManifest(snapshotDate, dataDir);
      } catch {
        onDisk = undefined;
      }
      if (onDisk) {
        const skipped: string[] = [];
        const keptPaused: string[] = [];
        for (const name of [...names]) {
          if (pausedSourceHasSavedRows(onDisk, name)) {
            names.delete(name);
            keptPaused.push(name);
            continue;
          }
          if (!sourceDueOnIncompleteRun(onDisk, name)) {
            names.delete(name);
            skipped.push(name);
          }
        }
        if (keptPaused.length > 0) {
          log.info("keeping saved rows for paused sources", {
            date: snapshotDate,
            sources: keptPaused,
          });
        }
        if (skipped.length > 0) {
          log.info("skipping sources already complete for this UTC date", {
            date: snapshotDate,
            sources: skipped,
          });
        }
        const npmStillDue = sourceDueOnIncompleteRun(onDisk, "npm");
        if (names.size === 0 && !(options.recoverNpm && npmStillDue)) {
          for (const name of selectedNames(options.sources)) {
            if (pausedSourceHasSavedRows(onDisk, name)) {
              continue;
            }
            names.add(name);
          }
        }
      }
    }
  } else if (!options.force && inspection.usable && inspection.hasManifest) {
    let existing: SnapshotManifest | undefined;
    try {
      existing = readManifest(snapshotDate, dataDir);
    } catch {
      existing = undefined;
    }
    if (existing && snapshotIsSixSourceComplete(existing)) {
      log.info("snapshot already complete; refusing to overwrite", { date: snapshotDate });
      await recordChain(dayCompleteDecision(), false);
      return {
        ok: true,
        skipped: true,
        skipReason: `snapshot ${snapshotDate} already complete; pass --force to overwrite`,
        wrote: false,
        manifest: existing,
        failedSources: [],
        cleaned,
        date: snapshotDate,
      };
    }
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
    monotonicNow: options.monotonicNow,
    wallNow: options.wallNow ?? (options.now ? () => now : () => new Date()),
    runId,
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

  let npmProducer: NpmProducer | undefined = names.has("npm") ? "scheduled" : undefined;
  if (options.recoverNpm && !names.has("npm")) {
    let onDisk: SnapshotManifest | undefined;
    if (inspection.hasManifest) {
      try {
        onDisk = readManifest(snapshotDate, dataDir);
      } catch {
        onDisk = undefined;
      }
    }
    const wallMs = ctx.wallNow?.().getTime() ?? now.getTime();
    const deadlineRaw = ctx.env.RADAR_COLLECT_STEP_DEADLINE_MS?.trim();
    const deadlineParsed = deadlineRaw ? Number(deadlineRaw) : undefined;
    const decision = decideNpmRecovery({
      manifest: onDisk,
      nowMs: wallMs,
      configuredBudgetMs: sourceBudgetMs(ctx.env, "npm"),
      marginMs: NPM_RECOVERY_MARGIN_MS,
      midnightMs: nextUtcMidnightMs(wallMs),
      jobDeadlineMs: deadlineParsed != null && Number.isFinite(deadlineParsed) ? deadlineParsed : undefined,
    });
    if (decision.run) {
      log.info("npm recovery", { budgetMs: decision.budgetMs, reason: decision.reason });
      const npmEnv = { ...ctx.env, RADAR_NPM_BUDGET_MS: String(decision.budgetMs) };
      results.push(
        await collectAdapter(npmAdapter, { ...ctx, env: npmEnv }, sourceAttempts, sleep),
      );
      npmProducer = "recovery";
    } else {
      log.info("npm recovery skipped", { reason: decision.reason });
      appendJobSummary(
        options.env ?? process.env,
        ["### npm lane", "", `- Producer: collect recovery`, `- Skipped: ${decision.reason}`, ""].join("\n"),
      );
    }
  }

  const failedSources = results.filter((result) => result.failed).map((result) => result.source);
  const npmResult = results.find((result) => result.source === "npm");
  if (npmResult) {
    const scopedLane = npmResult.lanes?.find((lane) => lane.lane === "scoped");
    appendJobSummary(
      options.env ?? process.env,
      formatNpmLaneSummary({
        durationMs: scopedLane?.durationMs ?? 0,
        scopedRequests: scopedLane?.requests ?? 0,
        rateLimits: scopedLane?.rateLimits ?? 0,
        halt: npmResult.halt,
        producer: npmProducer,
      }),
    );
  }
  let keptRows: SourceRow[] = [];
  let keptManifests: SourceManifest[] = [];
  let previousManifest: SnapshotManifest | undefined;
  if (inspection.hasManifest) {
    try {
      previousManifest = readManifest(snapshotDate, dataDir);
    } catch {
      previousManifest = undefined;
    }
  }
  if (previousManifest) {
    let previousRows: SourceRow[] = [];
    try {
      previousRows = readSourceRows(snapshotDate, dataDir);
    } catch {
      previousRows = [];
    }
    const replaced = new Set(names);
    if (npmProducer === "recovery") {
      replaced.add("npm");
    }
    keptRows = previousRows.filter((row) => !replaced.has(row.source));
    keptManifests = previousManifest.sources.filter((source) => !replaced.has(source.source));
  }
  const newRecords = results.flatMap((result) => result.records);
  const sourceRows: SourceRow[] = linkSourceRows([...keptRows, ...newRecords]);
  if (newRecords.length === 0) {
    log.error("all sources failed or produced no rows; not writing an empty snapshot", {
      date: snapshotDate,
      failedSources,
    });
    await recordChain(
      decideNpmChain({
        nowMs: ctx.wallNow?.().getTime() ?? now.getTime(),
        chain: chainCount,
        halt: npmResult?.halt,
        npmFetchedThisRun: npmResult?.fetchedThisRunCount ?? 0,
        npmRan: Boolean(npmResult),
        dayComplete: false,
      }),
      false,
    );
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
  if (!options.force && previousManifest) {
    let previousRows: SourceRow[] = [];
    try {
      previousRows = readSourceRows(snapshotDate, dataDir);
    } catch {
      previousRows = [];
    }
    const previousCounts = freshCountsBySource(previousRows);
    const nextCounts = freshCountsBySource(sourceRows);
    const sources = [...new Set([...previousCounts.keys(), ...nextCounts.keys()])].sort();
    const blocked: FreshChange[] = [];
    const improved: FreshChange[] = [];
    for (const source of sources) {
      const previousFresh = previousCounts.get(source) ?? 0;
      const nextFresh = nextCounts.get(source) ?? 0;
      if (nextFresh < previousFresh) {
        blocked.push({ source, previousFresh, nextFresh });
      } else if (nextFresh > previousFresh) {
        improved.push({ source, previousFresh, nextFresh });
      }
    }
    const coreBlocked = blocked.filter((change) => CORE_REPLACE_SOURCES.has(change.source));
    const nonCoreBlocked = blocked.filter((change) => !CORE_REPLACE_SOURCES.has(change.source));
    const coreImproved = improved.filter((change) => CORE_REPLACE_SOURCES.has(change.source));
    if (nonCoreBlocked.length > 0 && coreBlocked.length === 0 && coreImproved.length > 0) {
      const droppedText = nonCoreBlocked.map(formatFreshChange).join(", ");
      const improvedText = coreImproved.map(formatFreshChange).join(", ");
      const message = `non-core fresh drop on ${snapshotDate}: ${droppedText}; core improved ${improvedText}`;
      log.warn(message, { date: snapshotDate, nonCoreBlocked, coreImproved });
      appendJobSummary(
        options.env ?? process.env,
        formatNonCoreDropSummary(snapshotDate, nonCoreBlocked, coreImproved),
      );
    } else if (blocked.length > 0) {
      const blockedText = blocked.map(formatFreshChange).join(", ");
      const improvedText = improved.length > 0 ? improved.map(formatFreshChange).join(", ") : "none";
      const message = `refusing to replace ${snapshotDate}: blocked by ${blockedText}; would have improved ${improvedText}`;
      log.warn(message, { date: snapshotDate, blocked, improved });
      const improvedLines =
        improved.length > 0
          ? improved.map((change) => `- ${change.source}: ${change.previousFresh} -> ${change.nextFresh}`).join("\n")
          : "- none";
      appendJobSummary(
        options.env ?? process.env,
        [
          `### Collect refused to replace ${snapshotDate}`,
          "",
          "The on-disk manifest was not modified. The day stays partial.",
          "",
          message,
          "",
          "Blocked (fresh rows would drop):",
          "",
          ...blocked.map((change) => `- ${change.source}: ${change.previousFresh} -> ${change.nextFresh}`),
          "",
          "Would have improved:",
          "",
          improvedLines,
          "",
        ].join("\n"),
      );
      await recordChain({ dispatch: false, reason: "collect did not keep the snapshot" }, false);
      return {
        ok: true,
        skipped: false,
        wrote: false,
        manifest: previousManifest,
        failedSources,
        cleaned,
        date: snapshotDate,
      };
    }
  }
  const sourceManifests: SourceManifest[] = [];
  const priorDate = previousSnapshotDate(snapshotDate, dataDir);
  let priorRows: SourceRow[] = [];
  if (priorDate) {
    try {
      priorRows = readSourceRows(priorDate, dataDir);
    } catch (error) {
      log.warn("could not read previous snapshot for refetch counts", {
        date: priorDate,
        error: errorMessage(error),
      });
    }
  }

  for (const result of results) {
    let rawFile: string | undefined;
    const writeRaw = result.records.length > 0 || (!result.skipped && !result.failed);
    if (writeRaw) {
      rawFile = await writeJsonSnapshot(result.source, snapshotDate, today, result.raw, dataDir);
      log.info(`wrote ${rawFile}`, { source: result.source, rows: result.rowCount });
    }
    const previousSource = previousManifest?.sources.find((source) => source.source === result.source);
    const sourceManifest = withRefetchStats(
      mergeFetchSpan(previousSource, toSourceManifest(result, rawFile), runId),
      sourceRows,
      priorRows,
    );
    sourceManifests.push(sourceManifest);
  }

  const mergedManifests = orderSourceManifests([...keptManifests, ...sourceManifests]);
  const partial = mergedManifests.some((source) => source.failed === true || source.truncated === true);
  const completedSources = mergedManifests
    .filter((source) => source.failed !== true && source.truncated !== true && source.skipped !== true)
    .map((source) => source.source);
  const failedSourceCount = mergedManifests.filter((source) => source.failed === true).length;
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
    sources: mergedManifests,
    appCount: apps.length,
    sourceRowCount: sourceRows.length,
    partial,
    completedSources,
    failedSourceCount,
    runId,
    overwrite,
  };
  try {
    const packageOwners = linkCrossStore([...keptRows, ...newRecords]).packageOwners;
    const counts = ownerDecisionCounts(packageOwners);
    const tieDecided = tieDecidedPackageOwners(packageOwners);
    manifest.owner_decided_by = packageOwners;
    manifest.ownerDecisionCounts = counts;
    manifest.tieDecidedPackageOwners = tieDecided;
  } catch (error) {
    log.warn(errorMessage(error));
  }

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
    completedSources,
    partial,
  });
  appendJobSummary(runtimeEnv, formatRefetchStepSummary(snapshotDate, mergedManifests));
  await recordChain(
    decideNpmChain({
      nowMs: ctx.wallNow?.().getTime() ?? now.getTime(),
      chain: chainCount,
      halt: npmResult?.halt,
      npmFetchedThisRun: npmResult?.fetchedThisRunCount ?? 0,
      npmRan: Boolean(npmResult),
      dayComplete: false,
    }),
    true,
  );
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
  const incomplete = result.truncated === true || result.failed === true;
  const { coverage } = computeCoverage(eligible, freshToday);
  const fetchedShare =
    incomplete && eligible === 0
      ? 0
      : result.skipped && eligible === 0
        ? undefined
        : freshFetchedShare(result.records, eligible, unresolvedCount, incomplete);
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
    fetchedShare,
    coverage: result.skipped && eligible === 0 ? undefined : incomplete && eligible === 0 ? 0 : result.coverage ?? coverage,
    lastFetchedAt: result.lastFetchedAt,
    unresolvedCount: result.unresolvedCount,
    unresolvedRepos: result.unresolvedRepos,
    failed: result.failed,
    error: result.error,
    truncated: result.truncated,
    backfilled: result.backfilled,
    backfilledFields: result.backfilledFields,
    stoppedAt: result.stoppedAt,
    weeklyGtMonthlyCount: result.weeklyGtMonthlyCount,
    fetch_started_at: result.fetchStartedAt,
    fetch_ended_at: result.fetchEndedAt,
    lanes: result.lanes,
  };
}

/** A late primary refuses only a day where all six sources are present and none failed or truncated. */
export function snapshotIsSixSourceComplete(manifest: SnapshotManifest): boolean {
  if (manifest.partial === true) {
    return false;
  }
  const present = new Set(manifest.sources.map((source) => source.source));
  if (SOURCE_NAMES.some((name) => !present.has(name))) {
    return false;
  }
  return !manifest.sources.some((source) => sourceIsIncomplete(source));
}

function orderSourceManifests(sources: readonly SourceManifest[]): SourceManifest[] {
  const byName = new Map(sources.map((source) => [source.source, source]));
  return SOURCE_NAMES.flatMap((name) => {
    const source = byName.get(name);
    return source ? [source] : [];
  });
}

function earlierIso(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function laterIso(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

/** Backup run keeps the first start, the latest end, and every run id that fetched the source. */
export function mergeFetchSpan(
  previous: SourceManifest | undefined,
  current: SourceManifest,
  runId?: string,
): SourceManifest {
  const fetchRunIds = [...(previous?.fetchRunIds ?? [])];
  if (runId && fetchRunIds[fetchRunIds.length - 1] !== runId) {
    fetchRunIds.push(runId);
  }
  return {
    ...current,
    fetch_started_at: earlierIso(previous?.fetch_started_at, current.fetch_started_at),
    fetch_ended_at: laterIso(previous?.fetch_ended_at, current.fetch_ended_at),
    fetchRunIds: fetchRunIds.length > 0 ? fetchRunIds : undefined,
  };
}
