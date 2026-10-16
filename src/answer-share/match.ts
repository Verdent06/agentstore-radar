import type { AppRow } from "../lib/schema.ts";
import type { ExtractedMention, MatchMethod, NormalizedMention } from "./schema.ts";

export type CatalogEntry = {
  app_id: string;
  label: string;
  keys: string[];
};

export type MentionMatch = {
  matched_app_id: string | null;
  match_method: MatchMethod | null;
  match_score: number | null;
  label?: string;
};

const STRIP_TOKENS = new Set([
  "mcp",
  "server",
  "servers",
  "connector",
  "connectors",
  "plugin",
  "plugins",
  "app",
  "apps",
  "extension",
  "extensions",
  "official",
  "api",
  "sdk",
  "cli",
  "the",
]);

/** Canonical key -> alternative surface names. */
export const TOOL_ALIASES: Record<string, string[]> = {
  github: ["gh", "github mcp", "github.com", "github server", "github mcp server"],
  gitlab: ["gl", "gitlab mcp", "gitlab.com"],
  slack: ["slack mcp", "slack connector"],
  notion: ["notion mcp", "notion api"],
  stripe: ["stripe mcp", "stripe api"],
  filesystem: ["fs", "filesystem mcp", "local files", "file system", "files mcp"],
  postgres: ["postgresql", "postgres mcp", "psql", "postgresql mcp"],
  playwright: ["playwright mcp", "playwright browser"],
  linear: ["linear mcp", "linear.app"],
  jira: ["atlassian jira", "jira mcp"],
  figma: ["figma mcp", "figma api"],
  gmail: ["google mail", "gmail mcp"],
  "google drive": ["gdrive", "drive mcp", "google drive mcp"],
  "google calendar": ["gcal", "calendar mcp"],
  "google analytics": ["ga4", "google analytics 4"],
  bigquery: ["big query", "bq"],
  snowflake: ["snowflake mcp"],
  databricks: ["databricks mcp"],
  airtable: ["airtable mcp"],
  sentry: ["sentry mcp", "sentry.io"],
  datadog: ["datadog mcp"],
  pagerduty: ["pager duty"],
  vercel: ["vercel mcp"],
  heroku: ["heroku mcp"],
  kubernetes: ["k8s", "kubectl", "kubernetes mcp"],
  docker: ["docker mcp"],
  terraform: ["terraform mcp"],
  prometheus: ["promql", "prometheus mcp"],
  grafana: ["grafana mcp"],
  elasticsearch: ["elastic", "elk"],
  mixpanel: ["mixpanel mcp"],
  metabase: ["metabase mcp"],
  dbt: ["dbt mcp", "dbt core"],
  hubspot: ["hubspot mcp"],
  zendesk: ["zendesk mcp"],
  asana: ["asana mcp"],
  todoist: ["todoist mcp"],
  obsidian: ["obsidian mcp"],
  zotero: ["zotero mcp"],
  arxiv: ["ar xiv"],
  brave: ["brave search", "brave mcp", "brave-search-mcp"],
  supabase: ["supabase mcp"],
  cloudwatch: ["aws cloudwatch", "cloud watch"],
  "github actions": ["gh actions", "actions logs"],
};

export function normalizeToolName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/www\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STRIP_TOKENS.has(token))
    .join(" ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  const prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  const curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j += 1) {
      prev[j] = curr[j] ?? 0;
    }
  }
  return prev[b.length] ?? 0;
}

export function stringSimilarity(a: string, b: string): number {
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

function tokenJaccard(a: string, b: string): number {
  const left = new Set(a.split(" ").filter(Boolean));
  const right = new Set(b.split(" ").filter(Boolean));
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const token of left) {
    if (right.has(token)) {
      inter += 1;
    }
  }
  return inter / (left.size + right.size - inter);
}

