# Source research (M1)

v1 only uses sanctioned public HTTP APIs. We do **not** scrape ChatGPT, claude.ai, or any site that forbids it in ToS/robots.

User-Agent on every request: `agentstore-radar/0.1 (+https://github.com/Verdent06/agentstore-radar)`.

## Official MCP Registry

- Docs: [Official Registry API](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md)
- OpenAPI: `https://registry.modelcontextprotocol.io/openapi.yaml`
- List: `GET https://registry.modelcontextprotocol.io/v0.1/servers`
- Query: `limit` (max 100), `cursor` from `metadata.nextCursor`, `version=latest`, `updated_since` (RFC3339), `include_deleted`
- `/v0/servers` still aliases the same list as of 2026-10-15; we pin `/v0.1` to the current spec
- Daily collect takes the full latest catalog (pagination). `updated_since` is supported by the API for incremental sync but a full latest snapshot is what git-scraping needs
- Packages (`registryType` `npm` / `pypi`) and `repository.url` drive later enrichment

## Smithery

- Docs: [List all servers](https://smithery.ai/docs/api-reference/servers/list-all-servers)
- List: `GET https://api.smithery.ai/servers?page=&pageSize=100`
- Public reads worked without a key on 2026-10-15. `SMITHERY_API_KEY` is optional (`Authorization: Bearer`); 401/403 without a key skips the source instead of failing the run
- `useCount` is on the list payload (total connections)
- Search-index windows are capped at `topK` 500. **Pass a stable `seed`** (we use `1`) for deterministic deep pagination of the full catalog (~20k servers, 204 pages of 100)
- List rows do not include `repositoryUrl`; we match GitHub only when `homepage` is a GitHub URL
- We do not fan out 20k per-server detail calls

## GitHub repo stats

- Docs: [GraphQL API](https://docs.github.com/en/graphql)
- Endpoint: `POST https://api.github.com/graphql`
- Auth: `GH_STATS_TOKEN` (optional PAT) falling back to Actions `GITHUB_TOKEN` / `GH_TOKEN`. Missing token → skip
- Batches of 50 aliased `repository(owner, name)` nodes plus `rateLimit { remaining resetAt cost }`
- Fields: `stargazerCount`, `forkCount`, `issues(states: OPEN) { totalCount }`, `pushedAt`, `updatedAt`
- Respect `X-RateLimit-Remaining` / `X-RateLimit-Reset`, secondary-limit `Retry-After`, and GraphQL remaining; wait through a reset when it is within ~70 minutes
- Checkpoint + resume under `data/state/github/`; `last_fetched` skips repos fresher than 7 days so every repo refreshes at least weekly
- Target: all discovered GitHub URLs in one 6h Actions run when budget allows; otherwise rolling coverage across days
- Repos are discovered from MCP `repository.url` / `io.github.*` names, Smithery GitHub homepages, and the Gemini gallery

## npm weekly downloads

- Docs: [npm download counts](https://github.com/npm/registry/blob/main/docs/download-counts.md)
- `GET https://api.npmjs.org/downloads/point/last-week/{package}`
- Bulk: comma-separated, max **128**, **unscoped only**. Scoped packages (`@scope/name`) are fetched one-by-one with `%2F`
- Throttle `api.npmjs.org`; back off on HTTP 429 and Cloudflare error 1015 (`Retry-After` + exponential)
- Checkpoint + weekly `last_fetched` under `data/state/npm/`

## PyPI / pypistats

- Docs: [PyPI Stats API](https://pypistats.org/api/)
- `GET https://pypistats.org/api/packages/{package}/recent`
- Returns `last_day`, `last_week`, `last_month`
- Do **not** use `pypi.org/pypi/{package}/json` `downloads` — it is always `-1`
- Throttle `pypistats.org`; back off on 429; rolling weekly coverage + checkpoint under `data/state/pypi/`

## Gemini CLI extensions gallery

- Public JSON exists: `https://geminicli.com/extensions.json`
- Referenced by the official CLI as `ExtensionRegistryClient.DEFAULT_REGISTRY_URL`
- Array of `{ id, url, fullName, stars, lastUpdated, extensionName, ... }`
- Included in M1 (not skipped)

## Out of scope (do not collect)

- ChatGPT GPT/app store pages
- claude.ai connectors / plugin store HTML
- Any authenticated scraping of those products
