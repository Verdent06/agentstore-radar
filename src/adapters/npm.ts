import { z } from "zod";
import { adoptSourceBudget, budgetDeadlineMs, budgetExhausted, budgetExhaustedError, budgetRemainingMs } from "../lib/budget.ts";
import {
  NPM_BULK_LIMIT,
  NPM_BULK_MIN_INTERVAL_MS,
  NPM_DOWNLOADS_BASE,
  NPM_PARTIAL_FAILURE_RATIO,
  NPM_RUN_BATCH,
  NPM_SCOPED_CONCURRENCY,
  NPM_SCOPED_MIN_INTERVAL_MS,
  RATE_LIMIT_MIN_WAIT_MS,
  runBatchSize,
} from "../lib/config.ts";
import { computeCoverage, freshFetchedShare } from "../lib/coverage.ts";
import { fetchJsonWithRateLimitWait, HttpError, isHttpRateLimit, retryWaitMs } from "../lib/http.ts";
import { appIdFromIdentity, normalizePackageName } from "../lib/matching.ts";
import {
  checkpointNextIndex,
  clearCheckpoint,
  countFresh,
  countFreshToday,
  isCarriedForward,
  loadCheckpoint,
  loadEntityCache,
  loadLastFetched,
  persistCheckpoint,
  persistEntityCache,
  persistLastFetched,
  resumeDailyDueKeys,
  selectRunBatch,
} from "../lib/rolling.ts";
import { createSharedBackoffPool } from "../lib/pool.ts";
import { emptySourceRow, withObservation, type SourceRow } from "../lib/schema.ts";
import { chunk, sleep as defaultSleep } from "../lib/util.ts";
import { sourceStoppedAt, type CollectContext, type SourceAdapter, type SourceResult } from "./types.ts";

const PointSchema = z.object({
  downloads: z.number(),
  start: z.string().optional(),
  end: z.string().optional(),
  package: z.string().optional(),
});

export type NpmRawSnapshot = {
  endpoint: string;
  fetchedAt: string;
  requested: number;
  fetchedThisRun: number;
  truncated?: boolean;
  resumed?: boolean;
  packages: Record<string, unknown>;
};

export function isScopedNpmPackage(name: string): boolean {
  return name.startsWith("@");
}

export function npmBulkUrl(names: string[]): string {
  return `${NPM_DOWNLOADS_BASE}/${names.join(",")}`;
}

/** Unscoped names go out in bulk batches of 128. Scoped names stay one request each. */
export function partitionNpmDownloads(names: string[]): { bulk: string[][]; scoped: string[] } {
  const scoped = names.filter(isScopedNpmPackage);
  const unscoped = names.filter((name) => !isScopedNpmPackage(name));
  return { bulk: chunk(unscoped, NPM_BULK_LIMIT), scoped };
}

export function npmScopedUrl(name: string): string {
  return `${NPM_DOWNLOADS_BASE}/${name.replace("/", "%2F")}`;
}

export function normalizeNpmPoint(snapshotDate: string, name: string, item: unknown): SourceRow | null {
  const parsed = PointSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const pkg = normalizePackageName(parsed.data.package ?? name, "npm");
  return emptySourceRow({
    snapshot_date: snapshotDate,
    source: "npm",
    source_id: pkg,
    name: pkg,
    npm_package: pkg,
    npm_weekly_downloads: parsed.data.downloads,
    app_id: appIdFromIdentity({
      npmPackage: pkg,
      source: "npm",
      sourceId: pkg,
    }),
  });
}

function cachedDownloads(item: unknown): number {
  const parsed = PointSchema.safeParse(item);
  return parsed.success ? parsed.data.downloads : 0;
}

function rememberPoint(
  cache: Record<string, unknown>,
  lastFetched: Record<string, string>,
  name: string,
  item: unknown,
  fetchedAt: string,
): boolean {
  if (item == null || !PointSchema.safeParse(item).success) {
    return false;
  }
  cache[name] = item;
  lastFetched[name] = fetchedAt;
  return true;
}

function recordsFromCache(
  snapshotDate: string,
  keys: string[],
  cache: Record<string, unknown>,
  lastFetched: Record<string, string>,
  collectedAt: string,
  freezeUnfetched: boolean,
): SourceRow[] {
  const records: SourceRow[] = [];
  for (const name of keys) {
    const item = cache[name];
    if (item == null) {
      continue;
    }
    const row = normalizeNpmPoint(snapshotDate, name, item);
    if (row) {
      const fetchedAt = lastFetched[name] ?? null;
      const carried = isCarriedForward(fetchedAt, snapshotDate, collectedAt);
      records.push(withObservation(row, fetchedAt, carried, freezeUnfetched && carried));
    }
  }
  return records;
}

