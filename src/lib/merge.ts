import { AppRowSchema, type AppRow, type SourceRow } from "./schema.ts";

function firstString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function preferNumber(current: number | null, incoming: number | null, preferIncoming: boolean): number | null {
  if (incoming == null) {
    return current;
  }
  if (current == null || preferIncoming) {
    return incoming;
  }
  return current;
}

export function mergeApps(snapshotDate: string, rows: SourceRow[]): AppRow[] {
  const byId = new Map<string, AppRow>();
  const sourceSets = new Map<string, Set<string>>();

  for (const row of rows) {
    const existing = byId.get(row.app_id);
    const sources = sourceSets.get(row.app_id) ?? new Set<string>();
    sources.add(row.source);
    sourceSets.set(row.app_id, sources);

    if (!existing) {
      byId.set(row.app_id, {
        snapshot_date: snapshotDate,
        app_id: row.app_id,
        sources: "",
        name: row.name,
        display_name: row.display_name,
        description: row.description,
        homepage: row.homepage,
        repo_url: row.repo_url,
        npm_package: row.npm_package,
        pypi_package: row.pypi_package,
        stars: row.stars,
        forks: row.forks,
        open_issues: row.open_issues,
        pushed_at: row.pushed_at,
        use_count: row.use_count,
        npm_weekly_downloads: row.npm_weekly_downloads,
        pypi_last_week_downloads: row.pypi_last_week_downloads,
        pypi_last_month_downloads: row.pypi_last_month_downloads,
      });
      continue;
    }

    const preferGithub = row.source === "github";
    existing.name = firstString(existing.name, row.name) ?? row.name;
    existing.display_name = firstString(existing.display_name, row.display_name);
    existing.description = firstString(existing.description, row.description);
    existing.homepage = firstString(existing.homepage, row.homepage);
    existing.repo_url = firstString(existing.repo_url, row.repo_url);
    existing.npm_package = firstString(existing.npm_package, row.npm_package);
    existing.pypi_package = firstString(existing.pypi_package, row.pypi_package);
    existing.stars = preferNumber(existing.stars, row.stars, preferGithub);
    existing.forks = preferNumber(existing.forks, row.forks, preferGithub);
    existing.open_issues = preferNumber(existing.open_issues, row.open_issues, preferGithub);
    existing.pushed_at = preferGithub && row.pushed_at ? row.pushed_at : firstString(existing.pushed_at, row.pushed_at);
    existing.use_count = preferNumber(existing.use_count, row.use_count, row.source === "smithery");
    existing.npm_weekly_downloads = preferNumber(
      existing.npm_weekly_downloads,
      row.npm_weekly_downloads,
      row.source === "npm",
    );
    existing.pypi_last_week_downloads = preferNumber(
      existing.pypi_last_week_downloads,
      row.pypi_last_week_downloads,
      row.source === "pypi",
    );
    existing.pypi_last_month_downloads = preferNumber(
      existing.pypi_last_month_downloads,
      row.pypi_last_month_downloads,
      row.source === "pypi",
    );
  }

  return [...byId.values()]
    .map((app) => {
      const sources = [...(sourceSets.get(app.app_id) ?? [])].sort().join("|");
      return AppRowSchema.parse({ ...app, sources });
    })
    .sort((a, b) => a.app_id.localeCompare(b.app_id));
}
