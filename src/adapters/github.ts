import { z } from "zod";
import { GITHUB_GRAPHQL_BATCH, GITHUB_GRAPHQL_URL, GITHUB_RUN_BATCH, MAX_RATE_LIMIT_WAIT_MS, runBatchSize } from "../lib/config.ts";
import { computeCoverage, computeFetchedShare } from "../lib/coverage.ts";
import { HttpError } from "../lib/http.ts";
import { appIdFromIdentity, type GithubRepoRef } from "../lib/matching.ts";
import type { SleepFn } from "../lib/retry.ts";
import {
  clearCheckpoint,
  countFresh,
  countFreshToday,
  isCarriedForward,
  isDueUnresolved,
  loadCheckpoint,
  loadEntityCache,
  loadLastFetched,
  loadUnresolved,
  persistCheckpoint,
  persistEntityCache,
  persistLastFetched,
  persistUnresolved,
  resumeDailyDueKeys,
  selectRunBatch,
} from "../lib/rolling.ts";
import { emptySourceRow, withObservation, type SourceRow } from "../lib/schema.ts";
import { chunk, sleep as defaultSleep } from "../lib/util.ts";
import { sourceStoppedAt, type CollectContext, type SourceAdapter, type SourceResult } from "./types.ts";

const RepoNodeSchema = z
  .object({
    nameWithOwner: z.string(),
    url: z.string(),
    stargazerCount: z.number(),
    forkCount: z.number(),
    pushedAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    issues: z.object({ totalCount: z.number() }).nullable().optional(),
    isArchived: z.boolean().optional(),
  })
  .passthrough();

const RateLimitSchema = z
  .object({
    remaining: z.number(),
    resetAt: z.string(),
    cost: z.number().optional(),
  })
  .passthrough();

const GraphqlErrorSchema = z
  .object({
    message: z.string(),
    type: z.string().optional(),
    path: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .passthrough();

const GraphqlResponseSchema = z.object({
  data: z.record(z.unknown()).nullable().optional(),
  errors: z.array(GraphqlErrorSchema).optional(),
});

export function isUnresolvedRepositoryError(error: { message: string; type?: string }): boolean {
  if (error.type === "NOT_FOUND") {
    return true;
  }
  return /could not resolve to a repository/i.test(error.message) || /could not resolve repository/i.test(error.message);
}

export function repoNameFromGraphqlError(
  error: { message: string; path?: Array<string | number> },
  batch: GithubRepoRef[],
): string | undefined {
  const alias = typeof error.path?.[0] === "string" ? error.path[0] : undefined;
  if (alias && /^r\d+$/.test(alias)) {
    const ref = batch[Number(alias.slice(1))];
    if (ref) {
      return `${ref.owner}/${ref.repo}`;
    }
  }
  return error.message.match(/name '([^']+)'/i)?.[1];
}

export type GithubRawSnapshot = {
  endpoint: string;
  fetchedAt: string;
  requested: number;
  fetchedThisRun: number;
  truncated?: boolean;
  resumed?: boolean;
  repositories: unknown[];
  unresolvedRepos?: string[];
  unresolvedCount?: number;
};

export function githubStatsToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.GH_STATS_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  return token || undefined;
}

export function buildGithubGraphqlQuery(batch: GithubRepoRef[]): string {
  const fields = `
    nameWithOwner
    url
    stargazerCount
    forkCount
    pushedAt
    updatedAt
    isArchived
    issues(states: OPEN) { totalCount }
  `;
  const selections = batch.map((ref, index) => {
    const owner = JSON.stringify(ref.owner);
    const name = JSON.stringify(ref.repo);
    return `r${index}: repository(owner: ${owner}, name: ${name}) { ${fields} }`;
  });
  return `query { ${selections.join("\n")} rateLimit { remaining resetAt cost } }`;
}

export function normalizeGithubRepo(snapshotDate: string, item: unknown, requested?: GithubRepoRef): SourceRow | null {
  const parsed = RepoNodeSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const repo = parsed.data;
  const identity = requested ?? {
    owner: repo.nameWithOwner.split("/")[0] ?? repo.nameWithOwner,
    repo: repo.nameWithOwner.split("/")[1] ?? repo.nameWithOwner,
  };
  const sourceId = `${identity.owner}/${identity.repo}`.toLowerCase();
  const repoUrl = requested ? `https://github.com/${identity.owner}/${identity.repo}` : repo.url;
  return emptySourceRow({
    snapshot_date: snapshotDate,
    source: "github",
    source_id: sourceId,
    name: repo.nameWithOwner,
    display_name: repo.nameWithOwner,
    homepage: repo.url,
    repo_url: repoUrl,
    stars: repo.stargazerCount,
    forks: repo.forkCount,
    open_issues: repo.issues?.totalCount ?? null,
    pushed_at: repo.pushedAt ?? repo.updatedAt ?? null,
    status: repo.isArchived ? "archived" : "active",
    app_id: appIdFromIdentity({
      repoUrl,
      source: "github",
      sourceId,
    }),
  });
}

