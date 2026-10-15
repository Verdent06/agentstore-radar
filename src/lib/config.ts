export const REPO_URL = "https://github.com/Verdent06/agentstore-radar";
export const USER_AGENT = `agentstore-radar/0.1 (+${REPO_URL})`;

export const RAW_GZIP_THRESHOLD_BYTES = 256 * 1024;
export const HEALTH_DROP_THRESHOLD = 0.3;

export const HOST_MIN_INTERVAL_MS: Record<string, number> = {
  "registry.modelcontextprotocol.io": 150,
  "api.smithery.ai": 150,
  "api.github.com": 80,
  "api.npmjs.org": 150,
  "pypistats.org": 400,
  "geminicli.com": 200,
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
export const GITHUB_GRAPHQL_BATCH = 40;
