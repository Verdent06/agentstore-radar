import { z } from "zod";
import { GITHUB_GRAPHQL_BATCH, GITHUB_GRAPHQL_URL, MAX_RATE_LIMIT_WAIT_MS } from "../lib/config.ts";
import { computeCoverage } from "../lib/coverage.ts";
import { HttpError } from "../lib/http.ts";
import { appIdFromIdentity, type GithubRepoRef } from "../lib/matching.ts";
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
import { chunk, sleep } from "../lib/util.ts";
import type { CollectContext, SourceAdapter, SourceResult } from "./types.ts";

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

const GraphqlResponseSchema = z.object({
  data: z.record(z.unknown()).nullable().optional(),
  errors: z
    .array(z.object({ message: z.string() }).passthrough())
    .optional(),
});

export type GithubRawSnapshot = {
  endpoint: string;
  fetchedAt: string;
  requested: number;
  fetchedThisRun: number;
  truncated?: boolean;
  resumed?: boolean;
  repositories: unknown[];
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

export function normalizeGithubRepo(snapshotDate: string, item: unknown): SourceRow | null {
  const parsed = RepoNodeSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const repo = parsed.data;
  return emptySourceRow({
    snapshot_date: snapshotDate,
    source: "github",
    source_id: repo.nameWithOwner.toLowerCase(),
    name: repo.nameWithOwner,
    display_name: repo.nameWithOwner,
    homepage: repo.url,
    repo_url: repo.url,
    stars: repo.stargazerCount,
    forks: repo.forkCount,
    open_issues: repo.issues?.totalCount ?? null,
    pushed_at: repo.pushedAt ?? repo.updatedAt ?? null,
    status: repo.isArchived ? "archived" : "active",
    app_id: appIdFromIdentity({
      repoUrl: repo.url,
      source: "github",
      sourceId: repo.nameWithOwner,
    }),
  });
}

function isGraphqlRateLimit(errors: Array<{ message: string }> | undefined): boolean {
  return Boolean(errors?.some((error) => /rate limit/i.test(error.message)));
}

async function waitForGraphqlBudget(
  rateLimit: z.infer<typeof RateLimitSchema> | undefined,
  log: CollectContext["log"],
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
  await sleep(waitMs);
}

function recordsFromCache(
  snapshotDate: string,
  keys: string[],
  cache: Record<string, unknown>,
): SourceRow[] {
  const records: SourceRow[] = [];
  for (const key of keys) {
    const item = cache[key];
    if (item == null) {
      continue;
    }
    const row = normalizeGithubRepo(snapshotDate, item);
    if (row) {
      records.push(row);
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
    const { dueKeys, resumed } = resumeDueKeys(allKeys, lastFetched, ctx.now, ctx.snapshotDate, checkpoint);
    const fetchedAt = ctx.collectedAt;

    const finish = (input: {
      skipped: boolean;
      skipReason?: string;
      truncated: boolean;
      fetchedThisRun: number;
      rawExtra?: Record<string, unknown>;
    }): SourceResult => {
      const records = recordsFromCache(ctx.snapshotDate, allKeys, cache);
      const fetchedCount = countFresh(allKeys, lastFetched, ctx.now);
      const { coverage } = computeCoverage(allKeys.length, fetchedCount);
      const lastFetchedAt = Object.values(lastFetched).sort().at(-1);
      persistLastFetched(ctx.dataDir, "github", lastFetched);
      persistEntityCache(ctx.dataDir, "github", cache);
      if (input.truncated) {
        persistCheckpoint(ctx.dataDir, "github", {
          snapshotDate: ctx.snapshotDate,
          dueKeys,
          nextIndex: Math.min(dueKeys.length, input.fetchedThisRun),
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
        fetchedCount,
        coverage,
        lastFetchedAt,
        raw: {
          endpoint: GITHUB_GRAPHQL_URL,
          fetchedAt,
          requested: allKeys.length,
          fetchedThisRun: input.fetchedThisRun,
          truncated: input.truncated,
          resumed,
          repositories: allKeys.map((key) => cache[key]).filter((item) => item != null),
          ...input.rawExtra,
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
          fetchedCount: 0,
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
      due: dueKeys.length,
      resumed,
      batches: Math.ceil(dueKeys.length / GITHUB_GRAPHQL_BATCH),
    });

    let fetchedThisRun = 0;
    let truncated = false;
    const dueRefs = dueKeys
      .map((key) => ctx.discovered.githubRepos.get(key))
      .filter((ref): ref is GithubRepoRef => Boolean(ref));
    const batches = chunk(dueRefs, GITHUB_GRAPHQL_BATCH);

    try {
      for (const [index, batch] of batches.entries()) {
        persistCheckpoint(ctx.dataDir, "github", {
          snapshotDate: ctx.snapshotDate,
          dueKeys,
          nextIndex: index * GITHUB_GRAPHQL_BATCH,
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
        if (isGraphqlRateLimit(payload.errors) && !payload.data) {
          throw new HttpError(GITHUB_GRAPHQL_URL, 403, payload.errors?.map((err) => err.message).join("; ") ?? "rate limit");
        }
        if (payload.errors?.length && !payload.data) {
          throw new Error(`GitHub GraphQL errors: ${payload.errors.map((err) => err.message).join("; ")}`);
        }
        if (payload.errors?.length && (index + 1) % 20 === 0) {
          ctx.log.warn("github GraphQL partial errors", {
            batch: index + 1,
            count: payload.errors.length,
            sample: payload.errors[0]?.message,
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
            const key = parsed.data.nameWithOwner.toLowerCase();
            cache[key] = parsed.data;
            lastFetched[key] = fetchedAt;
            fetchedThisRun += 1;
          }
        }
        persistLastFetched(ctx.dataDir, "github", lastFetched);
        persistEntityCache(ctx.dataDir, "github", cache);
        if ((index + 1) % 20 === 0 || index + 1 === batches.length) {
          ctx.log.info("github GraphQL progress", {
            batch: index + 1,
            batches: batches.length,
            fetchedThisRun,
            fresh: countFresh(allKeys, lastFetched, ctx.now),
          });
        }
        await waitForGraphqlBudget(rateLimit, ctx.log);
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
          fetchedCount: 0,
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
        ctx.log.warn("github stopped early after rate limit; keeping partial snapshot", {
          fetchedThisRun,
          requested: allKeys.length,
          due: dueKeys.length,
        });
      } else {
        throw error;
      }
    }

    ctx.log.info("github collected", {
      requested: allKeys.length,
      due: dueKeys.length,
      fetchedThisRun,
      truncated,
    });
    return finish({ skipped: false, truncated, fetchedThisRun });
  },
};