function isGraphqlRateLimit(errors: Array<{ message: string }> | undefined): boolean {
  return Boolean(errors?.some((error) => /rate limit/i.test(error.message)));
}

async function waitForGraphqlBudget(
  rateLimit: z.infer<typeof RateLimitSchema> | undefined,
  log: CollectContext["log"],
  sleepFn: SleepFn,
): Promise<void> {
  if (!rateLimit || rateLimit.remaining >= GITHUB_GRAPHQL_BATCH) {
    return;
  }
  const resetAt = Date.parse(rateLimit.resetAt);
  if (Number.isNaN(resetAt)) {
    return;
  }
  const waitMs = resetAt - Date.now() + 1000;
  if (waitMs <= 0) {
    return;
  }
  if (waitMs > MAX_RATE_LIMIT_WAIT_MS) {
    throw new HttpError(GITHUB_GRAPHQL_URL, 403, "GitHub GraphQL primary rate limit reset is too far away", {
      resetAt,
      remaining: rateLimit.remaining,
    });
  }
  log.warn("github waiting for GraphQL rate limit reset", {
    remaining: rateLimit.remaining,
    resetAt: rateLimit.resetAt,
    waitMs,
  });
  await sleepFn(waitMs);
}

function cachedStars(item: unknown): number {
  if (item && typeof item === "object" && "stargazerCount" in item && typeof item.stargazerCount === "number") {
    return item.stargazerCount;
  }
  return 0;
}

function refFromKey(key: string): GithubRepoRef | undefined {
  const [owner, repo] = key.split("/");
  if (!owner || !repo) {
    return undefined;
  }
  return { owner, repo };
}

function recordsFromCache(
  snapshotDate: string,
  keys: string[],
  cache: Record<string, unknown>,
  lastFetched: Record<string, string>,
  collectedAt: string,
  unresolvedKeys: Set<string> = new Set(),
): SourceRow[] {
  const records: SourceRow[] = [];
  for (const key of keys) {
    const item = cache[key];
    if (item == null) {
      continue;
    }
    const row = normalizeGithubRepo(snapshotDate, item, refFromKey(key));
    if (row) {
      const fetchedAt = lastFetched[key] ?? null;
      const unresolved = unresolvedKeys.has(key);
      records.push(
        withObservation(row, fetchedAt, unresolved || isCarriedForward(fetchedAt, snapshotDate, collectedAt)),
      );
    }
  }
  return records;
}

