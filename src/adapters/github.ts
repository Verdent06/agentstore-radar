import { z } from "zod";
import { GITHUB_GRAPHQL_BATCH, GITHUB_GRAPHQL_URL } from "../lib/config.ts";
import { HttpError } from "../lib/http.ts";
import { appIdFromIdentity, type GithubRepoRef } from "../lib/matching.ts";
import { emptySourceRow, type SourceRow } from "../lib/schema.ts";
import type { CollectContext, SourceAdapter, SourceResult } from "./types.ts";

const RepoNodeSchema = z
  .object({
    nameWithOwner: z.string(),
    url: z.string(),
    stargazerCount: z.number(),
    forkCount: z.number(),
    pushedAt: z.string().nullable().optional(),
    issues: z.object({ totalCount: z.number() }).nullable().optional(),
    isArchived: z.boolean().optional(),
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
  truncated?: boolean;
  repositories: unknown[];
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function buildQuery(batch: GithubRepoRef[]): string {
  const fields = `
    nameWithOwner
    url
    stargazerCount
    forkCount
    pushedAt
    isArchived
    issues(states: OPEN) { totalCount }
  `;
  const selections = batch.map((ref, index) => {
    const owner = JSON.stringify(ref.owner);
    const name = JSON.stringify(ref.repo);
    return `r${index}: repository(owner: ${owner}, name: ${name}) { ${fields} }`;
  });
  return `query { ${selections.join("\n")} }`;
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
    pushed_at: repo.pushedAt ?? null,
    status: repo.isArchived ? "archived" : "active",
    app_id: appIdFromIdentity({
      repoUrl: repo.url,
      source: "github",
      sourceId: repo.nameWithOwner,
    }),
  });
}

export const githubAdapter: SourceAdapter = {
  name: "github",
  kind: "enrichment",
  async collect(ctx: CollectContext): Promise<SourceResult> {
    const token = ctx.env.GITHUB_TOKEN ?? ctx.env.GH_TOKEN;
    const repos = [...ctx.discovered.githubRepos.values()];
    if (!token) {
      ctx.log.warn("github skipped: GITHUB_TOKEN is not set");
      return {
        source: "github",
        collectedAt: ctx.collectedAt,
        rowCount: 0,
        skipped: true,
        skipReason: "GITHUB_TOKEN not set",
        raw: { skipped: true, requested: repos.length },
        records: [],
      };
    }
    if (repos.length === 0) {
      return {
        source: "github",
        collectedAt: ctx.collectedAt,
        rowCount: 0,
        skipped: false,
        raw: { endpoint: GITHUB_GRAPHQL_URL, fetchedAt: ctx.collectedAt, requested: 0, repositories: [] },
        records: [],
      };
    }

    const repositories: unknown[] = [];
    const batches = chunk(repos, GITHUB_GRAPHQL_BATCH);
    ctx.log.info("github fetching repositories", { requested: repos.length, batches: batches.length });
    let truncated = false;
    try {
      for (const [index, batch] of batches.entries()) {
        const body = JSON.stringify({ query: buildQuery(batch) });
        const payload = GraphqlResponseSchema.parse(
          await ctx.http.fetchJson<unknown>(GITHUB_GRAPHQL_URL, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body,
          }),
        );
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
        if (payload.data) {
          for (const node of Object.values(payload.data)) {
            if (node) {
              repositories.push(node);
            }
          }
        }
        if ((index + 1) % 20 === 0 || index + 1 === batches.length) {
          ctx.log.info("github GraphQL progress", { batch: index + 1, batches: batches.length, resolved: repositories.length });
        }
        if ((index + 1) % 50 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 401 && repositories.length === 0) {
        ctx.log.warn("github skipped: GITHUB_TOKEN was rejected");
        return {
          source: "github",
          collectedAt: ctx.collectedAt,
          rowCount: 0,
          skipped: true,
          skipReason: "GITHUB_TOKEN rejected (HTTP 401)",
          raw: { skipped: true, requested: repos.length },
          records: [],
        };
      }
      if (error instanceof HttpError && (error.status === 403 || error.status === 429) && repositories.length > 0) {
        truncated = true;
        ctx.log.warn("github stopped early after rate limit; keeping partial snapshot", {
          resolved: repositories.length,
          requested: repos.length,
        });
      } else {
        throw error;
      }
    }

    const records: SourceRow[] = [];
    for (const item of repositories) {
      const row = normalizeGithubRepo(ctx.snapshotDate, item);
      if (row) {
        records.push(row);
      }
    }

    ctx.log.info("github collected", { requested: repos.length, rows: records.length, truncated });
    const raw: GithubRawSnapshot = {
      endpoint: GITHUB_GRAPHQL_URL,
      fetchedAt: ctx.collectedAt,
      requested: repos.length,
      truncated,
      repositories,
    };
    return {
      source: "github",
      collectedAt: ctx.collectedAt,
      rowCount: records.length,
      skipped: false,
      raw,
      records,
    };
  },
};
