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
  "api.npmjs.org": 1000,
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
export const NPM_SCOPED_MIN_INTERVAL_MS = 1200;
export const NPM_BULK_MIN_INTERVAL_MS = 500;
export const PYPI_MIN_INTERVAL_MS = 400;
/** Per-run enrichment caps so one collect finishes inside the Actions time limit. */
export const GITHUB_RUN_BATCH = 4000;
export const NPM_RUN_BATCH = 1500;
export const PYPI_RUN_BATCH = 800;
export const SMITHERY_USECOUNT_RUN_BATCH = 400;

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
export const SMITHERY_USECOUNT_PAGE_SIZE = 10;
/** Snapshot days of identical catalog metrics (including today) before a value can be frozen. */
export const SMITHERY_FROZEN_DAYS = 3;
/** Treat the whole source as frozen when at least this share of rows is unchanged for N days. */
export const SOURCE_FREEZE_RATIO = 0.95;
/** Mark npm truncated/partial when more than this share of due keys fail in a completed pass. */
export const NPM_PARTIAL_FAILURE_RATIO = 0.2;
export const RATE_LIMIT_MIN_WAIT_MS = 15_000;
export const GITHUB_GRAPHQL_BATCH = 50;

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const GEMINI_GENERATE_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";

export const ANSWER_SHARE_DEFAULT_N = 3;
export const ANSWER_SHARE_PROMPT_VERSION = "v1";
export const ANSWER_SHARE_TEMPERATURE = 0.8;
export const ANSWER_SHARE_REQUEST_TIMEOUT_MS = 90_000;
