import { z } from "zod";
import {
  PYPI_MIN_INTERVAL_MS,
  PYPI_RUN_BATCH,
  PYPISTATS_BASE,
  SMITHERY_FROZEN_DAYS,
  SOURCE_FREEZE_RATIO,
  runBatchSize,
} from "../lib/config.ts";
import { computeCoverage, computeFetchedShare } from "../lib/coverage.ts";
import { evaluateSourceFreeze, isUnchangedForDays, loadPreviousMetricHistory, smitheryFrozenDays } from "../lib/frozen.ts";
import { fetchJsonWithRateLimitWait, HttpError } from "../lib/http.ts";
import { appIdFromIdentity, normalizePackageName } from "../lib/matching.ts";
import {
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
import { emptySourceRow, withObservation, type SourceRow } from "../lib/schema.ts";
import { sleep as defaultSleep } from "../lib/util.ts";
import { sourceStoppedAt, type CollectContext, type SourceAdapter, type SourceResult } from "./types.ts";

const RecentSchema = z.object({
  data: z.object({
    last_day: z.number().nullable().optional(),
    last_week: z.number().nullable().optional(),
    last_month: z.number().nullable().optional(),
  }),
  package: z.string().optional(),
  type: z.string().optional(),
});

export type PypiRawSnapshot = {
  endpoint: string;
  fetchedAt: string;
  requested: number;
  fetchedThisRun: number;
  truncated?: boolean;
  resumed?: boolean;
  packages: Record<string, unknown>;
};

export function pypiRecentUrl(name: string): string {
  return `${PYPISTATS_BASE}/${encodeURIComponent(name)}/recent`;
}

/** pypistats last_month cannot be below last_week; that payload is unusable. */
export function pypiMonthlyInconsistent(
  week: number | null | undefined,
  month: number | null | undefined,
): boolean {
  return typeof week === "number" && typeof month === "number" && month < week;
}

export function normalizePypiRecent(snapshotDate: string, name: string, item: unknown): SourceRow | null {
  const parsed = RecentSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const pkg = normalizePackageName(parsed.data.package ?? name, "pypi");
  return emptySourceRow({
    snapshot_date: snapshotDate,
    source: "pypi",
    source_id: pkg,
    name: pkg,
    pypi_package: pkg,
    pypi_last_week_downloads: parsed.data.data.last_week ?? null,
    pypi_last_month_downloads: parsed.data.data.last_month ?? null,
    app_id: appIdFromIdentity({
      pypiPackage: pkg,
      source: "pypi",
      sourceId: pkg,
    }),
  });
}

function cachedWeekDownloads(item: unknown): number {
  const parsed = RecentSchema.safeParse(item);
  return parsed.success ? (parsed.data.data.last_week ?? 0) : 0;
}

function recordsFromCache(
  snapshotDate: string,
  keys: string[],
  cache: Record<string, unknown>,
  lastFetched: Record<string, string>,
  collectedAt: string,
  monthHistory: ReturnType<typeof loadPreviousMetricHistory>,
  weekHistory: ReturnType<typeof loadPreviousMetricHistory>,
  frozenDays: number,
): SourceRow[] {
  const pending: Array<{
    row: SourceRow;
    fetchedAt: string | null;
    fetchedCarried: boolean;
    monthUnchanged: boolean;
    weekMoved: boolean;
    inconsistent: boolean;
  }> = [];
  for (const name of keys) {
    const item = cache[name];
    if (item == null) {
      continue;
    }
    const row = normalizePypiRecent(snapshotDate, name, item);
    if (!row) {
      continue;
    }
    const fetchedAt = lastFetched[name] ?? null;
    const monthUnchanged = isUnchangedForDays(
      row.pypi_last_month_downloads,
      monthHistory.byId.get(name) ?? [],
      monthHistory.dates,
      frozenDays,
    );
    const previousWeek = weekHistory.byId.get(name)?.at(-1)?.value;
    const weekMoved =
      typeof row.pypi_last_week_downloads === "number" &&
      typeof previousWeek === "number" &&
      row.pypi_last_week_downloads !== previousWeek;
    pending.push({
      row,
      fetchedAt,
      fetchedCarried: isCarriedForward(fetchedAt, snapshotDate, collectedAt),
      monthUnchanged,
      weekMoved,
      inconsistent: pypiMonthlyInconsistent(row.pypi_last_week_downloads, row.pypi_last_month_downloads),
    });
  }
  // Source-freeze only on live-fetched rows. Carried cache values stay identical
  // by definition and must not push a 95% freeze onto packages fetched today.
  const live = pending.filter((item) => !item.fetchedCarried);
  const freeze = evaluateSourceFreeze(
    live.map((item) => item.monthUnchanged),
    SOURCE_FREEZE_RATIO,
  );
  const liveFrozen = new Map(live.map((item, index) => [item.row.source_id, freeze.freezeRow[index] === true]));
  return pending.map((item) => {
    const monthlyStale = item.monthUnchanged && (freeze.sourceFrozen || item.weekMoved);
    const frozen = item.inconsistent || monthlyStale || liveFrozen.get(item.row.source_id) === true;
    const carried = item.fetchedCarried || item.inconsistent;
    return withObservation(item.row, item.fetchedAt, carried, frozen);
  });
}

export const pypiAdapter: SourceAdapter = {
  name: "pypi",
  kind: "enrichment",
  async collect(ctx: CollectContext): Promise<SourceResult> {
    const allKeys = [...ctx.discovered.pypiPackages].sort();
    const lastFetched = loadLastFetched(ctx.dataDir, "pypi");
    const cache = loadEntityCache(ctx.dataDir, "pypi");
    const checkpoint = loadCheckpoint(ctx.dataDir, "pypi");
    const { dueKeys: unorderedDue, resumed } = resumeDailyDueKeys(allKeys, lastFetched, ctx.snapshotDate, checkpoint);
    const dueKeys = selectRunBatch(
      unorderedDue,
      lastFetched,
      runBatchSize(ctx.env, "RADAR_PYPI_BATCH", PYPI_RUN_BATCH),
      (key) => cachedWeekDownloads(cache[key]),
    );
    const fetchedAt = ctx.collectedAt;
    const sleepFn = ctx.sleep ?? defaultSleep;
    const frozenDays = smitheryFrozenDays(ctx.env, SMITHERY_FROZEN_DAYS);
    const monthHistory = loadPreviousMetricHistory(
      ctx.dataDir,
      ctx.snapshotDate,
      "pypi",
      "pypi_last_month_downloads",
      frozenDays,
    );
    const weekHistory = loadPreviousMetricHistory(
      ctx.dataDir,
      ctx.snapshotDate,
      "pypi",
      "pypi_last_week_downloads",
      frozenDays,
    );

    const finish = (input: {
      truncated: boolean;
      fetchedThisRun: number;
      processed?: number;
      stoppedAt?: SourceResult["stoppedAt"];
    }): SourceResult => {
      const records = recordsFromCache(
        ctx.snapshotDate,
        allKeys,
        cache,
        lastFetched,
        fetchedAt,
        monthHistory,
        weekHistory,
        frozenDays,
      );
      const freshTodayCount = countFreshToday(allKeys, lastFetched, ctx.snapshotDate);
      const freshWithin7dCount = countFresh(allKeys, lastFetched, ctx.now);
      const { coverage } = computeCoverage(allKeys.length, freshTodayCount);
      const fetchedShare = computeFetchedShare(input.fetchedThisRun, allKeys.length);
      persistLastFetched(ctx.dataDir, "pypi", lastFetched);
      persistEntityCache(ctx.dataDir, "pypi", cache);
      if (input.truncated) {
        persistCheckpoint(ctx.dataDir, "pypi", {
          snapshotDate: ctx.snapshotDate,
          dueKeys,
          nextIndex: Math.min(dueKeys.length, input.processed ?? input.fetchedThisRun),
          startedAt: checkpoint?.startedAt ?? fetchedAt,
        });
      } else {
        clearCheckpoint(ctx.dataDir, "pypi");
      }
      return {
        source: "pypi",
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
          endpoint: PYPISTATS_BASE,
          fetchedAt,
          requested: allKeys.length,
          fetchedThisRun: input.fetchedThisRun,
          truncated: input.truncated,
          resumed,
          packages: Object.fromEntries(allKeys.map((key) => [key, cache[key]]).filter(([, value]) => value != null)),
        } satisfies PypiRawSnapshot,
        records,
      };
    };

    if (allKeys.length === 0) {
      return finish({ truncated: false, fetchedThisRun: 0 });
    }

    ctx.log.info("pypi fetching recent downloads", {
      requested: allKeys.length,
      due: unorderedDue.length,
      batch: dueKeys.length,
      resumed,
    });

    let fetchedThisRun = 0;
    let processed = 0;
    let truncated = false;
    let stoppedAt: SourceResult["stoppedAt"];

    try {
      for (const [index, name] of dueKeys.entries()) {
        persistCheckpoint(ctx.dataDir, "pypi", {
          snapshotDate: ctx.snapshotDate,
          dueKeys,
          nextIndex: index,
          startedAt: checkpoint?.startedAt ?? fetchedAt,
        });
        try {
          const payload = await fetchJsonWithRateLimitWait<unknown>(ctx.http, pypiRecentUrl(name), {
            sleep: sleepFn,
            init: { minIntervalMs: PYPI_MIN_INTERVAL_MS },
            onWait(waitMs, attempt, error) {
              ctx.log.warn("pypi waiting out rate limit", {
                waitMs,
                attempt,
                status: error.status,
                name,
              });
            },
          });
          if (RecentSchema.safeParse(payload).success) {
            cache[name] = payload;
            lastFetched[name] = fetchedAt;
            fetchedThisRun += 1;
          }
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            lastFetched[name] = fetchedAt;
            persistLastFetched(ctx.dataDir, "pypi", lastFetched);
            processed = index + 1;
            continue;
          }
          if (error instanceof HttpError && (error.status === 429 || error.status === 403 || error.cloudflare)) {
            throw error;
          }
          ctx.log.warn("pypi package fetch failed", { name, error: String(error) });
        }
        processed = index + 1;
        persistLastFetched(ctx.dataDir, "pypi", lastFetched);
        persistEntityCache(ctx.dataDir, "pypi", cache);
        if ((index + 1) % 50 === 0 || index + 1 === dueKeys.length) {
          ctx.log.info("pypi progress", { done: index + 1, total: dueKeys.length, fetchedThisRun });
        }
      }
    } catch (error) {
      if (
        error instanceof HttpError &&
        (error.status === 429 || error.status === 403 || error.cloudflare) &&
        (fetchedThisRun > 0 || Object.keys(cache).length > 0)
      ) {
        truncated = true;
        stoppedAt = sourceStoppedAt("pypi", error, { page: fetchedThisRun + 1 });
        ctx.log.warn("pypi stopped early after rate limit; keeping partial snapshot", {
          fetchedThisRun,
          requested: allKeys.length,
          due: dueKeys.length,
          error: stoppedAt.error,
        });
      } else {
        throw error;
      }
    }

    ctx.log.info("pypi collected", {
      requested: allKeys.length,
      due: dueKeys.length,
      fetchedThisRun,
      fetchedShare: computeFetchedShare(fetchedThisRun, allKeys.length),
      truncated,
    });
    return finish({ truncated, fetchedThisRun, processed, stoppedAt });
  },
};
