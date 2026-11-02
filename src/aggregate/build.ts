import { coverageFromManifest } from "../commands/report.ts";
import { addUtcDays } from "../lib/dates.ts";
import { listSnapshotDates, readApps, readManifest, readSourceRows } from "../lib/io.ts";
import { snapshotIsPartial, type AppRow, type SourceName, type SourceRow } from "../lib/schema.ts";
import { loadPublicAnswerShare } from "./answer-share.ts";
import { classifyCategory } from "./classify.ts";
import {
  HISTORY_CAP_DAYS,
  roundAppMetrics,
  roundHeadlineStats,
  roundSeries,
} from "./public.ts";
import { publicAppIds } from "./query.ts";
import {
  coverageSeriesForSource,
  decideKpiFreshCoverage,
  isFreshKpiValue,
  type KpiSource,
} from "./kpi-coverage.ts";
import {
  STORE_SOURCES,
  type Aggregate,
  type AppSummary,
  type CompactSeries,
  type CoverageRow,
  type DataOrigin,
  type HeadlineStats,
  type StoreSource,
  sourceFromOrigin,
} from "./types.ts";

export { isFreshKpiValue } from "./kpi-coverage.ts";

type PackedPoint = {
  date: string;
  stars: number | null;
  npmWeeklyDownloads: number | null;
  pypiLastWeekDownloads: number | null;
  geminiStars: number | null;
  starsCarriedForward?: boolean;
  npmCarriedForward?: boolean;
  pypiCarriedForward?: boolean;
  starsSource?: string | null;
};

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
  const wanted = addUtcDays(latest, -7);
  const earlier = dates.filter((date) => date <= wanted);
  return earlier.at(-1) ?? dates[0] ?? null;
}

function compact(points: PackedPoint[], dates: string[]): CompactSeries {
  const byDate = new Map(points.map((point) => [point.date, point]));
  const flag = (carried: boolean | undefined): 0 | 1 => (carried ? 1 : 0);
  const series: CompactSeries = {
    s: dates.map((date) => byDate.get(date)?.stars ?? null),
    n: dates.map((date) => byDate.get(date)?.npmWeeklyDownloads ?? null),
    p: dates.map((date) => byDate.get(date)?.pypiLastWeekDownloads ?? null),
    g: dates.map((date) => byDate.get(date)?.geminiStars ?? null),
    sc: dates.map((date) => flag(byDate.get(date)?.starsCarriedForward)),
    nc: dates.map((date) => flag(byDate.get(date)?.npmCarriedForward)),
    pc: dates.map((date) => flag(byDate.get(date)?.pypiCarriedForward)),
    ss: dates.map((date) => byDate.get(date)?.starsSource ?? null),
  };
  const pruneValues = (key: "s" | "n" | "p" | "g") => {
    if (series[key]?.every((value) => value == null)) {
      delete series[key];
    }
  };
  const pruneFlags = (key: "sc" | "nc" | "pc") => {
    if (series[key]?.every((value) => value == null || value === 0)) {
      delete series[key];
    }
  };
  pruneValues("s");
  pruneValues("n");
  pruneValues("p");
  pruneValues("g");
  pruneFlags("sc");
  pruneFlags("nc");
  pruneFlags("pc");
  if (series.ss?.every((value) => value == null)) {
    delete series.ss;
  }
  return series;
}

