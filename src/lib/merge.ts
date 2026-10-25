import { AppRowSchema, type AppRow, type SourceRow } from "./schema.ts";

function firstString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

type MetricKey =
  | "stars"
  | "forks"
  | "open_issues"
  | "use_count"
  | "npm_weekly_downloads"
  | "pypi_last_week_downloads"
  | "pypi_last_month_downloads";

type FreshnessKey =
  | "stars"
  | "use_count"
  | "npm_weekly_downloads"
  | "pypi_last_week_downloads"
  | "pypi_last_month_downloads";

const FRESHNESS_FIELDS: Record<FreshnessKey, { at: keyof AppRow; carried: keyof AppRow }> = {
  stars: { at: "stars_fetched_at", carried: "stars_carried_forward" },
  use_count: { at: "use_count_fetched_at", carried: "use_count_carried_forward" },
  npm_weekly_downloads: { at: "npm_weekly_downloads_fetched_at", carried: "npm_weekly_downloads_carried_forward" },
  pypi_last_week_downloads: { at: "pypi_last_week_downloads_fetched_at", carried: "pypi_last_week_downloads_carried_forward" },
  pypi_last_month_downloads: { at: "pypi_last_month_downloads_fetched_at", carried: "pypi_last_month_downloads_carried_forward" },
};

function applyFreshness(app: AppRow, key: FreshnessKey, row: SourceRow): void {
  const fields = FRESHNESS_FIELDS[key];
  (app[fields.at] as string | null) = row.fetched_at ?? null;
  const carried =
    key === "pypi_last_month_downloads"
      ? row.carried_forward === true || row.frozen === true
      : row.carried_forward === true;
  (app[fields.carried] as boolean) = carried;
}

function preferNumber(
  app: AppRow,
  field: MetricKey,
  incoming: number | null,
  row: SourceRow,
  preferIncoming: boolean,
  freshness: FreshnessKey,
): void {
  if (incoming == null) {
    return;
  }
  const current = app[field] as number | null;
  if (current == null || preferIncoming) {
    (app[field] as number | null) = incoming;
    applyFreshness(app, freshness, row);
    if (field === "stars") {
      app.stars_source = row.source;
    }
  }
}

function emptyApp(snapshotDate: string, row: SourceRow): AppRow {
  const app: AppRow = {
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
    stars_fetched_at: null,
    stars_carried_forward: false,
    use_count_fetched_at: null,
    use_count_carried_forward: false,
    npm_weekly_downloads_fetched_at: null,
    npm_weekly_downloads_carried_forward: false,
    pypi_last_week_downloads_fetched_at: null,
    pypi_last_week_downloads_carried_forward: false,
    pypi_last_month_downloads_fetched_at: null,
    pypi_last_month_downloads_carried_forward: false,
    stars_source: row.stars != null ? row.source : null,
  };
  if (row.stars != null) {
    applyFreshness(app, "stars", row);
  }
  if (row.use_count != null) {
    applyFreshness(app, "use_count", row);
  }
  if (row.npm_weekly_downloads != null) {
    applyFreshness(app, "npm_weekly_downloads", row);
  }
  if (row.pypi_last_week_downloads != null) {
    applyFreshness(app, "pypi_last_week_downloads", row);
  }
  if (row.pypi_last_month_downloads != null) {
    applyFreshness(app, "pypi_last_month_downloads", row);
  }
  return app;
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
      byId.set(row.app_id, emptyApp(snapshotDate, row));
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
    preferNumber(existing, "stars", row.stars, row, preferGithub, "stars");
    preferNumber(existing, "forks", row.forks, row, preferGithub, "stars");
    preferNumber(existing, "open_issues", row.open_issues, row, preferGithub, "stars");
    if (preferGithub && row.pushed_at) {
      existing.pushed_at = row.pushed_at;
    } else {
      existing.pushed_at = firstString(existing.pushed_at, row.pushed_at);
    }
    preferNumber(existing, "use_count", row.use_count, row, row.source === "smithery", "use_count");
    preferNumber(
      existing,
      "npm_weekly_downloads",
      row.npm_weekly_downloads,
      row,
      row.source === "npm",
      "npm_weekly_downloads",
    );
    preferNumber(
      existing,
      "pypi_last_week_downloads",
      row.pypi_last_week_downloads,
      row,
      row.source === "pypi",
      "pypi_last_week_downloads",
    );
    preferNumber(
      existing,
      "pypi_last_month_downloads",
      row.pypi_last_month_downloads,
      row,
      row.source === "pypi",
      "pypi_last_month_downloads",
    );
  }

  return [...byId.values()]
    .map((app) => {
      const sources = [...(sourceSets.get(app.app_id) ?? [])].sort().join("|");
      return AppRowSchema.parse({ ...app, sources });
    })
    .sort((a, b) => a.app_id.localeCompare(b.app_id));
}
