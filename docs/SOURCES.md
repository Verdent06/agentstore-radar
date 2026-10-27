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
- HTTP 5xx (including 500 `Failed to get registry list`) is retried with exponential backoff **on the current cursor**. A persistent failure keeps earlier pages, marks the source truncated/`stoppedAt`, and still writes every other source. The snapshot is `partial: true` so movers skip that day.
- Packages (`registryType` `npm` / `pypi`) and `repository.url` drive later enrichment

## Smithery

- Docs: [List all servers](https://smithery.ai/docs/api-reference/servers/list-all-servers)
- List: `GET https://api.smithery.ai/servers?page=&pageSize=100`
- Public reads worked without a key on 2026-10-15. `SMITHERY_API_KEY` is optional (`Authorization: Bearer`); 401/403 without a key skips the source instead of failing the run
- `useCount` is documented as total connections. The per-server **detail** endpoint returns `useCount: null` — it is not a live counter.
- Search-index windows are capped at `topK` 500. **Pass a stable `seed`** (we use `1`) for deterministic deep pagination of the full catalog (~20k servers, ~208 pages of 100)
- **Upstream `useCount` is frozen.** As of 2026-10-25 every ~20.8k server has an identical value on 2026-10-21, 22, 24, and 25 (2026-10-23 is a missing snapshot, not a backfill). `pipeworx/gateway` stayed at **419019** on browse and on `GET /servers?q=pipeworx/gateway`. `?q=` search is the same frozen index as the seeded list, not a live overlay. There is no `updatedAt` for the counter.
- After listing the catalog we still request `GET /servers?q={qualifiedName}&pageSize=10` so a future thaw is recorded, but a search hit is **not** stamped fresh. Freeze is **source-level**: when **≥95%** of the catalog (`SOURCE_FREEZE_RATIO`) is unchanged across **N snapshot days** (default 3, `SMITHERY_FROZEN_DAYS`; missing days such as Oct 23 are skipped, never invented), those unchanged rows are flagged `frozen` and `carried_forward`. Otherwise N-day freeze is not applied per-row, so a later thaw does not leave genuinely flat/zero servers frozen forever. Search misses keep the last stored value from `data/state/smithery/` (also `carried_forward`). We never invent a count.
- Remaining false-positives: during a source freeze, idle/zero servers are marked frozen with the rest (we cannot tell a stuck index from a truly unused server). A catalog that is only ~94% stuck is **not** source-frozen, so those stuck rows still look fresh. New keys without N days of history count as "changed" and can keep a frozen catalog under 95%. `fetchedThisRunCount` counts only **non-frozen** search hits this run; `freshTodayCount` excludes frozen rows.
- List rows do not include `repositoryUrl`; we match GitHub only when `homepage` is a GitHub URL
- We do not fan out 20k per-server **detail** calls; detail has no `useCount` anyway. A 429 that cuts the search refresh short marks the source `truncated` / the snapshot `partial`.

## GitHub repo stats

- Docs: [GraphQL API](https://docs.github.com/en/graphql)
- Endpoint: `POST https://api.github.com/graphql`
- Auth: `GH_STATS_TOKEN` (optional PAT) falling back to Actions `GITHUB_TOKEN` / `GH_TOKEN`. Missing token → skip
- Batches of 50 aliased `repository(owner, name)` nodes plus `rateLimit { remaining resetAt cost }`
- Fields: `stargazerCount`, `forkCount`, `issues(states: OPEN) { totalCount }`, `pushedAt`, `updatedAt`
- Respect `X-RateLimit-Remaining` / `X-RateLimit-Reset`, secondary-limit `Retry-After`, and GraphQL remaining; wait through a reset when it is within ~70 minutes
- Checkpoint + resume under `data/state/github/`; `last_fetched` skips only keys already fetched on this UTC snapshot date so stars refresh daily. Due keys are ordered by cached `stargazerCount` so a truncated run still refreshes the most-starred repos first
- Cached rows are still written into that day's snapshot so rankings have last-known stars. `carried_forward` is true only when `fetched_at` is from a previous UTC day — a same-day re-run that reuses this morning's live fetch is **not** carried forward. Movers ignore carried-forward points so a late refresh is not mistaken for a one-day jump.
- GraphQL results are stored under the **requested** `owner/repo` key (not only `nameWithOwner`) so transfers/renames still attach to the discovered app.
- `Could not resolve to a Repository` / `NOT_FOUND` (deleted or renamed repos) is logged per-app and never fails the GitHub source or the workflow. Those aliases are skipped; cached rows from earlier fetches are still emitted when present.
- The 2026-10-15..22 freeze then 10-24 jump for many repos was the previous weekly refresh landing after several failed MCP runs, not a parser bug. `morluto/rea` is a real repository; its 268,700 → 375,620 jump was a **`stars_source` switch**, not carry-forward plus a parser freeze: through Oct 22 the merged app had ~268,700 stars and **no** `stars_source` (Gemini gallery / catalog value), then Oct 24 wrote 375,620 with `stars_source=github` once live GraphQL won. Movers ignore carried-forward GitHub points; a source switch still needs `stars_source` to be interpreted correctly.
- Target: all discovered GitHub URLs every day. 2026-10-25 fetched 4,655 due repos (7-day window) in ~21s; a full ~30k daily refresh is the same GraphQL path and fits the 6h job. Unresolved `NOT_FOUND` aliases are stamped `last_fetched` without a cache row so they do not look like missing coverage, and missing stars stay missing.
- Repos are discovered from MCP `repository.url` / `io.github.*` names, Smithery GitHub homepages, and the Gemini gallery

## npm weekly downloads

- Docs: [npm download counts](https://github.com/npm/registry/blob/main/docs/download-counts.md)
- `GET https://api.npmjs.org/downloads/point/last-week/{package}`
- Bulk: comma-separated, max **128**, **unscoped only**. Scoped packages (`@scope/name`) are fetched one-by-one with `%2F`
- Throttle `api.npmjs.org` (~500ms bulk, ~1.2s scoped). Back off on HTTP 429 and Cloudflare error 1015. `Retry-After: 0` is ignored (it caused an immediate retry storm on 2026-10-25); waits floor at 15s and **delay that package instead of stopping npm**. After the 70-minute wait budget a key is left for the next run, not used to mark the source truncated. Each run refreshes a stalest-first batch (`RADAR_NPM_BATCH`, default 1500) so the job finishes inside the Actions time limit.
- Checkpoint + **daily** `last_fetched` under `data/state/npm/`. Scoped packages (the 2026-10-25 429, `@abhishekjkrsna/swapi-mcp`) are the slow path; unscoped bulk of 128 still runs first. Due keys are ordered by last-known weekly downloads. Same `fetched_at` / `carried_forward` stamping as GitHub.

## PyPI / pypistats

- Docs: [PyPI Stats API](https://pypistats.org/api/)
- `GET https://pypistats.org/api/packages/{package}/recent`
- Returns `last_day`, `last_week`, `last_month`. We map **`data.last_month`** onto `pypi_last_month_downloads` (not a wrong key). The same JSON also has `last_week`; data is updated once daily.
- Do **not** use `pypi.org/pypi/{package}/json` `downloads` — it is always `-1`
- Throttle `pypistats.org`; back off on 429; **daily** coverage + checkpoint under `data/state/pypi/`. Due keys ordered by last-known weekly downloads.
- Cached **weekly** counts are stamped `carried_forward` like GitHub/npm when the row was not fetched this UTC day.
- **`last_month` can stay identical while `last_week` moves.** Observed `zotero-mcp` monthly **20314** on 2026-10-18 and 2026-10-25 (Oct 23 stays a gap) even though weekly changed. A live `/recent` fetch is not evidence that monthly is fresh. Monthly is flagged `frozen` (and `pypi_last_month_downloads_carried_forward` on the merged app) when it is unchanged for N snapshot days **and** weekly moved, or when ≥95% of monthly values are stuck (`isUnchangedForDays` / source freeze). Weekly can still be fresh on the same row.
- **Consistency:** `last_month < last_week` is invalid (e.g. monthly **0** with weekly ~100). That row is `carried_forward`, not fresh. We keep the numbers; we do not invent a monthly total.

## Gemini CLI extensions gallery

- Public JSON exists: `https://geminicli.com/extensions.json`
- Referenced by the official CLI as `ExtensionRegistryClient.DEFAULT_REGISTRY_URL`
- Array of `{ id, url, fullName, stars, lastUpdated, extensionName, ... }`
- This **is** the live source. A fetch on 2026-10-24 returned exactly **2198** extensions — the same count as every snapshot that week. The gallery is a slowly changing curated catalog, not a collector cache. There is no richer official feed. Per-extension `lastUpdated` is stored as `pushed_at`.
- Gallery `stars` (e.g. `obra/superpowers` 299,294) are static catalog values. The same source-level freeze as Smithery applies: if ≥95% of gallery stars are unchanged for N snapshot days, those rows are `frozen`/`carried_forward`, not stamped fresh. Merged app `stars` prefer the live GitHub GraphQL count and set `stars_source` accordingly; `geminiStars` keeps the gallery number for the Gemini chart.
- Included in M1 (not skipped)

## Answer-share probe (weekly)

Not a catalog scrape. Official chat APIs only, with each vendor's web-search tool enabled:

| Provider | Endpoint | Web search | Default model |
| --- | --- | --- | --- |
| OpenAI | `POST https://api.openai.com/v1/responses` | `tools: [{ type: "web_search" }]` | `gpt-4.1-mini` |
| Anthropic | `POST https://api.anthropic.com/v1/messages` | `web_search_20250305` | `claude-haiku-4-5` |
| Google Gemini | `POST .../v1beta/models/{model}:generateContent` | `tools: [{ google_search: {} }]` | `gemini-2.5-flash` |
| xAI Grok | `POST https://api.x.ai/v1/responses` | `tools: [{ type: "web_search" }]` | `grok-4-fast-non-reasoning` |

Each key is optional. History lands in the private data repo under `data/raw/answer-share/` and `data/normalized/answer-share/`. CI never calls these APIs (fixture tests only). `MAX_CALLS` is the hard spend cap.

## Out of scope (do not collect)

- ChatGPT GPT/app store pages
- claude.ai connectors / plugin store HTML
- Any authenticated scraping of those products
