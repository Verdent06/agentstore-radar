export const REPO_URL = "https://github.com/Verdent06/agentstore-radar";
export const USER_AGENT = `agentstore-radar/0.1 (+${REPO_URL})`;

export const RAW_GZIP_THRESHOLD_BYTES = 256 * 1024;
export const HEALTH_DROP_THRESHOLD = 0.3;
export const LOW_COVERAGE_THRESHOLD = 0.7;

/** Show a KPI only when today's fresh row count is within this fraction of the baseline. */
export const KPI_FRESH_COVERAGE_TOLERANCE = 0.1;

/**
 * Per-source minimum fresh share (fresh / eligible) for a complete day to be
 * a KPI baseline candidate, and for today's tile to show. Applied independently
 * to GitHub, npm, and PyPI — not a walk versus the previous day.
 */
export const KPI_MIN_FRESH_SHARE = 0.8;
export const MAX_RATE_LIMIT_WAIT_MS = 70 * 60 * 1000;
export const HTTP_MAX_RETRIES = 6;
export const HTTP_5XX_MAX_WAIT_MS = 60_000;
export const SOURCE_COLLECT_ATTEMPTS = 3;
export const SOURCE_RETRY_BASE_MS = 2_000;
export const SOURCE_RETRY_MAX_WAIT_MS = 30_000;
export const GIT_PUSH_ATTEMPTS = 5;
export const COLLECTOR_ISSUE_REPO_DEFAULT = "Verdent06/agentstore-radar";
export const COLLECTOR_MISSED_LABEL = "collector-missed";

export const HOST_MIN_INTERVAL_MS: Record<string, number> = {
  "registry.modelcontextprotocol.io": 150,
  "api.smithery.ai": 120,
  "api.github.com": 200,
  "api.npmjs.org": 200,
  "pypistats.org": 400,
  "geminicli.com": 200,
  "api.openai.com": 250,
  "api.anthropic.com": 250,
  "generativelanguage.googleapis.com": 250,
  "api.x.ai": 250,
};

export const MCP_REGISTRY_BASE = "https://registry.modelcontextprotocol.io";
export const MCP_SERVERS_PATH = "/v0.1/servers";
export const SMITHERY_SERVERS_URL = "https://api.smithery.ai/servers";
export const SMITHERY_STABLE_SEED = 1;
export const GEMINI_EXTENSIONS_URL = "https://geminicli.com/extensions.json";
export const NPM_DOWNLOADS_BASE = "https://api.npmjs.org/downloads/point/last-week";
export const PYPISTATS_BASE = "https://pypistats.org/api/packages";
export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

export const NPM_BULK_LIMIT = 128;
export const NPM_SCOPED_MIN_INTERVAL_MS = 250;
export const NPM_BULK_MIN_INTERVAL_MS = 200;
/**
 * Scoped npm packages cannot use the bulk endpoint. 8 in flight, one shared
 * 429 pause. Downloads pass `maxRetries: 0` so the first 429 reaches that
 * pause instead of sleeping inside the HTTP client. A positive Retry-After
 * is honored; a missing or zero header still floors at 15s.
 */
export const NPM_SCOPED_CONCURRENCY = 8;
export const PYPI_MIN_INTERVAL_MS = 400;
/** pypistats recent calls in flight. Host interval still spaces starts. */
export const PYPI_CONCURRENCY = 4;
/**
 * Per-run enrichment caps. Defaults cover the current catalog (~32k GitHub,
 * ~14k npm, ~5k PyPI). A wall-clock budget (below) can still end a source
 * early; the same-day backstop resumes from the checkpoint.
 * Tests and emergency throttling override via RADAR_*_BATCH.
 * Smithery overlay `?q=` is a thaw probe of the same frozen index
 * (400 × 120ms ≈ 48s), not the fetchedShare driver. Raising overlay to 80%
 * of the catalog would be ~16.6k searches ≈ 33 min of the same frozen values,
 * so we do not. fetchedShare counts only fresh rows (carried_forward false
 * and frozen not true), so a source-frozen catalog scores ~0.
 */
