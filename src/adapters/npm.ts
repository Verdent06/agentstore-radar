import { z } from "zod";
import { NPM_BULK_LIMIT, NPM_BULK_MIN_INTERVAL_MS, NPM_DOWNLOADS_BASE, NPM_SCOPED_MIN_INTERVAL_MS } from "../lib/config.ts";
import { computeCoverage } from "../lib/coverage.ts";
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
  prioritizeKeys,
  resumeDailyDueKeys,
} from "../lib/rolling.ts";
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
      records.push(withObservation(row, fetchedAt, isCarriedForward(fetchedAt, snapshotDate, collectedAt)));
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
    const dueKeys = prioritizeKeys(unorderedDue, (key) => cachedDownloads(cache[key]));
    const fetchedAt = ctx.collectedAt;
    const sleepFn = ctx.sleep ?? defaultSleep;

    const finish = (input: {
      truncated: boolean;
      fetchedThisRun: number;
      processed?: number;
      stoppedAt?: SourceResult["stoppedAt"];
    }): SourceResult => {
      const records = recordsFromCache(ctx.snapshotDate, allKeys, cache, lastFetched, fetchedAt);
      const freshTodayCount = countFreshToday(allKeys, lastFetched, ctx.snapshotDate);
      const freshWithin7dCount = countFresh(allKeys, lastFetched, ctx.now);
      const { coverage } = computeCoverage(allKeys.length, freshTodayCount);
      persistLastFetched(ctx.dataDir, "npm", lastFetched);
      persistEntityCache(ctx.dataDir, "npm", cache);
      if (input.truncated) {
        persistCheckpoint(ctx.dataDir, "npm", {
          snapshotDate: ctx.snapshotDate,
          dueKeys,
          nextIndex: Math.min(dueKeys.length, input.processed ?? input.fetchedThisRun),
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
    const scoped = dueKeys.filter(isScopedNpmPackage);
    const unscoped = dueKeys.filter((name) => !isScopedNpmPackage(name));
    ctx.log.info("npm fetching downloads", {
      requested: allKeys.length,
      due: dueKeys.length,
      unscoped: unscoped.length,
      scoped: scoped.length,
      resumed,
    });

    let fetchedThisRun = 0;
    let truncated = false;
    let processed = 0;
    let stoppedAt: SourceResult["stoppedAt"];

    const fetchNpm = async (url: string, minIntervalMs: number): Promise<unknown> =>
      fetchJsonWithRateLimitWait<unknown>(ctx.http, url, {
        sleep: sleepFn,
        init: { minIntervalMs },
        onWait(waitMs, attempt, error) {
          ctx.log.warn("npm waiting out rate limit", {
            waitMs,
            attempt,
            status: error.status,
            cloudflare: error.cloudflare,
          });
        },
      });

    try {
      const batches = chunk(unscoped, NPM_BULK_LIMIT);
      for (const [index, batch] of batches.entries()) {
        persistCheckpoint(ctx.dataDir, "npm", {
          snapshotDate: ctx.snapshotDate,
          dueKeys,
          nextIndex: processed,
          startedAt: checkpoint?.startedAt ?? fetchedAt,
        });
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

      for (const name of scoped) {
        persistCheckpoint(ctx.dataDir, "npm", {
          snapshotDate: ctx.snapshotDate,
          dueKeys,
          nextIndex: processed,
          startedAt: checkpoint?.startedAt ?? fetchedAt,
        });
        try {
          const payload = await fetchNpm(npmScopedUrl(name), NPM_SCOPED_MIN_INTERVAL_MS);
          if (rememberPoint(cache, lastFetched, name, payload, fetchedAt)) {
            fetchedThisRun += 1;
          }
        } catch (error) {
          if (error instanceof HttpError && (error.status === 429 || error.status === 403 || error.cloudflare)) {
            throw error;
          }
          ctx.log.warn("npm scoped package fetch failed", { name, error: String(error) });
        }
        processed += 1;
        persistLastFetched(ctx.dataDir, "npm", lastFetched);
        persistEntityCache(ctx.dataDir, "npm", cache);
      }
    } catch (error) {
      if (
        error instanceof HttpError &&
        (error.status === 429 || error.status === 403 || error.cloudflare) &&
        (fetchedThisRun > 0 || Object.keys(cache).length > 0)
      ) {
        truncated = true;
        stoppedAt = sourceStoppedAt("npm", error, { page: Math.floor(processed / Math.max(NPM_BULK_LIMIT, 1)) + 1 });
        ctx.log.warn("npm stopped early after rate limit; keeping partial snapshot", {
          fetchedThisRun,
          processed,
          requested: allKeys.length,
          due: dueKeys.length,
          error: stoppedAt.error,
        });
      } else {
        throw error;
      }
    }

    ctx.log.info("npm collected", { requested: allKeys.length, due: dueKeys.length, fetchedThisRun, truncated });
    return finish({ truncated, fetchedThisRun, processed, stoppedAt });
  },
};