export const githubAdapter: SourceAdapter = {
  name: "github",
  kind: "enrichment",
  async collect(ctx: CollectContext): Promise<SourceResult> {
    const token = githubStatsToken(ctx.env);
    const repos = [...ctx.discovered.githubRepos.entries()];
    const allKeys = repos.map(([key]) => key);
    const lastFetched = loadLastFetched(ctx.dataDir, "github");
    const cache = loadEntityCache(ctx.dataDir, "github");
    const checkpoint = loadCheckpoint(ctx.dataDir, "github");
    const { dueKeys: unorderedDue, resumed } = resumeDailyDueKeys(allKeys, lastFetched, ctx.snapshotDate, checkpoint);
    const unresolvedMap = loadUnresolved(ctx.dataDir, "github");
    const allKeySet = new Set(allKeys);
    for (const key of Object.keys(unresolvedMap)) {
      if (!allKeySet.has(key)) {
        delete unresolvedMap[key];
      }
    }
    const fetchDue = unorderedDue.filter((key) => isDueUnresolved(unresolvedMap[key], ctx.now));
    const dueKeys = selectRunBatch(
      fetchDue,
      lastFetched,
      runBatchSize(ctx.env, "RADAR_GITHUB_BATCH", GITHUB_RUN_BATCH),
      (key) => cachedStars(cache[key]),
    );
    const fetchedAt = ctx.collectedAt;
    const sleepFn = ctx.sleep ?? defaultSleep;
    const unresolvedRepos: string[] = [];
    const unresolvedKeys = new Set(Object.keys(unresolvedMap));

    const finish = (input: {
      skipped: boolean;
      skipReason?: string;
      truncated: boolean;
      fetchedThisRun: number;
      processed?: number;
      rawExtra?: Record<string, unknown>;
      stoppedAt?: SourceResult["stoppedAt"];
    }): SourceResult => {
      const records = recordsFromCache(ctx.snapshotDate, allKeys, cache, lastFetched, fetchedAt, unresolvedKeys);
      const countableKeys = allKeys.filter((key) => !unresolvedKeys.has(key));
      const freshTodayCount = countFreshToday(countableKeys, lastFetched, ctx.snapshotDate);
      const freshWithin7dCount = countFresh(countableKeys, lastFetched, ctx.now);
      const unresolvedCount = allKeys.filter((key) => unresolvedKeys.has(key)).length;
      const { coverage } = computeCoverage(allKeys.length, freshTodayCount);
      const fetchedShare = computeFetchedShare(input.fetchedThisRun, allKeys.length, unresolvedCount);
      const lastFetchedAt = Object.values(lastFetched).sort().at(-1);
      persistLastFetched(ctx.dataDir, "github", lastFetched);
      persistEntityCache(ctx.dataDir, "github", cache);
      const nextUnresolved: Record<string, string> = {};
      for (const key of unresolvedKeys) {
        nextUnresolved[key] = unresolvedMap[key] ?? fetchedAt;
      }
      persistUnresolved(ctx.dataDir, "github", nextUnresolved);
      if (input.truncated) {
        persistCheckpoint(ctx.dataDir, "github", {
          snapshotDate: ctx.snapshotDate,
          dueKeys,
          nextIndex: Math.min(dueKeys.length, input.processed ?? input.fetchedThisRun),
          startedAt: checkpoint?.startedAt ?? fetchedAt,
        });
      } else {
        clearCheckpoint(ctx.dataDir, "github");
      }
      return {
        source: "github",
        collectedAt: ctx.collectedAt,
        rowCount: records.length,
        skipped: input.skipped,
        skipReason: input.skipReason,
        truncated: input.truncated,
        eligibleCount: allKeys.length,
        freshTodayCount,
        freshWithin7dCount,
        fetchedThisRunCount: input.fetchedThisRun,
        fetchedShare,
        coverage,
        lastFetchedAt,
        unresolvedCount,
        unresolvedRepos: unresolvedRepos.length > 0 ? unresolvedRepos : undefined,
        stoppedAt: input.stoppedAt,
        error: input.stoppedAt?.error,
        raw: {
          endpoint: GITHUB_GRAPHQL_URL,
          fetchedAt,
          requested: allKeys.length,
          fetchedThisRun: input.fetchedThisRun,
          truncated: input.truncated,
          resumed,
          repositories: allKeys.map((key) => cache[key]).filter((item) => item != null),
          ...input.rawExtra,
          ...(unresolvedCount > 0 ? { unresolvedRepos, unresolvedCount } : {}),
        } satisfies GithubRawSnapshot,
        records,
      };
    };

    if (!token) {
      ctx.log.warn("github skipped: no GH_STATS_TOKEN/GITHUB_TOKEN");
      if (allKeys.length === 0 || Object.keys(cache).length === 0) {
        return {
          source: "github",
          collectedAt: ctx.collectedAt,
          rowCount: 0,
          skipped: true,
          skipReason: "GITHUB_TOKEN not set",
          eligibleCount: allKeys.length,
          freshTodayCount: 0,
          freshWithin7dCount: 0,
          fetchedThisRunCount: 0,
          coverage: allKeys.length === 0 ? 1 : 0,
          raw: { skipped: true, requested: allKeys.length },
          records: [],
        };
      }
      return finish({ skipped: false, truncated: dueKeys.length > 0, fetchedThisRun: 0 });
    }
    if (allKeys.length === 0) {
      return finish({ skipped: false, truncated: false, fetchedThisRun: 0 });
    }

    ctx.log.info("github fetching repositories", {
      requested: allKeys.length,
      due: unorderedDue.length,
      fetchDue: fetchDue.length,
      knownUnresolved: unresolvedKeys.size,
      batch: dueKeys.length,
      resumed,
      batches: Math.ceil(dueKeys.length / GITHUB_GRAPHQL_BATCH),
    });

    let fetchedThisRun = 0;
    let processed = 0;
    let truncated = false;
    let stoppedAt: SourceResult["stoppedAt"];
    const dueRefs = dueKeys
      .map((key) => ctx.discovered.githubRepos.get(key))
      .filter((ref): ref is GithubRepoRef => Boolean(ref));
    const batches = chunk(dueRefs, GITHUB_GRAPHQL_BATCH);

    try {
      for (const [index, batch] of batches.entries()) {
        persistCheckpoint(ctx.dataDir, "github", {
          snapshotDate: ctx.snapshotDate,
          dueKeys,
          nextIndex: processed,
          startedAt: checkpoint?.startedAt ?? fetchedAt,
        });
        const payload = GraphqlResponseSchema.parse(
          await ctx.http.fetchJson<unknown>(GITHUB_GRAPHQL_URL, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ query: buildGithubGraphqlQuery(batch) }),
          }),
        );
        const errors = payload.errors ?? [];
        const unresolved = errors.filter(isUnresolvedRepositoryError);
        const otherErrors = errors.filter((error) => !isUnresolvedRepositoryError(error));
        for (const error of unresolved) {
          const repo = repoNameFromGraphqlError(error, batch) ?? error.message;
          unresolvedRepos.push(repo);
          const alias = typeof error.path?.[0] === "string" ? error.path[0] : undefined;
          const aliasIndex = alias && /^r\d+$/.test(alias) ? Number(alias.slice(1)) : Number.NaN;
          const requested = Number.isInteger(aliasIndex) ? batch[aliasIndex] : undefined;
          const key = requested ? `${requested.owner}/${requested.repo}`.toLowerCase() : repo.toLowerCase();
          unresolvedKeys.add(key);
          unresolvedMap[key] = fetchedAt;
          ctx.log.warn("github could not resolve repository", { repo, error: error.message });
        }
        if (isGraphqlRateLimit(otherErrors) && !payload.data) {
          throw new HttpError(GITHUB_GRAPHQL_URL, 403, otherErrors.map((err) => err.message).join("; ") || "rate limit");
        }
        if (otherErrors.length && !payload.data) {
          throw new Error(`GitHub GraphQL errors: ${otherErrors.map((err) => err.message).join("; ")}`);
        }
        if (otherErrors.length && payload.data) {
          ctx.log.warn("github GraphQL errors", {
            batch: index + 1,
            count: otherErrors.length,
            sample: otherErrors[0]?.message,
          });
        }
        let rateLimit: z.infer<typeof RateLimitSchema> | undefined;
        if (payload.data) {
          for (const [alias, node] of Object.entries(payload.data)) {
            if (alias === "rateLimit") {
              const parsed = RateLimitSchema.safeParse(node);
              if (parsed.success) {
                rateLimit = parsed.data;
              }
              continue;
            }
            if (!node || typeof node !== "object") {
              continue;
            }
            const parsed = RepoNodeSchema.safeParse(node);
            if (!parsed.success) {
              continue;
            }
            const aliasIndex = Number(alias.slice(1));
            const requested = Number.isInteger(aliasIndex) ? batch[aliasIndex] : undefined;
            const key = requested
              ? `${requested.owner}/${requested.repo}`.toLowerCase()
              : parsed.data.nameWithOwner.toLowerCase();
            cache[key] = parsed.data;
            lastFetched[key] = fetchedAt;
            unresolvedKeys.delete(key);
            delete unresolvedMap[key];
            fetchedThisRun += 1;
          }
        }
        processed += batch.length;
        persistLastFetched(ctx.dataDir, "github", lastFetched);
        persistEntityCache(ctx.dataDir, "github", cache);
        if ((index + 1) % 20 === 0 || index + 1 === batches.length) {
          ctx.log.info("github GraphQL progress", {
            batch: index + 1,
            batches: batches.length,
            fetchedThisRun,
            freshToday: countFreshToday(allKeys, lastFetched, ctx.snapshotDate),
          });
        }
        await waitForGraphqlBudget(rateLimit, ctx.log, sleepFn);
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 401 && fetchedThisRun === 0 && Object.keys(cache).length === 0) {
        ctx.log.warn("github skipped: GITHUB_TOKEN was rejected");
        return {
          source: "github",
          collectedAt: ctx.collectedAt,
          rowCount: 0,
          skipped: true,
          skipReason: "GITHUB_TOKEN rejected (HTTP 401)",
          eligibleCount: allKeys.length,
          freshTodayCount: 0,
          freshWithin7dCount: 0,
          fetchedThisRunCount: 0,
          coverage: allKeys.length === 0 ? 1 : 0,
          raw: { skipped: true, requested: allKeys.length },
          records: [],
        };
      }
      if (
        error instanceof HttpError &&
        (error.status === 403 || error.status === 429 || error.cloudflare) &&
        (fetchedThisRun > 0 || Object.keys(cache).length > 0)
      ) {
        truncated = true;
        stoppedAt = sourceStoppedAt("github", error, { page: Math.floor(processed / GITHUB_GRAPHQL_BATCH) + 1 });
        ctx.log.warn("github stopped early after rate limit; keeping partial snapshot", {
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

    ctx.log.info("github collected", {
      requested: allKeys.length,
      due: dueKeys.length,
      fetchedThisRun,
      fetchedShare: computeFetchedShare(fetchedThisRun, allKeys.length, unresolvedKeys.size),
      truncated,
      unresolved: unresolvedKeys.size,
      unresolvedThisRun: unresolvedRepos.length,
    });
    return finish({
      skipped: false,
      truncated,
      fetchedThisRun,
      processed,
      stoppedAt,
    });
  },
};
