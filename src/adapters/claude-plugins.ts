import { z } from "zod";
import { CLAUDE_PLUGIN_MARKETPLACES, SMITHERY_FROZEN_DAYS, SOURCE_FREEZE_RATIO } from "../lib/config.ts";
import { computeCoverage, computeFetchedShare } from "../lib/coverage.ts";
import {
  evaluateSourceFreeze,
  isUnchangedStringForDays,
  loadPreviousStringHistory,
  smitheryFrozenDays,
} from "../lib/frozen.ts";
import { appIdFromIdentity, githubRepoUrl, parseGithubRepo, type GithubRepoRef } from "../lib/matching.ts";
import { emptySourceRow, withObservation, type SourceRow, type StarsScope } from "../lib/schema.ts";
import type { CollectContext, SourceAdapter, SourceResult } from "./types.ts";

const ShaSchema = z.string().regex(/^[0-9a-fA-F]{40}$/);

const AuthorSchema = z
  .object({
    name: z.string(),
    email: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

const GithubPluginSourceSchema = z
  .object({
    source: z.literal("github"),
    repo: z.string().min(1),
    ref: z.string().optional(),
    sha: ShaSchema.optional(),
  })
  .strict();

const UrlPluginSourceSchema = z
  .object({
    source: z.literal("url"),
    url: z.string().min(1),
    path: z.string().min(1).optional(),
    ref: z.string().optional(),
    sha: ShaSchema.optional(),
  })
  .strict();

const GitSubdirPluginSourceSchema = z
  .object({
    source: z.literal("git-subdir"),
    url: z.string().min(1),
    path: z.string().min(1),
    ref: z.string().optional(),
    sha: ShaSchema.optional(),
  })
  .strict();

const PluginSourceSchema = z.union([
  z.string().min(1),
  z.discriminatedUnion("source", [GithubPluginSourceSchema, UrlPluginSourceSchema, GitSubdirPluginSourceSchema]),
]);

const PluginEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    source: PluginSourceSchema,
    author: AuthorSchema.optional(),
    category: z.string().optional(),
    homepage: z.string().optional(),
    displayName: z.string().optional(),
    strict: z.boolean().optional(),
    skills: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    version: z.string().optional(),
    lspServers: z.record(z.unknown()).optional(),
    keywords: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Strict marketplace document. Unknown keys fail the source instead of being dropped.
 * The field set is the shape observed on Anthropic's official, skills, and
 * knowledge-work marketplaces, plus the documented `github` plugin source.
 */
export const ClaudeMarketplaceSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    owner: z
      .object({
        name: z.string().min(1),
        email: z.string().optional(),
      })
      .strict(),
    metadata: z
      .object({
        description: z.string().optional(),
        version: z.string().optional(),
      })
      .strict()
      .optional(),
    renames: z.record(z.string().nullable()).optional(),
    plugins: z.array(PluginEntrySchema),
  })
  .strict();

export type ClaudeMarketplace = z.infer<typeof ClaudeMarketplaceSchema>;
export type ClaudePluginSource = z.infer<typeof PluginSourceSchema>;

export type ClaudeMarketplaceFetch = {
  owner: string;
  repo: string;
  url: string;
  payload: unknown;
};

type PluginDraft = {
  row: SourceRow;
  repoKey: string | null;
  subfolder: boolean;
};

export function normalizePluginPath(value: string): string {
  let path = value.trim().replace(/\\/g, "/");
  if (path === "." || path === "./" || path === "") {
    return ".";
  }
  if (path.startsWith("./")) {
    path = path.slice(2);
  }
  path = path.replace(/\/+$/g, "");
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`claude-plugins source path escapes the marketplace: ${value}`);
  }
  return path.length > 0 ? path : ".";
}

function parseOwnerRepo(value: string): GithubRepoRef | null {
  const trimmed = value.trim();
  return parseGithubRepo(trimmed) ?? parseGithubRepo(`https://github.com/${trimmed.replace(/\.git$/i, "")}`);
}

function canonicalGitLocator(url: string): string {
  const repo = parseOwnerRepo(url);
  if (repo) {
    return `github:${repo.owner}/${repo.repo}`;
  }
  return `git:${url.trim().replace(/\.git$/i, "")}`;
}