/**
 * Per-source wall-clock budgets. Sum is 245 minutes, under the 300-minute
 * target and inside the 330-minute collect step. One in-flight HTTP call can
 * still finish after the check (30s timeout), so the worst case is 248 minutes.
 * The checkpoint/partial path remains if a source still overruns.
 * Override with RADAR_<SOURCE>_BUDGET_MS.
 *
 * npm and PyPI are sized from a live sample on 2026-11-03 (see docs/SOURCES.md):
 * full npm pass ~34 min once scoped 429s hit the shared pool, full PyPI pass
 * ~33 min, plus margin. The 2026-11-04 run spent the whole npm budget inside
 * scoped packages because the HTTP client retried 429s itself at a 15s floor.
 * The other sources keep headroom over the 2026-11-03 run (mcp ~2m, smithery
 * ~6m, gemini <1m, github ~24m).
 */
export const MCP_COLLECT_BUDGET_MS = 15 * 60 * 1000;
export const SMITHERY_COLLECT_BUDGET_MS = 20 * 60 * 1000;
export const GEMINI_COLLECT_BUDGET_MS = 5 * 60 * 1000;
export const GITHUB_COLLECT_BUDGET_MS = 50 * 60 * 1000;
export const NPM_COLLECT_BUDGET_MS = 100 * 60 * 1000;
export const PYPI_COLLECT_BUDGET_MS = 55 * 60 * 1000;
export const GITHUB_RUN_BATCH = 50_000;
export const NPM_RUN_BATCH = 20_000;
export const PYPI_RUN_BATCH = 10_000;
export const SMITHERY_USECOUNT_RUN_BATCH = 400;
/**
 * Stop Smithery `?q=` useCount lookups after this many consecutive HTTP 5xx
 * or network failures in one run. A successful response resets the streak.
 * Override with RADAR_SMITHERY_CIRCUIT_BREAKER.
 */
export const SMITHERY_USECOUNT_CIRCUIT_BREAKER_THRESHOLD = 10;

export function runBatchSize(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}

const SOURCE_BUDGET_MS = {
  "mcp-registry": { ms: MCP_COLLECT_BUDGET_MS, env: "RADAR_MCP_BUDGET_MS" },
  smithery: { ms: SMITHERY_COLLECT_BUDGET_MS, env: "RADAR_SMITHERY_BUDGET_MS" },
  "gemini-cli": { ms: GEMINI_COLLECT_BUDGET_MS, env: "RADAR_GEMINI_BUDGET_MS" },
  github: { ms: GITHUB_COLLECT_BUDGET_MS, env: "RADAR_GITHUB_BUDGET_MS" },
  npm: { ms: NPM_COLLECT_BUDGET_MS, env: "RADAR_NPM_BUDGET_MS" },
  pypi: { ms: PYPI_COLLECT_BUDGET_MS, env: "RADAR_PYPI_BUDGET_MS" },
} as const;

export type BudgetSourceName = keyof typeof SOURCE_BUDGET_MS;

/** Wall-clock budget for one source. `RADAR_*_BUDGET_MS` overrides the default. */
export function sourceBudgetMs(env: NodeJS.ProcessEnv, source: BudgetSourceName): number {
  const entry = SOURCE_BUDGET_MS[source];
  return runBatchSize(env, entry.env, entry.ms);
}
export const SMITHERY_USECOUNT_PAGE_SIZE = 10;
/** Snapshot days of identical catalog metrics (including today) before a value can be frozen. */
export const SMITHERY_FROZEN_DAYS = 3;
/** Treat the whole source as frozen when at least this share of rows is unchanged for N days. */
export const SOURCE_FREEZE_RATIO = 0.95;
/** Mark npm truncated/partial when more than this share of due keys fail in a completed pass. */
export const NPM_PARTIAL_FAILURE_RATIO = 0.2;
export const RATE_LIMIT_MIN_WAIT_MS = 15_000;
export const GITHUB_GRAPHQL_BATCH = 100;

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const GEMINI_GENERATE_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";

export const ANSWER_SHARE_DEFAULT_N = 3;
export const ANSWER_SHARE_PROMPT_VERSION = "v1";
export const ANSWER_SHARE_TEMPERATURE = 0.8;
export const ANSWER_SHARE_REQUEST_TIMEOUT_MS = 90_000;