export const npmAdapter: SourceAdapter = {
  name: "npm",
  kind: "enrichment",
  async collect(ctx: CollectContext): Promise<SourceResult> {
    const allKeys = [...ctx.discovered.npmPackages].sort();
    const lastFetched = loadLastFetched(ctx.dataDir, "npm");
    const cache = loadEntityCache(ctx.dataDir, "npm");
    const checkpoint = loadCheckpoint(ctx.dataDir, "npm");
    const { dueKeys: unorderedDue, resumed } = resumeDailyDueKeys(allKeys, lastFetched, ctx.snapshotDate, checkpoint);
    const dueKeys = selectRunBatch(
      unorderedDue,
      lastFetched,
      runBatchSize(ctx.env, "RADAR_NPM_BATCH", NPM_RUN_BATCH),
      (key) => cachedDownloads(cache[key]),
    );
    const unscoped = dueKeys.filter((name) => !isScopedNpmPackage(name));
    const scoped = dueKeys.filter(isScopedNpmPackage);
    const walkOrder = [...scoped, ...unscoped];
    const fetchedAt = ctx.collectedAt;
    const sleepFn = ctx.sleep ?? defaultSleep;
    const budget = adoptSourceBudget(ctx, "npm");
    const nowMs = (): number => ctx.monotonicNow?.() ?? Date.now();
    type LaneCounter = {
      lane: "bulk" | "scoped";
      path: "bulk" | "single";
      requests: number;
      fetched: number;
      notFound: number;
      rateLimits: number;
      startedAt: number;
      endedAt: number;
    };
    const bulkLane: LaneCounter = {
      lane: "bulk",
      path: "bulk",
      requests: 0,
      fetched: 0,
      notFound: 0,
      rateLimits: 0,
      startedAt: 0,
      endedAt: 0,
    };
    const scopedLane: LaneCounter = {
      lane: "scoped",
      path: "single",
      requests: 0,
      fetched: 0,
      notFound: 0,
      rateLimits: 0,
      startedAt: 0,
      endedAt: 0,
    };
    const publishLane = (lane: LaneCounter) => {
      const ended = lane.endedAt > 0 ? lane.endedAt : lane.startedAt > 0 ? nowMs() : 0;
      return {
        lane: lane.lane,
        path: lane.path,
        requests: lane.requests,
        fetched: lane.fetched,
        notFound: lane.notFound,
        rateLimits: lane.rateLimits,
        durationMs: lane.startedAt > 0 && ended > 0 ? Math.max(0, ended - lane.startedAt) : 0,
      };
    };

    const finish = (input: {
      truncated: boolean;
      fetchedThisRun: number;
      freezeUnfetched?: boolean;
      stoppedAt?: SourceResult["stoppedAt"];
    }): SourceResult => {
      const records = recordsFromCache(
        ctx.snapshotDate,
        allKeys,
        cache,
        lastFetched,
        fetchedAt,
        input.freezeUnfetched === true,
      );
      const freshTodayCount = countFreshToday(allKeys, lastFetched, ctx.snapshotDate);
      const freshWithin7dCount = countFresh(allKeys, lastFetched, ctx.now);
      const { coverage } = computeCoverage(allKeys.length, freshTodayCount);
      const fetchedShare = freshFetchedShare(records, allKeys.length);
      persistLastFetched(ctx.dataDir, "npm", lastFetched);
      persistEntityCache(ctx.dataDir, "npm", cache);
      const nextIndex = checkpointNextIndex(walkOrder, lastFetched, ctx.snapshotDate, fetchedAt);
      if (input.truncated && nextIndex < walkOrder.length) {
        persistCheckpoint(ctx.dataDir, "npm", {
          snapshotDate: ctx.snapshotDate,
          dueKeys: walkOrder,
          nextIndex,
          startedAt: checkpoint?.startedAt ?? fetchedAt,
        });
      } else {
        clearCheckpoint(ctx.dataDir, "npm");
      }
      return {
        source: "npm",
        collectedAt: ctx.collectedAt,
        rowCount: records.length,
        skipped: false,
        truncated: input.truncated,
        eligibleCount: allKeys.length,
        freshTodayCount,
        freshWithin7dCount,
        fetchedThisRunCount: input.fetchedThisRun,
        fetchedShare,
        coverage,
        lastFetchedAt: Object.values(lastFetched).sort().at(-1),
        stoppedAt: input.stoppedAt,
        error: input.stoppedAt?.error,
        lanes: [publishLane(bulkLane), publishLane(scopedLane)],
        raw: {
          endpoint: NPM_DOWNLOADS_BASE,
          fetchedAt,
          requested: allKeys.length,
          fetchedThisRun: input.fetchedThisRun,
          truncated: input.truncated,
          resumed,
          packages: Object.fromEntries(allKeys.map((key) => [key, cache[key]]).filter(([, value]) => value != null)),
        } satisfies NpmRawSnapshot,
        records,
      };
    };

    if (allKeys.length === 0) {
      return finish({ truncated: false, fetchedThisRun: 0 });
    }

    const dueSet = new Set(dueKeys);
    ctx.log.info("npm fetching downloads", {
      requested: allKeys.length,
      due: unorderedDue.length,
      batch: dueKeys.length,
      unscoped: unscoped.length,
      scoped: scoped.length,
      resumed,
      budgetMs: budget.budgetMs,
      paths: ["bulk", "single"],
      scopedConcurrency: runBatchSize(ctx.env, "RADAR_NPM_SCOPED_CONCURRENCY", NPM_SCOPED_CONCURRENCY),
    });

    let fetchedThisRun = 0;
    let truncated = false;
    let budgetStopped = false;
    let budgetNoted = false;
    let processed = 0;
    let deferred = 0;
    let stoppedAt: SourceResult["stoppedAt"];
    let io: Promise<void> = Promise.resolve();
    const enqueueIo = (fn: () => void): Promise<void> => {
      const run = io.then(fn, fn);
      io = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    const noteBudget = (where: string): void => {
      truncated = true;
      budgetStopped = true;
      if (budgetNoted) {
        return;
      }
      budgetNoted = true;
      stoppedAt = sourceStoppedAt("npm", budgetExhaustedError(budget, where));
      ctx.log.warn("npm wall-clock budget exhausted; persisting checkpoint", {
        where,
        processed,
        due: walkOrder.length,
        budgetMs: budget.budgetMs,
        fetchedThisRun,
        lanes: [publishLane(bulkLane), publishLane(scopedLane)],
      });
    };

    const fetchNpm = async (
      url: string,
      minIntervalMs: number,
      lane: LaneCounter,
      onRateLimit?: (waitMs: number) => void,
    ): Promise<unknown> =>
      fetchJsonWithRateLimitWait<unknown>(ctx.http, url, {
        sleep: sleepFn,
        maxWaitMs: budgetRemainingMs(budget),
        init: { minIntervalMs, deadlineMs: budgetDeadlineMs(budget), maxRetries: 0 },
        onAttempt() {
          lane.requests += 1;
        },
        onWait(waitMs, attempt, error) {
          lane.rateLimits += 1;
          onRateLimit?.(waitMs);
          ctx.log.warn("npm waiting out rate limit", {
            lane: lane.lane,
            path: lane.path,
            waitMs,
            attempt,
            status: error.status,
            cloudflare: error.cloudflare,
            requests: lane.requests,
            rateLimits: lane.rateLimits,
          });
        },
      });

    const rememberCheckpoint = (): void => {
      persistCheckpoint(ctx.dataDir, "npm", {
        snapshotDate: ctx.snapshotDate,
        dueKeys: walkOrder,
        nextIndex: checkpointNextIndex(walkOrder, lastFetched, ctx.snapshotDate, fetchedAt),
        startedAt: checkpoint?.startedAt ?? fetchedAt,
      });
    };

    const countRemembered = (lane: LaneCounter, name: string, payload: unknown): void => {
      if (rememberPoint(cache, lastFetched, name, payload, fetchedAt)) {
        fetchedThisRun += 1;
        lane.fetched += 1;
      }
    };

    const runBulk = async (): Promise<void> => {
      bulkLane.startedAt = nowMs();
      try {
        const batches = partitionNpmDownloads(unscoped).bulk;
        for (const [index, batch] of batches.entries()) {
          if (budgetStopped || budgetExhausted(budget)) {
            noteBudget("before bulk batch");
            break;
          }
          await enqueueIo(rememberCheckpoint);
          try {
            const payload = await fetchNpm(npmBulkUrl(batch), NPM_BULK_MIN_INTERVAL_MS, bulkLane);
            if (batch.length === 1) {
              countRemembered(bulkLane, batch[0]!, payload);
            } else if (payload && typeof payload === "object") {
              for (const [name, item] of Object.entries(payload as Record<string, unknown>)) {
                if (!dueSet.has(name)) {
                  continue;
                }
                countRemembered(bulkLane, name, item);
              }
            }
          } catch (error) {
            if (error instanceof HttpError && error.status === 404) {
              bulkLane.notFound += batch.length;
            }
            if (isHttpRateLimit(error)) {
              bulkLane.rateLimits += 1;
              if (budgetExhausted(budget) || budgetRemainingMs(budget) < RATE_LIMIT_MIN_WAIT_MS) {
                noteBudget("bulk rate limit");
                break;
              }
              deferred += batch.length;
              ctx.log.warn("npm bulk delayed past wait budget; leaving batch for next run", {
                batch: index + 1,
                size: batch.length,
                path: "bulk",
                requests: bulkLane.requests,
                rateLimits: bulkLane.rateLimits,
                error: String(error),
              });
              processed += batch.length;
              continue;
            }
            throw error;
          }
          processed += batch.length;
          await enqueueIo(() => {
            persistLastFetched(ctx.dataDir, "npm", lastFetched);
            persistEntityCache(ctx.dataDir, "npm", cache);
          });
          if ((index + 1) % 10 === 0 || index + 1 === batches.length) {
            ctx.log.info("npm bulk progress", {
              path: "bulk",
              batch: index + 1,
              batches: batches.length,
              requests: bulkLane.requests,
              rateLimits: bulkLane.rateLimits,
              fetchedThisRun,
            });
          }
        }
      } finally {
        bulkLane.endedAt = nowMs();
        ctx.log.info("npm lane", publishLane(bulkLane));
      }
    };

    const runScoped = async (): Promise<void> => {
      scopedLane.startedAt = nowMs();
      try {
        if (scoped.length === 0) {
          return;
        }
        const concurrency = runBatchSize(ctx.env, "RADAR_NPM_SCOPED_CONCURRENCY", NPM_SCOPED_CONCURRENCY);
        const pool = createSharedBackoffPool(concurrency, sleepFn, ctx.monotonicNow ?? Date.now);
        await Promise.all(
          scoped.map(async (name) => {
            if (budgetStopped || budgetExhausted(budget)) {
              noteBudget(scopedLane.requests > 0 ? "scoped in flight" : "before scoped package");
              return;
            }
            await pool.acquire();
            try {
              if (budgetStopped || budgetExhausted(budget)) {
                noteBudget(scopedLane.requests > 0 ? "scoped in flight" : "before scoped package");
                return;
              }
              await enqueueIo(rememberCheckpoint);
              try {
                const payload = await fetchNpm(npmScopedUrl(name), NPM_SCOPED_MIN_INTERVAL_MS, scopedLane, (waitMs) => {
                  pool.pauseAll(waitMs);
                });
                countRemembered(scopedLane, name, payload);
              } catch (error) {
                if (error instanceof HttpError && error.status === 404) {
                  scopedLane.notFound += 1;
                }
                if (isHttpRateLimit(error)) {
                  scopedLane.rateLimits += 1;
                  const waitMs = retryWaitMs({
                    attempt: 0,
                    retryAfterMs: error.retryAfterMs,
                    rateLimited: true,
                    cloudflare: Boolean(error.cloudflare),
                  });
                  pool.pauseAll(waitMs);
                  if (budgetExhausted(budget) || budgetRemainingMs(budget) < RATE_LIMIT_MIN_WAIT_MS) {
                    noteBudget("scoped rate limit");
                    return;
                  }
                  deferred += 1;
                  ctx.log.warn("npm scoped delayed past wait budget; leaving key for next run", {
                    name,
                    path: "single",
                    requests: scopedLane.requests,
                    rateLimits: scopedLane.rateLimits,
                    error: String(error),
                  });
                } else {
                  ctx.log.warn("npm scoped package fetch failed", {
                    name,
                    path: "single",
                    requests: scopedLane.requests,
                    rateLimits: scopedLane.rateLimits,
                    error: String(error),
                  });
                }
              }
              processed += 1;
              await enqueueIo(() => {
                persistLastFetched(ctx.dataDir, "npm", lastFetched);
                persistEntityCache(ctx.dataDir, "npm", cache);
              });
            } finally {
              pool.release();
            }
          }),
        );
      } finally {
        scopedLane.endedAt = nowMs();
        ctx.log.info("npm lane", publishLane(scopedLane));
      }
    };

    await Promise.all([runBulk(), runScoped()]);
    await io;

    if (!truncated && dueKeys.length > 0) {
      const failedDue = dueKeys.length - fetchedThisRun - deferred;
      const failRatio = failedDue / dueKeys.length;
      if (failRatio > NPM_PARTIAL_FAILURE_RATIO) {
        truncated = true;
        stoppedAt = sourceStoppedAt(
          "npm",
          new Error(
            `npm failed ${failedDue}/${dueKeys.length} due keys (${(failRatio * 100).toFixed(1)}% > ${NPM_PARTIAL_FAILURE_RATIO * 100}%)`,
          ),
        );
        ctx.log.warn("npm marking source partial; too many rows failed", {
          fetchedThisRun,
          due: dueKeys.length,
          failedDue,
          failRatio,
        });
      }
    }

    const lanes = [publishLane(bulkLane), publishLane(scopedLane)];
    ctx.log.info("npm collected", {
      requested: allKeys.length,
      due: dueKeys.length,
      fetchedThisRun,
      truncated,
      budgetStopped,
      lanes,
    });
    return finish({ truncated, fetchedThisRun, freezeUnfetched: budgetStopped, stoppedAt });
  },
};