function aliasGroups(): Map<string, string> {
  const canonical = new Map<string, string>();
  for (const [name, aliases] of Object.entries(TOOL_ALIASES)) {
    const key = normalizeToolName(name);
    canonical.set(key, key);
    for (const alias of aliases) {
      canonical.set(normalizeToolName(alias), key);
    }
  }
  return canonical;
}

const ALIAS_TO_CANONICAL = aliasGroups();

export function canonicalToolKey(name: string): string {
  const normalized = normalizeToolName(name);
  return ALIAS_TO_CANONICAL.get(normalized) ?? normalized;
}

function appKeys(app: AppRow): string[] {
  const raw = [
    app.name,
    app.display_name,
    app.npm_package,
    app.pypi_package,
    app.repo_url,
    app.homepage,
    app.app_id,
  ];
  const keys = new Set<string>();
  for (const value of raw) {
    if (!value) {
      continue;
    }
    const normalized = normalizeToolName(value);
    if (normalized) {
      keys.add(normalized);
      keys.add(canonicalToolKey(value));
    }
    const slash = value.split("/").filter(Boolean).at(-1);
    if (slash) {
      const repo = normalizeToolName(slash.replace(/\.git$/i, ""));
      if (repo) {
        keys.add(repo);
        keys.add(canonicalToolKey(slash));
      }
    }
    if (value.includes(":")) {
      const after = normalizeToolName(value.slice(value.indexOf(":") + 1));
      if (after) {
        keys.add(after);
      }
    }
  }
  return [...keys].filter(Boolean);
}

export function buildAppIndex(apps: AppRow[]): CatalogEntry[] {
  return apps.map((app) => ({
    app_id: app.app_id,
    label: app.display_name ?? app.name,
    keys: appKeys(app),
  }));
}

const FUZZY_THRESHOLD = 0.84;

export function matchMentionName(name: string, catalog: CatalogEntry[]): MentionMatch {
  const normalized = normalizeToolName(name);
  const canonical = canonicalToolKey(name);
  if (!normalized) {
    return { matched_app_id: null, match_method: null, match_score: null };
  }

  const best: { entry: CatalogEntry | null; method: MatchMethod; score: number } = {
    entry: null,
    method: "fuzzy",
    score: 0,
  };

  const consider = (entry: CatalogEntry, method: MatchMethod, score: number): void => {
    if (score > best.score) {
      best.entry = entry;
      best.method = method;
      best.score = score;
    }
  };

  for (const entry of catalog) {
    for (const key of entry.keys) {
      if (key === normalized) {
        const aliased = ALIAS_TO_CANONICAL.get(normalized);
        consider(entry, aliased && aliased !== normalized ? "alias" : "exact", 1);
        continue;
      }
      if (key === canonical || (ALIAS_TO_CANONICAL.get(key) === canonical && canonical.length > 0)) {
        consider(entry, "alias", 0.95);
        continue;
      }
      if (key.length >= 4 && normalized.length >= 4 && (key.includes(normalized) || normalized.includes(key))) {
        const contained = Math.min(key.length, normalized.length) / Math.max(key.length, normalized.length);
        if (contained >= 0.6) {
          consider(entry, "fuzzy", 0.86 + 0.1 * contained);
        }
      }
      const similarity = Math.max(stringSimilarity(normalized, key), tokenJaccard(normalized, key));
      if (similarity >= FUZZY_THRESHOLD) {
        consider(entry, "fuzzy", similarity);
      }
    }
  }

  if (!best.entry) {
    return { matched_app_id: null, match_method: null, match_score: null };
  }
  return {
    matched_app_id: best.entry.app_id,
    match_method: best.method,
    match_score: Number(best.score.toFixed(4)),
    label: best.entry.label,
  };
}

export function normalizeMentions(mentions: ExtractedMention[], apps: AppRow[]): NormalizedMention[] {
  const catalog = buildAppIndex(apps);
  return mentions.map((mention) => {
    const match = matchMentionName(mention.name, catalog);
    return {
      ...mention,
      matched_app_id: match.matched_app_id,
      match_method: match.match_method,
      match_score: match.match_score,
    };
  });
}
