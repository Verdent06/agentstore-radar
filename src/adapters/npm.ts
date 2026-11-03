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
import { fetchJsonWithRateLimitWait, isHttpRateLimit, retryWaitMs } from "../lib/http.ts";
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
    const walkOrder = [...unscoped, ...scoped];
    const fetchedAt = ctx.collectedAt;
    const sleepFn = ctx.sleep ?? defaultSleep;
    const budget = adoptSourceBudget(ctx, "npm");

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
    });

    let fetchedThisRun = 0;
    let truncated = false;
    let budgetStopped = false;
    let processed = 0;
    let deferred = 0;
    let stoppedAt: SourceResult["stoppedAt"];

    const noteBudget = (where: string): void => {
      truncated = true;
      budgetStopped = true;
      stoppedAt = sourceStoppedAt("npm", budgetExhaustedError(budget, where));
      ctx.log.warn("npm wall-clock budget exhausted; persisting checkpoint", {
        where,
        processed,
        due: walkOrder.length,
        budgetMs: budget.budgetMs,
        fetchedThisRun,
      });
    };

    const fetchNpm = async (url: string, minIntervalMs: number): Promise<unknown> =>
      fetchJsonWithRateLimitWait<unknown>(ctx.http, url, {
        sleep: sleepFn,
        maxWaitMs: budgetRemainingMs(budget),
        init: { minIntervalMs, deadlineMs: budgetDeadlineMs(budget) },
        onWait(waitMs, attempt, error) {
          ctx.log.warn("npm waiting out rate limit", {
            waitMs,
            attempt,
            status: error.status,
            cloudflare: error.cloudflare,
          });
        },
      });

    const rememberCheckpoint = (): void => {
      persistCheckpoint(ctx.dataDir, "npm", {
        snapshotDate: ctx.snapshotDate,
        dueKeys: walkOrder,
        nextIndex: processed,
        startedAt: checkpoint?.startedAt ?? fetchedAt,
      });
    };

    const batches = partitionNpmDownloads(walkOrder).bulk;
    for (const [index, batch] of batches.entries()) {
      if (budgetExhausted(budget)) {
        noteBudget("before bulk batch");
        break;
      }
      rememberCheckpoint();
      try {
        const payload = await fetchNpm(npmBulkUrl(batch), NPM_BULK_MIN_INTERVAL_MS);
        if (batch.length === 1) {
          if (rememberPoint(cache, lastFetched, batch[0]!, payload, fetchedAt)) {
            fetchedThisRun += 1;
          }
        } else if (payload && typeof payload === "object") {
          for (const [name, item] of Object.entries(payload as Record<string, unknown>)) {
            if (!dueSet.has(name)) {
              continue;
            }
            if (rememberPoint(cache, lastFetched, name, item, fetchedAt)) {
              fetchedThisRun += 1;
            }
          }
        }
      } catch (error) {
        if (isHttpRateLimit(error)) {
          if (budgetExhausted(budget) || budgetRemainingMs(budget) < RATE_LIMIT_MIN_WAIT_MS) {
            noteBudget("bulk rate limit");
            break;
          }
          deferred += batch.length;
          ctx.log.warn("npm bulk delayed past wait budget; leaving batch for next run", {
            batch: index + 1,
            size: batch.length,
            error: String(error),
          });
          processed += batch.length;
          continue;
        }
        throw error;
      }
      processed += batch.length;
      persistLastFetched(ctx.dataDir, "npm", lastFetched);
      persistEntityCache(ctx.dataDir, "npm", cache);
      if ((index + 1) % 10 === 0 || index + 1 === batches.length) {
        ctx.log.info("npm bulk progress", {
          batch: index + 1,
          batches: batches.length,
          fetchedThisRun,
        });
      }
    }

    if (!budgetStopped && scoped.length > 0) {
      const concurrency = runBatchSize(ctx.env, "RADAR_NPM_SCOPED_CONCURRENCY", NPM_SCOPED_CONCURRENCY);
      const pool = createSharedBackoffPool(concurrency, sleepFn, ctx.monotonicNow ?? Date.now);
      let io: Promise<void> = Promise.resolve();
      const enqueueIo = (fn: () => void): Promise<void> => {
        io = io.then(fn);
        return io;
      };
      await Promise.all(
        scoped.map(async (name) => {
          if (budgetStopped || budgetExhausted(budget)) {
            noteBudget("before scoped package");
            return;
          }
          await pool.acquire();
          try {
            if (budgetStopped || budgetExhausted(budget)) {
              noteBudget("before scoped package");
              return;
            }
            await enqueueIo(() => {
              rememberCheckpoint();
            });
            try {
              const payload = await fetchNpm(npmScopedUrl(name), NPM_SCOPED_MIN_INTERVAL_MS);
              if (rememberPoint(cache, lastFetched, name, payload, fetchedAt)) {
                fetchedThisRun += 1;
              }
            } catch (error) {
              if (isHttpRateLimit(error)) {
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
                  error: String(error),
                });
              } else {
                ctx.log.warn("npm scoped package fetch failed", { name, error: String(error) });
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
      await io;
    }

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

    ctx.log.info("npm collected", {
      requested: allKeys.length,
      due: dueKeys.length,
      fetchedThisRun,
      truncated,
      budgetStopped,
    });
    return finish({ truncated, fetchedThisRun, freezeUnfetched: budgetStopped, stoppedAt });
  },
};
