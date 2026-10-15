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
});

export type AppRow = z.infer<typeof AppRowSchema>;

export const SourceManifestSchema = z.object({
  source: SourceNameSchema,
  rowCount: z.number().int().nonnegative(),
  skipped: z.boolean(),
  skipReason: z.string().optional(),
  rawFile: z.string().optional(),
  collectedAt: z.string(),
  eligibleCount: z.number().int().nonnegative().optional(),
  fetchedCount: z.number().int().nonnegative().optional(),
  coverage: z.number().min(0).max(1).optional(),
  lastFetchedAt: z.string().optional(),
});

export type SourceManifest = z.infer<typeof SourceManifestSchema>;

export const SnapshotManifestSchema = z.object({
  snapshotDate: z.string(),
  collectedAt: z.string(),
  sources: z.array(SourceManifestSchema),
  appCount: z.number().int().nonnegative(),
  sourceRowCount: z.number().int().nonnegative(),
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
    ...partial,
  };
}
