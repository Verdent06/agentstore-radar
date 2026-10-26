import type { SourceName } from "../lib/schema.ts";

export const CHART_IDS = ["npm", "github", "gemini"] as const;
export type ChartId = (typeof CHART_IDS)[number];

export const METRIC_KEYS = [
  "use_count",
  "stars",
  "npm_weekly_downloads",
  "pypi_last_week_downloads",
  "gemini_stars",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export const CATEGORY_SLUGS = [
  "search",
  "rag",
  "browser",
  "database",
  "filesystem",
  "git",
  "communication",
  "memory",
  "cloud",
  "finance",
  "design",
  "maps",
  "calendar",
  "ai",
  "security",
  "docs",
  "devtools",
  "other",
] as const;
export type CategorySlug = (typeof CATEGORY_SLUGS)[number];

export const STORE_SOURCES = ["mcp-registry", "smithery", "gemini-cli", "npm", "pypi"] as const;
export type StoreSource = (typeof STORE_SOURCES)[number];

export type DataOrigin = "data_dir" | "github" | "fixture";
/** Coarse origin recorded on radar.json: live private data vs bundled demo fixtures. */
export type DataSource = "private" | "fixture";

export function sourceFromOrigin(origin: DataOrigin): DataSource {
  return origin === "fixture" ? "fixture" : "private";
}

export type AppSummary = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  homepage: string | null;
  repoUrl: string | null;
  npmPackage: string | null;
  pypiPackage: string | null;
  sources: SourceName[];
  stores: StoreSource[];
  category: CategorySlug;
  firstSeen: string;
  lastSeen: string;
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  pushedAt: string | null;
  useCount: number | null;
  npmWeeklyDownloads: number | null;
  pypiLastWeekDownloads: number | null;
  geminiStars: number | null;
  verified: boolean | null;
  starsSource?: string | null;
};

export type HistoryGap = "partial" | "carried_forward" | "missing";

export type HistoryPoint = {
  date: string;
  stars: number | null;
  npmWeeklyDownloads: number | null;
  pypiLastWeekDownloads: number | null;
  geminiStars: number | null;
  starsGap?: HistoryGap | null;
  npmGap?: HistoryGap | null;
  pypiGap?: HistoryGap | null;
  geminiGap?: HistoryGap | null;
  starsGrowth?: string | null;
  npmGrowth?: string | null;
  pypiGrowth?: string | null;
  geminiGrowth?: string | null;
};

/** Parallel arrays aligned to `meta.snapshotDates`. Omitted when every value is null. */
export type CompactSeries = {
  s?: Array<number | null>;
  u?: Array<number | null>;
  n?: Array<number | null>;
  p?: Array<number | null>;
  g?: Array<number | null>;
  /** 1 when the aligned metric was carried forward from an older fetch. */
  sc?: Array<0 | 1 | null>;
  uc?: Array<0 | 1 | null>;
  nc?: Array<0 | 1 | null>;
  pc?: Array<0 | 1 | null>;
  /** Stars source (`github`, `gemini-cli`, …) aligned to `meta.snapshotDates`. */
  ss?: Array<string | null>;
};

export type CoverageRow = {
  source: string;
  coverage?: number;
  eligibleCount?: number;
  freshTodayCount?: number;
  freshWithin7dCount?: number;
  fetchedThisRunCount?: number;
  fetchedCount?: number;
  skipped: boolean;
  rowCount?: number;
};

export type HeadlineStats = {
  appCount: number;
  storeCount: number;
  snapshotCount: number;
  latestDate: string | null;
  previousDate: string | null;
  weekAgoDate: string | null;
  totalStars: number;
  totalNpmWeekly: number;
  multiStoreCount: number;
  newArrivalCount: number;
  categoryCount: number;
};

export type RankedApp = {
  rank: number;
  previousRank: number | null;
  app: AppSummary;
  value: number;
  previousValue: number | null;
  delta: number | null;
};

export type MoverRow = {
  id: string;
  name: string;
  category: CategorySlug;
  metric: MetricKey;
  previous: number;
  current: number;
  delta: number;
  /** Bucketed percent change; never an exact fraction. */
  growth: string | null;
};

export type CategorySummary = {
  slug: CategorySlug;
  label: string;
  appCount: number;
  stars: number;
  newThisSnapshot: number;
};

export type CategoryTrendPoint = {
  date: string;
  appCount: number | null;
  stars: number | null;
  starsGrowth?: string | null;
  gap: HistoryGap | null;
};

export type AggregateMeta = {
  builtAt: string;
  origin: DataOrigin;
  source: DataSource;
  snapshotDates: string[];
  latestDate: string | null;
  previousDate: string | null;
  weekAgoDate: string | null;
  /** Snapshot dates `snapshotIsPartial` treated as incomplete. */
  partialDates: string[];
  latestCompleteDate?: string | null;
  previousCompleteDate?: string | null;
  coverage: CoverageRow[];
};

export type AnswerShareRowPublic = {
  name: string;
  appId: string | null;
  mentionCount: number;
  answerShare: number;
  runShare: number;
};

export type AnswerSharePublic = {
  probeDate: string;
  promptVersion: string;
  meanJaccard: number | null;
  overall: AnswerShareRowPublic[];
  byProvider: Record<string, AnswerShareRowPublic[]>;
};

export type Aggregate = {
  meta: AggregateMeta;
  stats: HeadlineStats;
  apps: AppSummary[];
  series: Record<string, CompactSeries>;
  answerShare: AnswerSharePublic | null;
};

export const CHART_META: Record<
  ChartId,
  { title: string; metric: MetricKey; source: string; unit: string; blurb: string }
> = {
  npm: {
    title: "npm weekly downloads",
    metric: "npm_weekly_downloads",
    source: "npm",
    unit: "downloads / week",
    blurb: "Last-week download counts from the npm public API.",
  },
  github: {
    title: "GitHub stars",
    metric: "stars",
    source: "github",
    unit: "stars",
    blurb: "Repository stargazer counts from GitHub GraphQL.",
  },
  gemini: {
    title: "Gemini CLI gallery",
    metric: "gemini_stars",
    source: "gemini-cli",
    unit: "gallery stars",
    blurb: "Static gallery star counts from extensions.json. App-level stars prefer live GitHub.",
  },
};

export const CATEGORY_LABELS: Record<CategorySlug, string> = {
  search: "Search",
  rag: "RAG / retrieval",
  browser: "Browser / web",
  database: "Databases",
  filesystem: "Files",
  git: "Git / GitHub",
  communication: "Communication",
  memory: "Memory",
  cloud: "Cloud / infra",
  finance: "Finance",
  design: "Design",
  maps: "Maps / location",
  calendar: "Calendar",
  ai: "AI / models",
  security: "Security",
  docs: "Docs / knowledge",
  devtools: "Dev tools",
  other: "Other",
};

export const METRIC_LABELS: Record<MetricKey, string> = {
  use_count: "Smithery use count",
  stars: "GitHub stars",
  npm_weekly_downloads: "npm weekly downloads",
  pypi_last_week_downloads: "PyPI weekly downloads",
  gemini_stars: "Gemini gallery stars",
};
