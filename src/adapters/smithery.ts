import { z } from "zod";
import { SMITHERY_SERVERS_URL, SMITHERY_STABLE_SEED } from "../lib/config.ts";
import { HttpError } from "../lib/http.ts";
import { appIdFromIdentity, githubRepoUrl, parseGithubRepo } from "../lib/matching.ts";
import { emptySourceRow, type SourceRow } from "../lib/schema.ts";
import type { CollectContext, SourceAdapter, SourceResult } from "./types.ts";

const ServerSchema = z
  .object({
    id: z.string(),
    qualifiedName: z.string(),
    namespace: z.string().optional(),
    slug: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    homepage: z.string().optional().nullable(),
    useCount: z.number().optional(),
    verified: z.boolean().optional(),
    remote: z.boolean().optional(),
    isDeployed: z.boolean().optional(),
    createdAt: z.string().optional(),
    repositoryUrl: z.string().optional().nullable(),
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
};

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
    let totalCount: number | undefined;
    const maxPages = ctx.maxPages ?? Number.POSITIVE_INFINITY;

    try {
      let page = 1;
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
      throw error;
    }

    const records: SourceRow[] = [];
    let invalid = 0;
    for (const item of servers) {
      const row = normalizeSmitheryServer(ctx.snapshotDate, item);
      if (!row) {
        invalid += 1;
        continue;
      }
      records.push(row);
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

    ctx.log.info("smithery collected", { pages, rows: records.length, totalCount });
    const raw: SmitheryRawSnapshot = {
      endpoint: SMITHERY_SERVERS_URL,
      fetchedAt: ctx.collectedAt,
      seed: SMITHERY_STABLE_SEED,
      pages,
      totalCount,
      servers,
    };
    return {
      source: "smithery",
      collectedAt: ctx.collectedAt,
      rowCount: records.length,
      skipped: false,
      raw,
      records,
    };
  },
};
