import { z } from "zod";
import { MCP_REGISTRY_BASE, MCP_SERVERS_PATH } from "../lib/config.ts";
import { emptySourceRow, type SourceRow } from "../lib/schema.ts";
import {
  appIdFromIdentity,
  githubRepoFromMcpName,
  githubRepoUrl,
  normalizePackageName,
  parseGithubRepo,
} from "../lib/matching.ts";
import type { CollectContext, SourceAdapter, SourceResult } from "./types.ts";

const PackageSchema = z
  .object({
    registryType: z.string(),
    identifier: z.string(),
  })
  .passthrough();

const RepositorySchema = z
  .object({
    url: z.string().optional(),
    source: z.string().optional(),
  })
  .passthrough();

const ServerInnerSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    title: z.string().optional(),
    version: z.string().optional(),
    websiteUrl: z.string().optional(),
    repository: RepositorySchema.optional(),
    packages: z.array(PackageSchema).optional(),
  })
  .passthrough();

const OfficialMetaSchema = z
  .object({
    status: z.string().optional(),
    publishedAt: z.string().optional(),
    updatedAt: z.string().optional(),
    isLatest: z.boolean().optional(),
  })
  .passthrough();

const ServerResponseSchema = z
  .object({
    server: ServerInnerSchema,
    _meta: z
      .object({
        "io.modelcontextprotocol.registry/official": OfficialMetaSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ListResponseSchema = z
  .object({
    servers: z.array(z.unknown()),
    metadata: z
      .object({
        nextCursor: z.string().nullable().optional(),
        count: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type McpRawSnapshot = {
  endpoint: string;
  fetchedAt: string;
  pages: number;
  servers: unknown[];
};

function pickNpm(packages: z.infer<typeof PackageSchema>[] | undefined): string | null {
  const hit = packages?.find((pkg) => pkg.registryType === "npm");
  return hit ? normalizePackageName(hit.identifier, "npm") : null;
}

function pickPypi(packages: z.infer<typeof PackageSchema>[] | undefined): string | null {
  const hit = packages?.find((pkg) => pkg.registryType === "pypi");
  return hit ? normalizePackageName(hit.identifier, "pypi") : null;
}

function resolveRepo(server: z.infer<typeof ServerInnerSchema>): { url: string | null; explicitGithub: boolean } {
  const fromRepo = parseGithubRepo(server.repository?.url);
  if (fromRepo) {
    return { url: githubRepoUrl(fromRepo), explicitGithub: true };
  }
  const fromWebsite = parseGithubRepo(server.websiteUrl);
  if (fromWebsite) {
    return { url: githubRepoUrl(fromWebsite), explicitGithub: true };
  }
  const fromName = githubRepoFromMcpName(server.name);
  if (fromName) {
    return { url: githubRepoUrl(fromName), explicitGithub: false };
  }
  return { url: server.repository?.url ?? null, explicitGithub: false };
}

export function normalizeMcpServer(
  snapshotDate: string,
  item: unknown,
): { row: SourceRow; explicitGithub: boolean } | null {
  const parsed = ServerResponseSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const server = parsed.data.server;
  const meta = parsed.data._meta?.["io.modelcontextprotocol.registry/official"];
  const npmPackage = pickNpm(server.packages);
  const pypiPackage = pickPypi(server.packages);
  const repo = resolveRepo(server);
  const repoUrl = repo.url;
  return {
    explicitGithub: repo.explicitGithub,
    row: emptySourceRow({
      snapshot_date: snapshotDate,
      source: "mcp-registry",
      source_id: server.name,
      name: server.name,
      display_name: server.title ?? null,
      description: server.description ?? null,
      homepage: server.websiteUrl ?? null,
      repo_url: repoUrl,
      npm_package: npmPackage,
      pypi_package: pypiPackage,
      version: server.version ?? null,
      status: meta?.status ?? null,
      app_id: appIdFromIdentity({
        repoUrl,
        npmPackage,
        pypiPackage,
        source: "mcp-registry",
        sourceId: server.name,
      }),
    }),
  };
}

export const mcpRegistryAdapter: SourceAdapter = {
  name: "mcp-registry",
  kind: "catalog",
  async collect(ctx: CollectContext): Promise<SourceResult> {
    const endpoint = `${MCP_REGISTRY_BASE}${MCP_SERVERS_PATH}`;
    const servers: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const maxPages = ctx.maxPages ?? Number.POSITIVE_INFINITY;

    while (pages < maxPages) {
      const url = new URL(endpoint);
      url.searchParams.set("limit", "100");
      url.searchParams.set("version", "latest");
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }
      const page = ListResponseSchema.parse(await ctx.http.fetchJson<unknown>(url.toString()));
      pages += 1;
      servers.push(...page.servers);
      const next = page.metadata?.nextCursor;
      if (!next) {
        break;
      }
      cursor = next;
    }

    const records: SourceRow[] = [];
    let invalid = 0;
    for (const item of servers) {
      const normalized = normalizeMcpServer(ctx.snapshotDate, item);
      if (!normalized) {
        invalid += 1;
        continue;
      }
      records.push(normalized.row);
      if (normalized.explicitGithub && normalized.row.repo_url) {
        const ref = parseGithubRepo(normalized.row.repo_url);
        if (ref) {
          ctx.discovered.githubRepos.set(`${ref.owner}/${ref.repo}`, ref);
        }
      }
      if (normalized.row.npm_package) {
        ctx.discovered.npmPackages.add(normalized.row.npm_package);
      }
      if (normalized.row.pypi_package) {
        ctx.discovered.pypiPackages.add(normalized.row.pypi_package);
      }
    }

    if (invalid > 0) {
      ctx.log.warn("mcp-registry dropped invalid rows", { invalid, total: servers.length });
    }
    if (servers.length > 0 && invalid / servers.length > 0.5) {
      throw new Error(`mcp-registry validation failed for ${invalid}/${servers.length} rows`);
    }

    const raw: McpRawSnapshot = {
      endpoint,
      fetchedAt: ctx.collectedAt,
      pages,
      servers,
    };

    ctx.log.info("mcp-registry collected", { pages, rows: records.length });
    return {
      source: "mcp-registry",
      collectedAt: ctx.collectedAt,
      rowCount: records.length,
      skipped: false,
      raw,
      records,
    };
  },
};