/** Stable locator for a plugin source. Display names and marketplace renames are not part of it. */
export function pluginSourceLocator(source: ClaudePluginSource): { locator: string; repo: GithubRepoRef | null; subfolder: boolean } {
  if (typeof source === "string") {
    const path = normalizePluginPath(source);
    return { locator: `path:${path}`, repo: null, subfolder: path !== "." };
  }
  if (source.source === "github") {
    const repo = parseOwnerRepo(source.repo);
    if (!repo) {
      throw new Error(`claude-plugins github source is not owner/repo: ${source.repo}`);
    }
    return { locator: `github:${repo.owner}/${repo.repo}`, repo, subfolder: false };
  }
  const repo = parseOwnerRepo(source.url);
  const base = canonicalGitLocator(source.url);
  const path = source.path ? normalizePluginPath(source.path) : null;
  if (path) {
    return { locator: `${base}#${path}`, repo, subfolder: true };
  }
  return { locator: base, repo, subfolder: false };
}

function pinnedSha(source: ClaudePluginSource): string | null {
  if (typeof source === "string" || !source.sha) {
    return null;
  }
  return source.sha.toLowerCase();
}

/**
 * Ids follow the marketplace source path or repo, not the plugin's display name.
 * When several plugins share one locator, the marketplace rename list keeps the
 * disambiguating slug on the pre-rename name so the id does not jump.
 */
export function stablePluginSourceId(
  marketplace: string,
  locator: string,
  pluginName: string,
  renames: Record<string, string | null> | undefined,
  duplicateLocator: boolean,
): string {
  const base = `${marketplace}:${locator}`;
  if (!duplicateLocator) {
    return base;
  }
  const formers = Object.entries(renames ?? {})
    .filter(([, next]) => next === pluginName)
    .map(([prev]) => prev)
    .sort();
  const slug = formers[0] ?? pluginName;
  return `${base}#${slug}`;
}

function assertUniqueIds(rows: PluginDraft[], marketplace: string): void {
  const seen = new Map<string, string>();
  for (const draft of rows) {
    const previous = seen.get(draft.row.source_id);
    if (previous) {
      throw new Error(
        `claude-plugins ${marketplace} produced duplicate source id ${draft.row.source_id} for ${previous} and ${draft.row.plugin_name}`,
      );
    }
    seen.set(draft.row.source_id, draft.row.plugin_name ?? draft.row.name);
  }
}

export function parseClaudeMarketplace(payload: unknown, label: string): ClaudeMarketplace {
  const parsed = ClaudeMarketplaceSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`claude-plugins ${label} marketplace.json shape rejected: ${parsed.error.message}`);
  }
  return parsed.data;
}

function draftPlugins(
  snapshotDate: string,
  marketplaceRepo: GithubRepoRef,
  marketplace: ClaudeMarketplace,
): PluginDraft[] {
  const locators = marketplace.plugins.map((plugin) => pluginSourceLocator(plugin.source).locator);
  const locatorCounts = new Map<string, number>();
  for (const locator of locators) {
    locatorCounts.set(locator, (locatorCounts.get(locator) ?? 0) + 1);
  }
  const drafts: PluginDraft[] = [];
  for (const plugin of marketplace.plugins) {
    const located = pluginSourceLocator(plugin.source);
    const repo = located.repo ?? (typeof plugin.source === "string" ? marketplaceRepo : null);
    const subfolder = located.subfolder;
    const repoUrl = repo ? githubRepoUrl(repo) : null;
    const sourceId = stablePluginSourceId(
      marketplace.name,
      located.locator,
      plugin.name,
      marketplace.renames,
      (locatorCounts.get(located.locator) ?? 0) > 1,
    );
    const homepage = plugin.homepage ?? repoUrl;
    drafts.push({
      repoKey: repo ? `${repo.owner}/${repo.repo}` : null,
      subfolder,
      row: emptySourceRow({
        snapshot_date: snapshotDate,
        source: "claude-plugins",
        source_id: sourceId,
        name: plugin.displayName ?? plugin.name,
        display_name: plugin.displayName ?? plugin.name,
        description: plugin.description,
        homepage,
        repo_url: repoUrl,
        version: plugin.version ?? null,
        plugin_name: plugin.name,
        marketplace_name: marketplace.name,
        commit_sha: pinnedSha(plugin.source),
        // App id is the GitHub repo, not the plugin. A 2026-11-02 fetch wrote
        // 443 plugin rows that folded into 245 apps. plugin_name, marketplace_name,
        // and source_id stay on the row so a shared repo can be split later.
        app_id: appIdFromIdentity({
          repoUrl,
          source: "claude-plugins",
          sourceId,
        }),
      }),
    });
  }
  assertUniqueIds(drafts, marketplace.name);
  return drafts;
}

export function starsScopeForPlugin(subfolder: boolean, repoKey: string | null, repoCount: number): StarsScope | null {
  if (subfolder) {
    return "host_repo";
  }
  if (!repoKey) {
    return null;
  }
  return repoCount > 1 ? "host_repo" : "own_repo";
}

