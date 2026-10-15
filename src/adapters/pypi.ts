import { z } from "zod";
import { PYPISTATS_BASE } from "../lib/config.ts";
import { computeCoverage } from "../lib/coverage.ts";
import { HttpError } from "../lib/http.ts";
import { appIdFromIdentity, normalizePackageName } from "../lib/matching.ts";
import {
  clearCheckpoint,
  countFresh,
  loadCheckpoint,
  loadEntityCache,
  loadLastFetched,
  persistCheckpoint,
  persistEntityCache,
  persistLastFetched,
  resumeDueKeys,
} from "../lib/rolling.ts";
import { emptySourceRow, type SourceRow } from "../lib/schema.ts";
import type { CollectContext, SourceAdapter, SourceResult } from "./types.ts";

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

function recordsFromCache(snapshotDate: string, keys: string[], cache: Record<string, unknown>): SourceRow[] {
  const records: SourceRow[] = [];
  for (const name of keys) {
    const item = cache[name];
    if (item == null) {
      continue;
    }
    const row = normalizePypiRecent(snapshotDate, name, item);
    if (row) {
      records.push(row);
    }
  }
  return records;
}

export const pypiAdapter: SourceAdapter = {
  name: "pypi",
  kind: "enrichment",
  async collect(ctx: CollectContext): Promise<SourceResult> {
    const allKeys = [...ctx.discovered.pypiPackages].sort();
    const lastFetched = loadLastFetched(ctx.dataDir, "pypi");
    const cache = loadEntityCache(ctx.dataDir, "pypi");
    const checkpoint = loadCheckpoint(ctx.dataDir, "pypi");
    const { dueKeys, resumed } = resumeDueKeys(allKeys, lastFetched, ctx.now, ctx.snapshotDate, checkpoint);
    const fetchedAt = ctx.collectedAt;

    const finish = (input: { truncated: boolean; fetchedThisRun: number }): SourceResult => {
      const records = recordsFromCache(ctx.snapshotDate, allKeys, cache);
      const fetchedCount = countFresh(allKeys, lastFetched, ctx.now);
      const { coverage } = computeCoverage(allKeys.length, fetchedCount);
      persistLastFetched(ctx.dataDir, "pypi", lastFetched);
      persistEntityCache(ctx.dataDir, "pypi", cache);
      if (input.truncated) {
        persistCheckpoint(ctx.dataDir, "pypi", {
          snapshotDate: ctx.snapshotDate,
          dueKeys,
          nextIndex: Math.min(dueKeys.length, input.fetchedThisRun),
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
        fetchedCount,
        coverage,
        lastFetchedAt: Object.values(lastFetched).sort().at(-1),
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
      due: dueKeys.length,
      resumed,
    });

    let fetchedThisRun = 0;
    let truncated = false;

    try {
      for (const [index, name] of dueKeys.entries()) {
        persistCheckpoint(ctx.dataDir, "pypi", {
          snapshotDate: ctx.snapshotDate,
          dueKeys,
          nextIndex: index,
          startedAt: checkpoint?.startedAt ?? fetchedAt,
        });
        try {
          const payload = await ctx.http.fetchJson<unknown>(pypiRecentUrl(name));
          if (RecentSchema.safeParse(payload).success) {
            cache[name] = payload;
            lastFetched[name] = fetchedAt;
            fetchedThisRun += 1;
          }
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            lastFetched[name] = fetchedAt;
            continue;
          }
          if (error instanceof HttpError && (error.status === 429 || error.status === 403 || error.cloudflare)) {
            throw error;
          }
          ctx.log.warn("pypi package fetch failed", { name, error: String(error) });
        }
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
        ctx.log.warn("pypi stopped early after rate limit; keeping partial snapshot", {
          fetchedThisRun,
          requested: allKeys.length,
          due: dueKeys.length,
        });
      } else {
        throw error;
      }
    }

    ctx.log.info("pypi collected", { requested: allKeys.length, due: dueKeys.length, fetchedThisRun, truncated });
    return finish({ truncated, fetchedThisRun });
  },
};