export function buildAggregate(dataDir: string, origin: DataOrigin = "data_dir"): Aggregate {
  const allDates = listSnapshotDates(dataDir);
  const allPartial = allDates.filter((date) => {
    try {
      return snapshotIsPartial(readManifest(date, dataDir));
    } catch {
      return false;
    }
  });
  const allComplete = allDates.filter((date) => !allPartial.includes(date));
  const fromComplete = allComplete.at(-HISTORY_CAP_DAYS) ?? allComplete[0] ?? null;
  const toComplete = allComplete.at(-1) ?? null;
  const snapshotDates =
    fromComplete && toComplete ? allDates.filter((date) => date >= fromComplete && date <= toComplete) : [];
  const partialDates = snapshotDates.filter((date) => allPartial.includes(date));
  const completeDates = snapshotDates.filter((date) => !partialDates.includes(date));
  const latestDate = snapshotDates.at(-1) ?? null;
  const previousDate = snapshotDates.length >= 2 ? snapshotDates.at(-2) ?? null : null;
  const latestCompleteDate = completeDates.at(-1) ?? null;
  const previousCompleteDate = completeDates.length >= 2 ? completeDates.at(-2) ?? null : null;
  const week = latestCompleteDate ? weekAgoDate(completeDates, latestCompleteDate) : null;

  const firstSeen = new Map<string, string>();
  const history = new Map<string, PackedPoint[]>();
  const latestApps = new Map<string, AppRow>();
  const latestSourceRows = new Map<string, SourceRow[]>();
  const appsByDate = new Map<string, AppRow[]>();
  let latestCompleteRows: AppRow[] = [];

  for (const date of snapshotDates) {
    const apps = readApps(date, dataDir);
    const sourceRows = readSourceRows(date, dataDir);
    const rowsByApp = new Map<string, SourceRow[]>();
    for (const row of sourceRows) {
      const list = rowsByApp.get(row.app_id) ?? [];
      list.push(row);
      rowsByApp.set(row.app_id, list);
    }
    appsByDate.set(date, apps);
    if (date === latestCompleteDate) {
      latestCompleteRows = apps;
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
        npmWeeklyDownloads: asNumber(app.npm_weekly_downloads),
        pypiLastWeekDownloads: asNumber(app.pypi_last_week_downloads),
        geminiStars: geminiStarsFromRows(rowsByApp.get(app.app_id) ?? []),
        starsCarriedForward: app.stars_carried_forward === true,
        npmCarriedForward: app.npm_weekly_downloads_carried_forward === true,
        pypiCarriedForward: app.pypi_last_week_downloads_carried_forward === true,
        starsSource: app.stars_source ?? null,
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
      freshTodayCount: row.freshTodayCount,
      freshWithin7dCount: row.freshWithin7dCount,
      fetchedThisRunCount: row.fetchedThisRunCount,
      fetchedShare: row.fetchedShare,
      skipped: row.skipped,
    }));
  }

  const stats = computeHeadlineStats(
    apps,
    snapshotDates,
    latestDate,
    previousDate,
    week,
    latestCompleteDate,
    latestCompleteRows,
    completeDates,
    appsByDate,
  );
  const draft: Aggregate = {
    meta: {
      builtAt: new Date().toISOString(),
      origin,
      source: sourceFromOrigin(origin),
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
  return applyPublicTier(draft);
}

function applyPublicTier(agg: Aggregate): Aggregate {
  const allowed = publicAppIds(agg);
  const apps = agg.apps.filter((app) => allowed.has(app.id)).map(roundAppMetrics);
  const series: Record<string, CompactSeries> = {};
  for (const app of apps) {
    const packed = agg.series[app.id];
    if (packed) {
      series[app.id] = roundSeries(packed);
    }
  }
  return {
    ...agg,
    stats: roundHeadlineStats(agg.stats),
    apps,
    series,
  };
}

export function computeHeadlineStats(
  apps: AppSummary[],
  snapshotDates: string[],
  latestDate: string | null,
  previousDate: string | null,
  weekAgoDate: string | null,
  latestCompleteDate: string | null = null,
  latestRows: AppRow[] = [],
  completeDates: string[] = [],
  rowsByCompleteDate: Map<string, AppRow[]> | Record<string, AppRow[]> = new Map(),
): HeadlineStats {
  const storeSet = new Set<string>();
  let totalStars = 0;
  let totalNpmWeekly = 0;
  let multiStoreCount = 0;
  let newArrivalCount = 0;
  const categories = new Set<string>();
  for (const app of apps) {
    for (const store of app.stores) {
      storeSet.add(store);
    }
    if (app.stores.length >= 2) {
      multiStoreCount += 1;
    }
    if (latestDate && app.firstSeen === latestDate) {
      newArrivalCount += 1;
    }
    categories.add(app.category);
  }
  // Home KPI totals: only rows from latestCompleteDate, then the freshness rule.
  for (const row of latestRows) {
    if (!latestCompleteDate || row.snapshot_date !== latestCompleteDate) {
      continue;
    }
    if (isFreshKpiValue(row.stars_carried_forward, row.stars_frozen) && row.stars != null) {
      totalStars += row.stars;
    }
    if (
      isFreshKpiValue(row.npm_weekly_downloads_carried_forward, row.npm_weekly_downloads_frozen) &&
      row.npm_weekly_downloads != null
    ) {
      totalNpmWeekly += row.npm_weekly_downloads;
    }
  }
  const datesForCoverage = completeDates.length > 0 ? completeDates : latestCompleteDate ? [latestCompleteDate] : [];
  const rowsForCoverage: Map<string, AppRow[]> | Record<string, AppRow[]> =
    rowsByCompleteDate instanceof Map
      ? rowsByCompleteDate.size > 0
        ? rowsByCompleteDate
        : new Map(latestCompleteDate ? [[latestCompleteDate, latestRows]] : [])
      : Object.keys(rowsByCompleteDate).length > 0
        ? rowsByCompleteDate
        : latestCompleteDate
          ? { [latestCompleteDate]: latestRows }
          : {};
  const kpiHeld = (source: KpiSource) => {
    const series = coverageSeriesForSource(datesForCoverage, rowsForCoverage, source);
    return decideKpiFreshCoverage(source, series, latestCompleteDate);
  };
  const starsDecision = kpiHeld("github");
  const npmDecision = kpiHeld("npm");
  const pypiDecision = kpiHeld("pypi");
  return {
    appCount: apps.length,
    storeCount: storeSet.size,
    snapshotCount: snapshotDates.length,
    latestDate,
    previousDate,
    weekAgoDate: weekAgoDate === latestDate ? null : weekAgoDate,
    totalStars,
    totalNpmWeekly,
    multiStoreCount,
    newArrivalCount,
    categoryCount: categories.size,
    starsKpiHeld: starsDecision.held,
    npmKpiHeld: npmDecision.held,
    pypiKpiHeld: pypiDecision.held,
    starsFreshCount: starsDecision.today?.freshCount ?? 0,
    npmFreshCount: npmDecision.today?.freshCount ?? 0,
    pypiFreshCount: pypiDecision.today?.freshCount ?? 0,
  };
}