/** One row per plugin. Scope is decided after every marketplace is parsed so shared repos are visible. */
export function rowsFromClaudeMarketplaces(snapshotDate: string, fetched: ClaudeMarketplaceFetch[]): SourceRow[] {
  const drafts: PluginDraft[] = [];
  for (const file of fetched) {
    const marketplace = parseClaudeMarketplace(file.payload, `${file.owner}/${file.repo}`);
    drafts.push(
      ...draftPlugins(snapshotDate, { owner: file.owner.toLowerCase(), repo: file.repo.toLowerCase() }, marketplace),
    );
  }
  const repoCounts = new Map<string, number>();
  for (const draft of drafts) {
    if (!draft.repoKey) {
      continue;
    }
    repoCounts.set(draft.repoKey, (repoCounts.get(draft.repoKey) ?? 0) + 1);
  }
  return drafts.map((draft) => ({
    ...draft.row,
    stars_scope: starsScopeForPlugin(draft.subfolder, draft.repoKey, draft.repoKey ? (repoCounts.get(draft.repoKey) ?? 0) : 0),
  }));
}

export type ClaudePluginsRawSnapshot = {
  endpoint: string;
  fetchedAt: string;
  marketplaces: Array<{ repo: string; url: string; pluginCount: number }>;
  plugins: unknown[];
  freeze?: {
    frozen: number;
    sourceFrozen: boolean;
    unchanged: number;
    frozenDays: number;
    freezeRatio: number;
  };
};

export const claudePluginsAdapter: SourceAdapter = {
  name: "claude-plugins",
  kind: "catalog",
  async collect(ctx: CollectContext): Promise<SourceResult> {
    const fetched: ClaudeMarketplaceFetch[] = [];
    for (const marketplace of CLAUDE_PLUGIN_MARKETPLACES) {
      const payload = await ctx.http.fetchJson<unknown>(marketplace.url);
      fetched.push({ ...marketplace, payload });
    }
    const drafts = rowsFromClaudeMarketplaces(ctx.snapshotDate, fetched);
    const frozenDays = smitheryFrozenDays(ctx.env, SMITHERY_FROZEN_DAYS);
    const previous = loadPreviousStringHistory(ctx.dataDir, ctx.snapshotDate, "claude-plugins", "commit_sha", frozenDays);
    const pending: Array<{ row: SourceRow; unchanged: boolean }> = [];
    for (const row of drafts) {
      if (row.repo_url) {
        const ref = parseGithubRepo(row.repo_url);
        if (ref) {
          ctx.discovered.githubRepos.set(`${ref.owner}/${ref.repo}`, ref);
        }
      }
      pending.push({
        row,
        unchanged: isUnchangedStringForDays(row.commit_sha, previous.byId.get(row.source_id) ?? [], previous.dates, frozenDays),
      });
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
    const fetchedThisRunCount = records.length;
    const fetchedShare = computeFetchedShare(fetchedThisRunCount, records.length);
    const { coverage } = computeCoverage(records.length, freshTodayCount);
    if (freeze.sourceFrozen) {
      ctx.log.warn("claude-plugins commit pins source-frozen; stamping unchanged rows frozen/carried_forward, not fresh", {
        frozen: frozenCount,
        rows: records.length,
        frozenDays,
        unchanged: freeze.unchangedCount,
      });
    }
    ctx.log.info("claude-plugins collected", {
      rows: records.length,
      marketplaces: fetched.length,
      fetchedThisRunCount,
      fetchedShare,
      frozenCount,
      sourceFrozen: freeze.sourceFrozen,
    });
    const raw: ClaudePluginsRawSnapshot = {
      endpoint: CLAUDE_PLUGIN_MARKETPLACES.map((marketplace) => marketplace.url).join(" "),
      fetchedAt: ctx.collectedAt,
      marketplaces: fetched.map((file) => ({
        repo: `${file.owner}/${file.repo}`,
        url: file.url,
        pluginCount: pluginCount(file.payload),
      })),
      plugins: fetched.flatMap((file) => pluginList(file.payload)),
      freeze: {
        frozen: frozenCount,
        sourceFrozen: freeze.sourceFrozen,
        unchanged: freeze.unchangedCount,
        frozenDays,
        freezeRatio: freeze.ratio,
      },
    };
    return {
      source: "claude-plugins",
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

function pluginList(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object" || !("plugins" in payload) || !Array.isArray(payload.plugins)) {
    return [];
  }
  return payload.plugins;
}

function pluginCount(payload: unknown): number {
  return pluginList(payload).length;
}
