import { coverageFromManifest } from "../commands/report.ts";
import { listSnapshotDates, readApps, readManifest, readSourceRows } from "../lib/io.ts";
import { snapshotIsPartial, type AppRow, type SourceName, type SourceRow } from "../lib/schema.ts";
import { loadPublicAnswerShare } from "./answer-share.ts";
import { classifyCategory } from "./classify.ts";
import {
  STORE_SOURCES,
  type Aggregate,
  type AppSummary,
  type CompactSeries,
  type CoverageRow,
  type DataOrigin,
  type HeadlineStats,
  type HistoryPoint,
  type StoreSource,
} from "./types.ts";

const HISTORY_CAP_DAYS = 90;

function asNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function displayName(row: Pick<AppRow, "display_name" | "name">): string {
  return row.display_name?.trim() || row.name;
}

function parseSources(raw: string): SourceName[] {
  return raw
    .split("|")
    .map((part) => part.trim())
    .filter((part): part is SourceName => part.length > 0) as SourceName[];
}

function storesOf(sources: SourceName[]): StoreSource[] {
  return STORE_SOURCES.filter((store) => sources.includes(store));
}

function geminiStarsFromRows(rows: SourceRow[]): number | null {
  const gemini = rows.find((row) => row.source === "gemini-cli" && row.stars != null);
  return asNumber(gemini?.stars);
}

function verifiedFromRows(rows: SourceRow[]): boolean | null {
  const flagged = rows.find((row) => row.verified != null);
  return flagged?.verified ?? null;
}

function weekAgoDate(dates: string[], latest: string): string | null {
  const target = new Date(`${latest}T00:00:00Z`);
  target.setUTCDate(target.getUTCDate() - 7);
  const wanted = target.toISOString().slice(0, 10);
  const earlier = dates.filter((date) => date <= wanted);
  return earlier.at(-1) ?? dates[0] ?? null;
}

function compact(points: HistoryPoint[], dates: string[]): CompactSeries {
  const byDate = new Map(points.map((point) => [point.date, point]));
  const flag = (carried: boolean | undefined): 0 | 1 => (carried ? 1 : 0);
  const series: CompactSeries = {
    s: dates.map((date) => byDate.get(date)?.stars ?? null),
    u: dates.map((date) => byDate.get(date)?.useCount ?? null),
    n: dates.map((date) => byDate.get(date)?.npmWeeklyDownloads ?? null),
    p: dates.map((date) => byDate.get(date)?.pypiLastWeekDownloads ?? null),
    g: dates.map((date) => byDate.get(date)?.geminiStars ?? null),
    sc: dates.map((date) => flag(byDate.get(date)?.starsCarriedForward)),
    uc: dates.map((date) => flag(byDate.get(date)?.useCountCarriedForward)),
    nc: dates.map((date) => flag(byDate.get(date)?.npmCarriedForward)),
    pc: dates.map((date) => flag(byDate.get(date)?.pypiCarriedForward)),
  };
  const pruneValues = (key: "s" | "u" | "n" | "p" | "g") => {
    if (series[key]?.every((value) => value == null)) {
      delete series[key];
    }
  };
  const pruneFlags = (key: "sc" | "uc" | "nc" | "pc") => {
    if (series[key]?.every((value) => value == null || value === 0)) {
      delete series[key];
    }
  };
  pruneValues("s");
  pruneValues("u");
  pruneValues("n");
  pruneValues("p");
  pruneValues("g");
  pruneFlags("sc");
  pruneFlags("uc");
  pruneFlags("nc");
  pruneFlags("pc");
  return series;
}

