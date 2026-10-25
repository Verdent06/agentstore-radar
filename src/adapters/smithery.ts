import { z } from "zod";
import { SMITHERY_FROZEN_DAYS, SMITHERY_SERVERS_URL, SMITHERY_STABLE_SEED, SMITHERY_USECOUNT_PAGE_SIZE, SOURCE_FREEZE_RATIO } from "../lib/config.ts";
import { computeCoverage } from "../lib/coverage.ts";
import { evaluateSourceFreeze, isUnchangedForDays, loadPreviousMetricHistory, smitheryFrozenDays } from "../lib/frozen.ts";
import { fetchJsonWithRateLimitWait, HttpError } from "../lib/http.ts";
import { appIdFromIdentity, githubRepoUrl, parseGithubRepo } from "../lib/matching.ts";
import {
  clearCheckpoint,
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
import { errorMessage, sleep as defaultSleep } from "../lib/util.ts";
import { CollectSourceError, sourceStoppedAt, type CollectContext, type SourceAdapter, type SourceResult } from "./types.ts";

const ServerSchema = z
  .object({
    id: z.string().nullish(),
    qualifiedName: z.string(),
    namespace: z.string().nullish(),
    slug: z.string().nullish(),
    displayName: z.string().nullish(),
    description: z.string().nullish(),
    homepage: z.string().nullish(),
    useCount: z.number().nullish(),
    verified: z.boolean().nullish(),
    remote: z.boolean().nullish(),
    isDeployed: z.boolean().nullish(),
    createdAt: z.string().nullish(),
    repositoryUrl: z.string().nullish(),
  })
  .passthrough();

const ListResponseSchema = z
  .object({
    servers: z.array(z.unknown()),
    pagination: z
      .object({
        currentPage: z.number(),
        pageSize: z.number(),
        totalPages: z.number(),
        totalCount: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type SmitheryRawSnapshot = {
  endpoint: string;
  fetchedAt: string;
  seed: number;
  pages: number;
  totalCount?: number;
  servers: unknown[];
  useCountRefresh?: {
    endpoint: string;
    attempted: number;
    updated: number;
    unchanged: number;
    missed: number;
    frozen: number;
    truncated: boolean;
    frozenDays: number;
    sourceFrozen: boolean;
    freezeRatio: number;
  };
};

export type SmitheryUseCountCache = {
  useCount: number | null;
};

export function smitheryUseCountSearchUrl(qualifiedName: string): string {
  const url = new URL(SMITHERY_SERVERS_URL);
  url.searchParams.set("q", qualifiedName);
  url.searchParams.set("pageSize", String(SMITHERY_USECOUNT_PAGE_SIZE));
  return url.toString();
}

function listUseCount(item: unknown): number {
  const parsed = ServerSchema.safeParse(item);
  return parsed.success && typeof parsed.data.useCount === "number" ? parsed.data.useCount : 0;
}

function overlayUseCount(item: unknown, useCount: number | null): unknown {
  if (!item || typeof item !== "object") {
    return item;
  }
  return { ...item, useCount };
}

function searchUseCount(payload: unknown, qualifiedName: string): number | null | undefined {
  const parsed = ListResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return undefined;
  }
  const match = parsed.data.servers
    .map((item) => ServerSchema.safeParse(item))
    .find((item) => item.success && item.data.qualifiedName === qualifiedName);
  if (!match?.success) {
    return undefined;
  }
  return match.data.useCount ?? null;
}

export function normalizeSmitheryServer(snapshotDate: string, item: unknown): SourceRow | null {
  const parsed = ServerSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const server = parsed.data;
  const repo = parseGithubRepo(server.repositoryUrl ?? undefined) ?? parseGithubRepo(server.homepage ?? undefined);
  const repoUrl = repo ? githubRepoUrl(repo) : (server.repositoryUrl ?? null);
  return emptySourceRow({
    snapshot_date: snapshotDate,
    source: "smithery",
    source_id: server.qualifiedName,
    name: server.qualifiedName,
    display_name: server.displayName ?? null,
    description: server.description ?? null,
    homepage: server.homepage ?? null,
    repo_url: repoUrl,
    use_count: server.useCount ?? null,
    verified: server.verified ?? null,
    app_id: appIdFromIdentity({
      repoUrl,
      source: "smithery",
      sourceId: server.qualifiedName,
    }),
  });
}

export const smitheryAdapter: SourceAdapter = {
  name: "smithery",
  kind: "catalog",
  async collect(ctx: CollectContext): Promise<SourceResult> {
    const apiKey = ctx.env.SMITHERY_API_KEY;
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const servers: unknown[] = [];
    let pages = 0;
    let page = 1;
    let totalCount: number | undefined;
    let truncated = false;
    let stoppedAt: SourceResult["stoppedAt"];
    const maxPages = ctx.maxPages ?? Number.POSITIVE_INFINITY;

    try {
      let totalPages = 1;
      while (page <= totalPages && pages < maxPages) {
        const url = new URL(SMITHERY_SERVERS_URL);
        url.searchParams.set("page", String(page));
        url.searchParams.set("pageSize", "100");
        // Official list API caps search-index windows at topK=500. Passing a
        // stable seed unlocks deterministic deep pagination of the full catalog.
        url.searchParams.set("seed", String(SMITHERY_STABLE_SEED));
        const payload = ListResponseSchema.parse(
          await ctx.http.fetchJson<unknown>(url.toString(), { headers }),
        );
        pages += 1;
        totalPages = payload.pagination.totalPages;
        totalCount = payload.pagination.totalCount;
        servers.push(...payload.servers);
        page += 1;
        if (payload.servers.length === 0) {
          break;
        }
      }
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403) && !apiKey) {
        ctx.log.warn("smithery skipped: public list rejected auth and SMITHERY_API_KEY is unset");
        return {
          source: "smithery",
          collectedAt: ctx.collectedAt,
          rowCount: 0,
          skipped: true,
          skipReason: "SMITHERY_API_KEY not set and public list returned 401/403",
          raw: { skipped: true },
          records: [],
        };
      }
      stoppedAt = sourceStoppedAt("smithery", error, { page });
      if (servers.length === 0) {
        throw new CollectSourceError(stoppedAt);
      }
      truncated = true;
      ctx.log.warn("smithery stopped early; keeping partial catalog", {
        pages,
        rows: servers.length,
        page: stoppedAt.page,
        error: stoppedAt.error,
      });
    }

    const lastFetched = loadLastFetched(ctx.dataDir, "smithery");
    const cache = loadEntityCache<SmitheryUseCountCache>(ctx.dataDir, "smithery");
    const checkpoint = loadCheckpoint(ctx.dataDir, "smithery");
    const sleepFn = ctx.sleep ?? defaultSleep;
    const fetchedAt = ctx.collectedAt;
    const frozenDays = smitheryFrozenDays(ctx.env, SMITHERY_FROZEN_DAYS);
    const previous = loadPreviousMetricHistory(ctx.dataDir, ctx.snapshotDate, "smithery", "use_count", frozenDays);

    const parsedServers = servers.map((item, index) => ({ item, index, parsed: ServerSchema.safeParse(item) }));
    const indexesByName = new Map<string, number[]>();
    const listCountByName = new Map<string, number>();
    const allKeys: string[] = [];
    for (const row of parsedServers) {
      if (!row.parsed.success) {
        continue;
      }
      const name = row.parsed.data.qualifiedName;
      if (!indexesByName.has(name)) {
        allKeys.push(name);
        listCountByName.set(name, listUseCount(row.item));
      }
      const indexes = indexesByName.get(name) ?? [];
      indexes.push(row.index);
      indexesByName.set(name, indexes);
    }
    const { dueKeys: unorderedDue, resumed } = resumeDailyDueKeys(allKeys, lastFetched, ctx.snapshotDate, checkpoint);
    const dueKeys = prioritizeKeys(unorderedDue, (key) => {
      const cached = cache[key]?.useCount;
      if (typeof cached === "number") {
        return cached;
      }
      return listCountByName.get(key) ?? 0;
    });

    let useCountAttempted = 0;
    let useCountUpdated = 0;
    let useCountUnchanged = 0;
    let useCountMissed = 0;
    let useCountTruncated = false;
    let processed = 0;
    const fetchedThisRunNames = new Set<string>();

    ctx.log.info("smithery refreshing useCount via search", {
      catalog: allKeys.length,
      due: dueKeys.length,
      resumed,
    });

    try {
      for (const [index, name] of dueKeys.entries()) {
        persistCheckpoint(ctx.dataDir, "smithery", {
          snapshotDate: ctx.snapshotDate,
          dueKeys,
          nextIndex: index,
          startedAt: checkpoint?.startedAt ?? fetchedAt,
        });
        useCountAttempted += 1;
        try {
          const payload = await fetchJsonWithRateLimitWait<unknown>(ctx.http, smitheryUseCountSearchUrl(name), {
            sleep: sleepFn,
            init: { headers },
            onWait(waitMs, attempt, error) {
              ctx.log.warn("smithery waiting out rate limit", { waitMs, attempt, status: error.status, name });
            },
          });
          const live = searchUseCount(payload, name);
          if (live === undefined) {
            useCountMissed += 1;
          } else {
            const previousValue = cache[name]?.useCount;
            cache[name] = { useCount: live };
            lastFetched[name] = fetchedAt;
            fetchedThisRunNames.add(name);
            if (previousValue === live) {
              useCountUnchanged += 1;
            } else {
              useCountUpdated += 1;
            }
            for (const serverIndex of indexesByName.get(name) ?? []) {
              servers[serverIndex] = overlayUseCount(servers[serverIndex], live);
            }
          }
        } catch (error) {
          if (error instanceof HttpError && (error.status === 429 || error.status === 403 || error.cloudflare)) {
            throw error;
          }
          useCountMissed += 1;
          ctx.log.warn("smithery useCount search failed", { name, error: String(error) });
        }
        processed = index + 1;
        persistLastFetched(ctx.dataDir, "smithery", lastFetched);
        persistEntityCache(ctx.dataDir, "smithery", cache);
        if ((index + 1) % 500 === 0 || index + 1 === dueKeys.length) {
          ctx.log.info("smithery useCount progress", {
            done: index + 1,
            total: dueKeys.length,
            updated: useCountUpdated,
            missed: useCountMissed,
          });
        }
      }
      clearCheckpoint(ctx.dataDir, "smithery");
    } catch (error) {
      const rateLimited =
        error instanceof HttpError && (error.status === 429 || error.status === 403 || error.cloudflare);
      if (rateLimited || useCountAttempted > 0) {
        useCountTruncated = true;
        persistCheckpoint(ctx.dataDir, "smithery", {
          snapshotDate: ctx.snapshotDate,
          dueKeys,
          nextIndex: processed,
          startedAt: checkpoint?.startedAt ?? fetchedAt,
        });
        ctx.log.warn(
          rateLimited
            ? "smithery useCount refresh stopped after rate limit; keeping search hits and list fallback"
            : "smithery useCount refresh stopped; keeping search hits and list fallback",
          {
            attempted: useCountAttempted,
            updated: useCountUpdated,
            error: rateLimited ? errorMessage(error) : String(error),
          },
        );
      } else {
        ctx.log.warn("smithery useCount refresh failed; stamping list useCount as not live", { error: String(error) });
      }
    }

    const unchangedByName = new Map<string, boolean>();
    for (const name of allKeys) {
      const useCount = cache[name]?.useCount ?? listCountByName.get(name) ?? null;
      unchangedByName.set(
        name,
        isUnchangedForDays(useCount, previous.byId.get(name) ?? [], previous.dates, frozenDays),
      );
    }
    const freeze = evaluateSourceFreeze(
      allKeys.map((name) => unchangedByName.get(name) === true),
      SOURCE_FREEZE_RATIO,
    );
    const frozenByName = new Map(allKeys.map((name, index) => [name, freeze.freezeRow[index] === true]));

    const records: SourceRow[] = [];
    let invalid = 0;
    let frozenCount = 0;
    for (const item of servers) {
      const parsed = ServerSchema.safeParse(item);
      if (!parsed.success) {
        invalid += 1;
        continue;
      }
      const name = parsed.data.qualifiedName;
      const cached = cache[name];
      const fetched = lastFetched[name];
      const useCount = cached?.useCount ?? parsed.data.useCount ?? null;
      const frozen = frozenByName.get(name) === true;
      // Search hits are not fresh while the catalog is source-frozen.
      const liveToday =
        Boolean(fetched && !isCarriedForward(fetched, ctx.snapshotDate, fetchedAt) && cached) && !frozen;
      const row = normalizeSmitheryServer(ctx.snapshotDate, overlayUseCount(item, useCount));
      if (!row) {
        invalid += 1;
        continue;
      }
      const previousFetchedAt = previous.byId.get(name)?.at(-1)?.fetchedAt ?? null;
      const observationAt = liveToday ? fetchedAt : frozen ? (previousFetchedAt ?? fetched ?? null) : (fetched ?? null);
      if (frozen) {
        frozenCount += 1;
      }
      records.push(withObservation(row, observationAt, !liveToday, frozen));
      if (row.repo_url) {
        const ref = parseGithubRepo(row.repo_url);
        if (ref) {
          ctx.discovered.githubRepos.set(`${ref.owner}/${ref.repo}`, ref);
        }
      }
    }
    if (invalid > 0) {
      ctx.log.warn("smithery dropped invalid rows", { invalid, total: servers.length });
    }
    if (servers.length > 0 && invalid / servers.length > 0.5) {
      throw new Error(`smithery validation failed for ${invalid}/${servers.length} rows`);
    }

    const fetchedThisRunCount = [...fetchedThisRunNames].filter((name) => frozenByName.get(name) !== true).length;
    const freshTodayCount = records.filter((row) => row.carried_forward !== true).length;
    const { coverage } = computeCoverage(records.length, freshTodayCount);
    if (freeze.sourceFrozen) {
      ctx.log.warn("smithery useCount source-frozen; stamping unchanged rows frozen/carried_forward, not fresh", {
        frozen: frozenCount,
        rows: records.length,
        frozenDays,
        unchanged: freeze.unchangedCount,
        ratio: freeze.ratio,
      });
    }
    ctx.log.info("smithery collected", {
      pages,
      rows: records.length,
      totalCount,
      truncated: truncated || useCountTruncated,
      useCountAttempted,
      useCountUpdated,
      useCountUnchanged,
      fetchedThisRunCount,
      frozenCount,
      sourceFrozen: freeze.sourceFrozen,
      useCountTruncated,
    });
    const raw: SmitheryRawSnapshot = {
      endpoint: SMITHERY_SERVERS_URL,
      fetchedAt: ctx.collectedAt,
      seed: SMITHERY_STABLE_SEED,
      pages,
      totalCount,
      servers,
      useCountRefresh: {
        endpoint: `${SMITHERY_SERVERS_URL}?q=`,
        attempted: useCountAttempted,
        updated: useCountUpdated,
        unchanged: useCountUnchanged,
        missed: useCountMissed,
        frozen: frozenCount,
        truncated: useCountTruncated,
        frozenDays,
        sourceFrozen: freeze.sourceFrozen,
        freezeRatio: freeze.ratio,
      },
    };
    return {
      source: "smithery",
      collectedAt: ctx.collectedAt,
      rowCount: records.length,
      skipped: false,
      truncated: truncated || useCountTruncated,
      failed: false,
      error: stoppedAt?.error,
      stoppedAt,
      eligibleCount: records.length,
      fetchedThisRunCount,
      freshTodayCount,
      coverage,
      raw,
      records,
    };
  },
};
