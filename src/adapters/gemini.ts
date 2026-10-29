import { z } from "zod";
import { GEMINI_EXTENSIONS_URL, SMITHERY_FROZEN_DAYS, SOURCE_FREEZE_RATIO } from "../lib/config.ts";
import { computeCoverage, computeFetchedShare } from "../lib/coverage.ts";
import { evaluateSourceFreeze, isUnchangedForDays, loadPreviousMetricHistory, smitheryFrozenDays } from "../lib/frozen.ts";
import { appIdFromIdentity, githubRepoUrl, parseGithubRepo } from "../lib/matching.ts";
import { emptySourceRow, withObservation, type SourceRow } from "../lib/schema.ts";
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
  freeze?: {
    frozen: number;
    sourceFrozen: boolean;
    unchanged: number;
    frozenDays: number;
    freezeRatio: number;
  };
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
    const frozenDays = smitheryFrozenDays(ctx.env, SMITHERY_FROZEN_DAYS);
    const previous = loadPreviousMetricHistory(ctx.dataDir, ctx.snapshotDate, "gemini-cli", "stars", frozenDays);

    const pending: Array<{ row: SourceRow; unchanged: boolean }> = [];
    let invalid = 0;
    for (const item of extensions) {
      const row = normalizeGeminiExtension(ctx.snapshotDate, item);
      if (!row) {
        invalid += 1;
        continue;
      }
      if (row.repo_url) {
        const ref = parseGithubRepo(row.repo_url);
        if (ref) {
          ctx.discovered.githubRepos.set(`${ref.owner}/${ref.repo}`, ref);
        }
      }
      pending.push({
        row,
        unchanged: isUnchangedForDays(row.stars, previous.byId.get(row.source_id) ?? [], previous.dates, frozenDays),
      });
    }
    if (invalid > 0) {
      ctx.log.warn("gemini-cli dropped invalid rows", { invalid, total: extensions.length });
    }
    if (extensions.length > 0 && invalid / extensions.length > 0.5) {
      throw new Error(`gemini-cli validation failed for ${invalid}/${extensions.length} rows`);
    }

    const freeze = evaluateSourceFreeze(
      pending.map((row) => row.unchanged),
      SOURCE_FREEZE_RATIO,
    );
    const records: SourceRow[] = [];
    let frozenCount = 0;
    for (const [index, item] of pending.entries()) {
      const frozen = freeze.freezeRow[index] === true;
      const history = previous.byId.get(item.row.source_id) ?? [];
      const previousFetchedAt = history.at(-1)?.fetchedAt ?? history.at(-1)?.date ?? null;
      if (frozen) {
        frozenCount += 1;
      }
      records.push(withObservation(item.row, frozen ? previousFetchedAt : ctx.collectedAt, frozen, frozen));
    }
    const freshTodayCount = records.filter((row) => row.carried_forward !== true && row.frozen !== true).length;
    // The gallery JSON is fetched in full every run. Frozen/unrankable stars still
    // count as fetched; `fresh` stays carried_forward false AND not frozen.
    const fetchedThisRunCount = records.length;
    const fetchedShare = computeFetchedShare(fetchedThisRunCount, records.length);
    const { coverage } = computeCoverage(records.length, freshTodayCount);
    if (freeze.sourceFrozen) {
      ctx.log.warn("gemini-cli stars source-frozen; stamping unchanged rows frozen/carried_forward, not fresh", {
        frozen: frozenCount,
        rows: records.length,
        frozenDays,
        unchanged: freeze.unchangedCount,
      });
    }

    ctx.log.info("gemini-cli collected", {
      rows: records.length,
      fetchedThisRunCount,
      fetchedShare,
      frozenCount,
      sourceFrozen: freeze.sourceFrozen,
    });
    const raw: GeminiRawSnapshot = {
      endpoint: GEMINI_EXTENSIONS_URL,
      fetchedAt: ctx.collectedAt,
      extensions,
      freeze: {
        frozen: frozenCount,
        sourceFrozen: freeze.sourceFrozen,
        unchanged: freeze.unchangedCount,
        frozenDays,
        freezeRatio: freeze.ratio,
      },
    };
    return {
      source: "gemini-cli",
      collectedAt: ctx.collectedAt,
      rowCount: records.length,
      skipped: false,
      eligibleCount: records.length,
      fetchedThisRunCount,
      fetchedShare,
      freshTodayCount,
      coverage,
      raw,
      records,
    };
  },
};
