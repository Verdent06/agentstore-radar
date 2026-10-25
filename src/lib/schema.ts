import { z } from "zod";

export const SourceNameSchema = z.enum([
  "mcp-registry",
  "smithery",
  "gemini-cli",
  "github",
  "npm",
  "pypi",
]);

export type SourceName = z.infer<typeof SourceNameSchema>;

export const SOURCE_NAMES = SourceNameSchema.options;

export const SourceRowSchema = z.object({
  snapshot_date: z.string(),
  app_id: z.string(),
  source: SourceNameSchema,
  source_id: z.string(),
  name: z.string(),
  display_name: z.string().nullable(),
  description: z.string().nullable(),
  homepage: z.string().nullable(),
  repo_url: z.string().nullable(),
  npm_package: z.string().nullable(),
  pypi_package: z.string().nullable(),
  version: z.string().nullable(),
  status: z.string().nullable(),
  stars: z.number().int().nullable(),
  forks: z.number().int().nullable(),
  open_issues: z.number().int().nullable(),
  pushed_at: z.string().nullable(),
  use_count: z.number().nullable(),
  npm_weekly_downloads: z.number().int().nullable(),
  pypi_last_week_downloads: z.number().int().nullable(),
  pypi_last_month_downloads: z.number().int().nullable(),
  verified: z.boolean().nullable(),
  fetched_at: z.string().nullable().optional().default(null),
  carried_forward: z.boolean().optional().default(false),
  /** True when the live upstream value has not moved for N snapshot days. */
  frozen: z.boolean().optional().default(false),
});

export type SourceRow = z.infer<typeof SourceRowSchema>;

export const AppRowSchema = z.object({
  snapshot_date: z.string(),
  app_id: z.string(),
  sources: z.string(),
  name: z.string(),
  display_name: z.string().nullable(),
  description: z.string().nullable(),
  homepage: z.string().nullable(),
  repo_url: z.string().nullable(),
  npm_package: z.string().nullable(),
  pypi_package: z.string().nullable(),
  stars: z.number().int().nullable(),
  forks: z.number().int().nullable(),
  open_issues: z.number().int().nullable(),
  pushed_at: z.string().nullable(),
  use_count: z.number().nullable(),
  npm_weekly_downloads: z.number().int().nullable(),
  pypi_last_week_downloads: z.number().int().nullable(),
  pypi_last_month_downloads: z.number().int().nullable(),
  stars_fetched_at: z.string().nullable().optional().default(null),
  stars_carried_forward: z.boolean().optional().default(false),
  use_count_fetched_at: z.string().nullable().optional().default(null),
  use_count_carried_forward: z.boolean().optional().default(false),
  npm_weekly_downloads_fetched_at: z.string().nullable().optional().default(null),
  npm_weekly_downloads_carried_forward: z.boolean().optional().default(false),
  pypi_last_week_downloads_fetched_at: z.string().nullable().optional().default(null),
  pypi_last_week_downloads_carried_forward: z.boolean().optional().default(false),
  pypi_last_month_downloads_fetched_at: z.string().nullable().optional().default(null),
  pypi_last_month_downloads_carried_forward: z.boolean().optional().default(false),
  stars_source: z.string().nullable().optional().default(null),
});

export type AppRow = z.infer<typeof AppRowSchema>;

export const SourceStoppedAtSchema = z.object({
  source: SourceNameSchema,
  page: z.number().int().nonnegative().optional(),
  cursor: z.string().optional(),
  error: z.string(),
});

export type SourceStoppedAt = z.infer<typeof SourceStoppedAtSchema>;

export const SourceManifestSchema = z.object({
  source: SourceNameSchema,
  rowCount: z.number().int().nonnegative(),
  skipped: z.boolean(),
  skipReason: z.string().optional(),
  rawFile: z.string().optional(),
  collectedAt: z.string(),
  eligibleCount: z.number().int().nonnegative().optional(),
  /** Keys whose last fetch is on this UTC snapshot date. Used for daily coverage. */
  freshTodayCount: z.number().int().nonnegative().optional(),
  /** Keys whose last fetch is within the 7-day rolling window. Not "fetched this run". */
  freshWithin7dCount: z.number().int().nonnegative().optional(),
  /** Keys actually requested from the live API during this collect. */
  fetchedThisRunCount: z.number().int().nonnegative().optional(),
  /** @deprecated Legacy alias of freshWithin7dCount, kept so older snapshots still parse. */
  fetchedCount: z.number().int().nonnegative().optional(),
  coverage: z.number().min(0).max(1).optional(),
  lastFetchedAt: z.string().optional(),
  failed: z.boolean().optional(),
  error: z.string().optional(),
  truncated: z.boolean().optional(),
  backfilled: z.boolean().optional(),
  backfilledFields: z.array(z.string()).optional(),
  stoppedAt: SourceStoppedAtSchema.optional(),
});

export type SourceManifest = z.infer<typeof SourceManifestSchema>;

export const SnapshotManifestSchema = z.object({
  snapshotDate: z.string(),
  collectedAt: z.string(),
  sources: z.array(SourceManifestSchema),
  appCount: z.number().int().nonnegative(),
  sourceRowCount: z.number().int().nonnegative(),
  partial: z.boolean().optional(),
  completedSources: z.array(SourceNameSchema).optional(),
  failedSourceCount: z.number().int().nonnegative().optional(),
  runId: z.string().optional(),
  overwrite: z
    .object({
      overwrittenAt: z.string(),
      previousBackupPath: z.string(),
      previousCollectedAt: z.string().optional(),
      previousRunId: z.string().optional(),
      previousGitSha: z.string().optional(),
    })
    .optional(),
});

export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

export function emptySourceRow(partial: Partial<SourceRow> & Pick<SourceRow, "snapshot_date" | "app_id" | "source" | "source_id" | "name">): SourceRow {
  return {
    display_name: null,
    description: null,
    homepage: null,
    repo_url: null,
    npm_package: null,
    pypi_package: null,
    version: null,
    status: null,
    stars: null,
    forks: null,
    open_issues: null,
    pushed_at: null,
    use_count: null,
    npm_weekly_downloads: null,
    pypi_last_week_downloads: null,
    pypi_last_month_downloads: null,
    verified: null,
    fetched_at: null,
    carried_forward: false,
    frozen: false,
    ...partial,
  };
}

export function withObservation(
  row: SourceRow,
  fetchedAt: string | null | undefined,
  carriedForward: boolean,
  frozen = false,
): SourceRow {
  return {
    ...row,
    fetched_at: fetchedAt ?? null,
    carried_forward: carriedForward,
    frozen,
  };
}

export function sourceFreshWithin7dCount(
  source: Pick<SourceManifest, "freshWithin7dCount" | "fetchedCount">,
): number | undefined {
  return source.freshWithin7dCount ?? source.fetchedCount;
}

export function sourceIsIncomplete(source: Pick<SourceManifest, "failed" | "truncated">): boolean {
  return source.failed === true || source.truncated === true;
}

export function snapshotIsPartial(manifest: SnapshotManifest): boolean {
  if (manifest.partial === true) {
    return true;
  }
  return manifest.sources.some(sourceIsIncomplete);
}