export function buildAggregate(dataDir: string, origin: DataOrigin = "data_dir"): Aggregate {
  const allDates = listSnapshotDates(dataDir);
  const snapshotDates = allDates.slice(-HISTORY_CAP_DAYS);
  const partialDates = snapshotDates.filter((date) => {
    try {
      return snapshotIsPartial(readManifest(date, dataDir));
    } catch {
      return false;
    }
  });
  const completeDates = snapshotDates.filter((date) => !partialDates.includes(date));
  const latestDate = snapshotDates.at(-1) ?? null;
  const previousDate = snapshotDates.length >= 2 ? snapshotDates.at(-2) ?? null : null;
  const latestCompleteDate = completeDates.at(-1) ?? null;
  const previousCompleteDate = completeDates.length >= 2 ? completeDates.at(-2) ?? null : null;
  const week = latestCompleteDate ? weekAgoDate(completeDates, latestCompleteDate) : null;

  const firstSeen = new Map<string, string>();
  const history = new Map<string, HistoryPoint[]>();
  const latestApps = new Map<string, AppRow>();
  const latestSourceRows = new Map<string, SourceRow[]>();

  for (const date of snapshotDates) {
    const apps = readApps(date, dataDir);
    const sourceRows = readSourceRows(date, dataDir);
    const rowsByApp = new Map<string, SourceRow[]>();
    for (const row of sourceRows) {
      const list = rowsByApp.get(row.app_id) ?? [];
      list.push(row);
      rowsByApp.set(row.app_id, list);
    }
    for (const app of apps) {
      if (!firstSeen.has(app.app_id)) {
        firstSeen.set(app.app_id, date);
      }
      latestApps.set(app.app_id, app);
      latestSourceRows.set(app.app_id, rowsByApp.get(app.app_id) ?? []);
      const points = history.get(app.app_id) ?? [];
      points.push({
        date,
        stars: asNumber(app.stars),
        useCount: asNumber(app.use_count),
        npmWeeklyDownloads: asNumber(app.npm_weekly_downloads),
        pypiLastWeekDownloads: asNumber(app.pypi_last_week_downloads),
        geminiStars: geminiStarsFromRows(rowsByApp.get(app.app_id) ?? []),
        starsCarriedForward: app.stars_carried_forward === true,
        useCountCarriedForward: app.use_count_carried_forward === true,
        npmCarriedForward: app.npm_weekly_downloads_carried_forward === true,
        pypiCarriedForward: app.pypi_last_week_downloads_carried_forward === true,
      });
      history.set(app.app_id, points);
    }
  }

  const apps: AppSummary[] = [...latestApps.values()]
    .map((row) => {
      const sources = parseSources(row.sources);
      const extra = latestSourceRows.get(row.app_id) ?? [];
      return {
        id: row.app_id,
        name: row.name,
        displayName: displayName(row),
        description: row.description,
        homepage: row.homepage,
        repoUrl: row.repo_url,
        npmPackage: row.npm_package,
        pypiPackage: row.pypi_package,
        sources,
        stores: storesOf(sources),
        category: classifyCategory(displayName(row), row.description),
        firstSeen: firstSeen.get(row.app_id) ?? row.snapshot_date,
        lastSeen: row.snapshot_date,
        stars: asNumber(row.stars),
        forks: asNumber(row.forks),
        openIssues: asNumber(row.open_issues),
        pushedAt: row.pushed_at,
        useCount: asNumber(row.use_count),
        npmWeeklyDownloads: asNumber(row.npm_weekly_downloads),
        pypiLastWeekDownloads: asNumber(row.pypi_last_week_downloads),
        geminiStars: geminiStarsFromRows(extra),
        verified: verifiedFromRows(extra),
        starsSource: row.stars_source ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const series: Record<string, CompactSeries> = {};
  for (const app of apps) {
    const packed = compact(history.get(app.id) ?? [], snapshotDates);
    if (Object.keys(packed).length > 0) {
      series[app.id] = packed;
    }
  }

  let coverage: CoverageRow[] = [];
  if (latestDate) {
    coverage = (coverageFromManifest(readManifest(latestDate, dataDir)) ?? []).map((row) => ({
      source: row.source,
      coverage: row.coverage,
      eligibleCount: row.eligibleCount,
      freshWithin7dCount: row.freshWithin7dCount,
      fetchedThisRunCount: row.fetchedThisRunCount,
      skipped: row.skipped,
    }));
  }

  const stats = computeHeadlineStats(apps, snapshotDates, latestDate, previousDate, week);
  return {
    meta: {
      builtAt: new Date().toISOString(),
      origin,
      snapshotDates,
      latestDate,
      previousDate,
      weekAgoDate: week === latestDate ? null : week,
      partialDates,
      latestCompleteDate,
      previousCompleteDate,
      coverage,
    },
    stats,
    apps,
    series,
    answerShare: loadPublicAnswerShare(dataDir),
  };
}

export function computeHeadlineStats(
  apps: AppSummary[],
  snapshotDates: string[],
  latestDate: string | null,
  previousDate: string | null,
  weekAgoDate: string | null,
): HeadlineStats {
  const storeSet = new Set<string>();
  let totalUseCount = 0;
  let totalStars = 0;
  let totalNpmWeekly = 0;
  let multiStoreCount = 0;
  let newArrivalCount = 0;
  const categories = new Set<string>();
  for (const app of apps) {
    for (const store of app.stores) {
      storeSet.add(store);
    }
    totalUseCount += app.useCount ?? 0;
    totalStars += app.stars ?? 0;
    totalNpmWeekly += app.npmWeeklyDownloads ?? 0;
    if (app.stores.length >= 2) {
      multiStoreCount += 1;
    }
    if (latestDate && app.firstSeen === latestDate) {
      newArrivalCount += 1;
    }
    categories.add(app.category);
  }
  return {
    appCount: apps.length,
    storeCount: storeSet.size,
    snapshotCount: snapshotDates.length,
    latestDate,
    previousDate,
    weekAgoDate: weekAgoDate === latestDate ? null : weekAgoDate,
    totalUseCount,
    totalStars,
    totalNpmWeekly,
    multiStoreCount,
    newArrivalCount,
    categoryCount: categories.size,
  };
}
