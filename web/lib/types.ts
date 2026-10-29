export const CHART_IDS = ["npm", "github", "gemini"] as const;
export type ChartId = (typeof CHART_IDS)[number];

export type MetricKey =
  | "stars"
  | "npm_weekly_downloads"
  | "pypi_last_week_downloads"
  | "gemini_stars";

export type CategorySlug =
  | "search"
  | "rag"
  | "browser"
  | "database"
  | "filesystem"
  | "git"
  | "communication"
  | "memory"
  | "cloud"
  | "finance"
  | "design"
  | "maps"
  | "calendar"
  | "ai"
  | "security"
  | "docs"
  | "devtools"
  | "other";

export type StoreSource = "mcp-registry" | "smithery" | "gemini-cli" | "npm" | "pypi";

export type AppSummary = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  homepage: string | null;
  repoUrl: string | null;
  npmPackage: string | null;
  pypiPackage: string | null;
  sources: string[];
  stores: StoreSource[];
  category: CategorySlug;
  firstSeen: string;
  lastSeen: string;
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  pushedAt: string | null;
  npmWeeklyDownloads: number | null;
  pypiLastWeekDownloads: number | null;
  geminiStars: number | null;
  verified: boolean | null;
  starsSource?: string | null;
};

export type CompactSeries = {
  s?: Array<number | null>;
  n?: Array<number | null>;
  p?: Array<number | null>;
  g?: Array<number | null>;
  sc?: Array<0 | 1 | null>;
  nc?: Array<0 | 1 | null>;
  pc?: Array<0 | 1 | null>;
  ss?: Array<string | null>;
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

export type CoverageRow = {
  source: string;
  coverage?: number;
  eligibleCount?: number;
  freshTodayCount?: number;
  freshWithin7dCount?: number;
  fetchedThisRunCount?: number;
  fetchedCount?: number;
  skipped: boolean;
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
  meta: {
    builtAt: string;
    origin: "data_dir" | "github" | "fixture";
    source: "private" | "fixture";
    snapshotDates: string[];
    latestDate: string | null;
    previousDate: string | null;
    weekAgoDate: string | null;
    partialDates?: string[];
    latestCompleteDate?: string | null;
    previousCompleteDate?: string | null;
    coverage: CoverageRow[];
  };
  stats: HeadlineStats;
  apps: AppSummary[];
  series: Record<string, CompactSeries>;
  answerShare: AnswerSharePublic | null;
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
  growth: string | null;
};

export const CHART_META: Record<ChartId, { title: string; metric: MetricKey; unit: string; blurb: string }> = {
  npm: {
    title: "npm weekly downloads",
    metric: "npm_weekly_downloads",
    unit: "downloads / week",
    blurb: "Last-week download counts from the npm public API.",
  },
  github: {
    title: "GitHub stars",
    metric: "stars",
    unit: "stars",
    blurb: "Repository stargazer counts from GitHub GraphQL.",
  },
  gemini: {
    title: "Gemini CLI gallery",
    metric: "gemini_stars",
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
  stars: "GitHub stars",
  npm_weekly_downloads: "npm weekly downloads",
  pypi_last_week_downloads: "PyPI weekly downloads",
  gemini_stars: "Gemini gallery stars",
};

export const STORE_LABELS: Record<string, string> = {
  "mcp-registry": "MCP Registry",
  smithery: "Smithery",
  "gemini-cli": "Gemini CLI",
  npm: "npm",
  pypi: "PyPI",
  github: "GitHub",
};
