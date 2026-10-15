import { z } from "zod";
import { GEMINI_EXTENSIONS_URL } from "../lib/config.ts";
import { appIdFromIdentity, githubRepoUrl, parseGithubRepo } from "../lib/matching.ts";
import { emptySourceRow, type SourceRow } from "../lib/schema.ts";
import type { CollectContext, SourceAdapter, SourceResult } from "./types.ts";

const ExtensionSchema = z
  .object({
    id: z.string(),
    rank: z.number().optional(),
    url: z.string(),
    fullName: z.string().optional(),
    repoDescription: z.string().optional(),
    stars: z.number().optional(),
    lastUpdated: z.string().optional(),
    extensionName: z.string(),
    extensionVersion: z.string().optional(),
    extensionDescription: z.string().optional(),
    hasMCP: z.boolean().optional(),
    isGoogleOwned: z.boolean().optional(),
  })
  .passthrough();

export type GeminiRawSnapshot = {
  endpoint: string;
  fetchedAt: string;
  extensions: unknown[];
};

export function normalizeGeminiExtension(snapshotDate: string, item: unknown): SourceRow | null {
  const parsed = ExtensionSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const ext = parsed.data;
  const repo = parseGithubRepo(ext.url) ?? parseGithubRepo(ext.fullName ? `https://github.com/${ext.fullName}` : undefined);
  const repoUrl = repo ? githubRepoUrl(repo) : ext.url;
  return emptySourceRow({
    snapshot_date: snapshotDate,
    source: "gemini-cli",
    source_id: ext.id,
    name: ext.extensionName,
    display_name: ext.extensionName,
    description: ext.extensionDescription ?? ext.repoDescription ?? null,
    homepage: ext.url,
    repo_url: repoUrl,
    version: ext.extensionVersion ?? null,
    stars: ext.stars ?? null,
    pushed_at: ext.lastUpdated ?? null,
    app_id: appIdFromIdentity({
      repoUrl,
      source: "gemini-cli",
      sourceId: ext.id,
    }),
  });
}

export const geminiAdapter: SourceAdapter = {
  name: "gemini-cli",
  kind: "catalog",
  async collect(ctx: CollectContext): Promise<SourceResult> {
    const payload = await ctx.http.fetchJson<unknown>(GEMINI_EXTENSIONS_URL);
    if (!Array.isArray(payload)) {
      throw new Error("gemini-cli extensions.json was not a JSON array");
    }
    const extensions = ctx.maxPages ? payload.slice(0, ctx.maxPages) : payload;

    const records: SourceRow[] = [];
    let invalid = 0;
    for (const item of extensions) {
      const row = normalizeGeminiExtension(ctx.snapshotDate, item);
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
      ctx.log.warn("gemini-cli dropped invalid rows", { invalid, total: extensions.length });
    }
    if (extensions.length > 0 && invalid / extensions.length > 0.5) {
      throw new Error(`gemini-cli validation failed for ${invalid}/${extensions.length} rows`);
    }

    ctx.log.info("gemini-cli collected", { rows: records.length });
    const raw: GeminiRawSnapshot = {
      endpoint: GEMINI_EXTENSIONS_URL,
      fetchedAt: ctx.collectedAt,
      extensions,
    };
    return {
      source: "gemini-cli",
      collectedAt: ctx.collectedAt,
      rowCount: records.length,
      skipped: false,
      raw,
      records,
    };
  },
};
