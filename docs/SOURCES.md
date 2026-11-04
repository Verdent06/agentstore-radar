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
- Wall-clock budget `MCP_COLLECT_BUDGET_MS` (default 15 minutes, `RADAR_MCP_BUDGET_MS`). Past that, collected pages are kept, the source is `truncated`, and the day is `partial`.

## Smithery

- Docs: [List all servers](https://smithery.ai/docs/api-reference/servers/list-all-servers)
- List: `GET https://api.smithery.ai/servers?page=&pageSize=100`
- Public reads worked without a key on 2026-10-15. `SMITHERY_API_KEY` is optional (`Authorization: Bearer`); 401/403 without a key skips the source instead of failing the run
- `useCount` is documented as total connections. The per-server **detail** endpoint returns `useCount: null` — it is not a live counter.
- Search-index windows are capped at `topK` 500. **Pass a stable `seed`** (we use `1`) for deterministic deep pagination of the full catalog (~20k servers, ~208 pages of 100)
- **Upstream `useCount` is frozen.** As of 2026-10-25 every ~20.8k server has an identical value on 2026-10-21, 22, 24, and 25 (2026-10-23 is a missing snapshot, not a backfill). `pipeworx/gateway` stayed at **419019** on browse and on `GET /servers?q=pipeworx/gateway`. `?q=` search is the same frozen index as the seeded list, not a live overlay. There is no `updatedAt` for the counter.
- After listing the catalog we still request `GET /servers?q={qualifiedName}&pageSize=10` so a future thaw is recorded, but a search hit is **not** stamped fresh. Freeze is **source-level**: when **≥95%** of the catalog (`SOURCE_FREEZE_RATIO`) is unchanged across **N snapshot days** (default 3, `SMITHERY_FROZEN_DAYS`; missing days such as Oct 23 are skipped, never invented), those unchanged rows are flagged `frozen` and `carried_forward`. Otherwise N-day freeze is not applied per-row, so a later thaw does not leave genuinely flat/zero servers frozen forever. Search misses keep the last stored value from `data/state/smithery/` (also `carried_forward`). We never invent a count.
- Remaining false-positives: during a source freeze, idle/zero servers are marked frozen with the rest (we cannot tell a stuck index from a truly unused server). A catalog that is only ~94% stuck is **not** source-frozen, so those stuck rows still look fresh. New keys without N days of history count as "changed" and can keep a frozen catalog under 95%. `fetchedShare` counts **only fresh rows** (`carried_forward` false and `frozen` not true). A source-frozen catalog, or a run with 0 useCount updates, scores ~0. `fetchedThisRunCount` counts only those fresh rows, and is **0** when the useCount circuit breaker trips, even if a few searches succeeded first. `freshTodayCount` is the same fresh set when the breaker is closed. Overlay `?q=` stays a thaw probe (default 400).
- List rows do not include `repositoryUrl`; we match GitHub only when `homepage` is a GitHub URL
- We do not fan out 20k per-server **detail** calls; detail has no `useCount` anyway. A 429 that cuts the search refresh short marks the source `truncated` / the snapshot `partial`. Completing the seeded list does not keep `fetchedShare` high when those rows are frozen or carried forward.
- Wall-clock budget `SMITHERY_COLLECT_BUDGET_MS` (default 20 minutes, `RADAR_SMITHERY_BUDGET_MS`). When it trips, the useCount walk stops, a same-day checkpoint is kept, due rows that were not refreshed stay `carried_forward` and `frozen`, and the snapshot is `partial`.
- Ten consecutive useCount 5xx or network errors (`SMITHERY_USECOUNT_CIRCUIT_BREAKER_THRESHOLD`, default 10; `RADAR_SMITHERY_CIRCUIT_BREAKER` overrides it) stop further `?q=` calls for the rest of the run. The source is `failed` with reason `circuit_breaker_5xx`, the snapshot is `partial`, and every due row that was not refreshed keeps its last known `useCount` with `carried_forward` and `frozen` set. Those rows are excluded from `fetchedShare`. A successful response resets the streak. Other sources are unchanged.

## GitHub repo stats

- Docs: [GraphQL API](https://docs.github.com/en/graphql)
- Endpoint: `POST https://api.github.com/graphql`
- Auth: `GH_STATS_TOKEN` (optional PAT) falling back to Actions `GITHUB_TOKEN` / `GH_TOKEN`. Missing token → skip
- Batches of 100 aliased `repository(owner, name)` nodes plus `rateLimit { remaining resetAt cost }` (~320 queries for the current catalog)
- Fields: `stargazerCount`, `forkCount`, `issues(states: OPEN) { totalCount }`, `pushedAt`, `updatedAt`
- Respect `X-RateLimit-Remaining` / `X-RateLimit-Reset`, secondary-limit `Retry-After`, and GraphQL remaining; wait through a reset when it is within ~70 minutes
- Checkpoint + resume under `data/state/github/`; `last_fetched` skips only keys already fetched on this UTC snapshot date so stars refresh daily. Due keys are ordered by cached `stargazerCount` so a truncated run still refreshes the most-starred repos first
- Cached rows are still written into that day's snapshot so rankings have last-known stars. `carried_forward` is true only when `fetched_at` is from a previous UTC day — a same-day re-run that reuses this morning's live fetch is **not** carried forward. Movers ignore carried-forward points so a late refresh is not mistaken for a one-day jump.
- GraphQL results are stored under the **requested** `owner/repo` key (not only `nameWithOwner`) so transfers/renames still attach to the discovered app.
- `Could not resolve to a Repository` / `NOT_FOUND` (deleted or renamed repos) is logged per-app and never fails the GitHub source or the workflow. Unresolved aliases are **not** stamped `last_fetched` and are **not** counted in `fetchedThisRunCount` / `freshTodayCount`. They are persisted under `data/state/github/unresolved.json`, excluded from the next day's due set (retried after 7 days), recorded as `unresolvedCount` / `unresolvedRepos` on the source manifest, and **excluded from the `fetchedShare` denominator**. If a cached row exists it is emitted with `carried_forward: true` and the original `fetched_at`; it is never labeled fresh.
- The 2026-10-15..22 freeze then 10-24 jump for many repos was the previous weekly refresh landing after several failed MCP runs, not a parser bug. `morluto/rea` is a real repository; its 268,700 → 375,620 jump was a **`stars_source` switch**, not carry-forward plus a parser freeze: through Oct 22 the merged app had ~268,700 stars and **no** `stars_source` (Gemini gallery / catalog value), then Oct 24 wrote 375,620 with `stars_source=github` once live GraphQL won. Movers ignore carried-forward GitHub points; a source switch still needs `stars_source` to be interpreted correctly.
- Target: fresh `fetchedShare` ≥0.80 of resolvable GitHub URLs every day (100-wide GraphQL, default `RADAR_GITHUB_BATCH` 50k). Unresolved `NOT_FOUND` aliases are persisted so they cannot consume the daily batch. Missing stars stay missing. Wall-clock budget `GITHUB_COLLECT_BUDGET_MS` (default 50 minutes, `RADAR_GITHUB_BUDGET_MS`); a rate-limit wait longer than the time left stops the source, checkpoints, and marks the day partial instead of waiting out a reset that would blow the job.
- Repos are discovered from MCP `repository.url` / `io.github.*` names, Smithery GitHub homepages, and the Gemini gallery

## npm weekly downloads

- Docs: [npm download counts](https://github.com/npm/registry/blob/main/docs/download-counts.md)
- `GET https://api.npmjs.org/downloads/point/last-week/{package}`
- Bulk: comma-separated, max **128**, **unscoped only**. Scoped packages (`@scope/name`) are fetched one-by-one with `%2F`
- Throttle `api.npmjs.org` (~200ms bulk, ~250ms scoped). Unscoped names go out on the bulk point endpoint, up to **128** per request (`last-week/a,b,c`). Scoped names (`@scope/name`) are not supported in bulk; they stay one URL each, **8 in flight** (`NPM_SCOPED_CONCURRENCY`, `RADAR_NPM_SCOPED_CONCURRENCY`). Bulk and scoped run **at the same time**, so a slow scoped lane cannot consume the budget before the first scoped call. Each download sets `maxRetries: 0` so the first 429 reaches the shared pool instead of sleeping inside the HTTP client. A positive `Retry-After` is the wait. `Retry-After: 0` (and a missing header) still floors at 15s — that zero header caused an immediate retry storm on 2026-10-25. A wait that would run past the source budget defers that package instead of stopping the whole process. On 2026-11-04 the bulk lane finished 6,495 unscoped names in about two minutes (51 requests); the following ~98 minutes were scoped calls whose 429s never left the HTTP client, so the run log showed no "npm waiting" lines and the budget died with `exhausted (before scoped package)` from workers that started after the clock was already spent (9,855 of 14,584 fresh). Default `RADAR_NPM_BATCH` 20k covers the current catalog. Wall-clock budget `NPM_COLLECT_BUDGET_MS` (default **100 minutes**, `RADAR_NPM_BUDGET_MS`), opened once per collect so a retry shares the time left. When the budget trips, npm persists `data/state/npm/checkpoint.json` keyed by `snapshotDate`, marks the source `truncated`, and stamps rows that were not refreshed `carried_forward=true` and `frozen=true`. The day is `partial`. The 08:47 and 19:23 UTC backstops resume that same-day checkpoint.
- The source manifest `lanes` array and the run log (`npm lane`) record, per lane, `path` (`bulk` or `single`), `requests` (HTTP calls), `fetched`, `notFound`, `rateLimits` (429 waits), and `durationMs`. Both lanes are present even when one made zero calls.
- Checkpoint + **daily** `last_fetched` under `data/state/npm/`. Scoped packages (the 2026-10-25 429, `@abhishekjkrsna/swapi-mcp`) are the slow path; they run alongside unscoped bulk. Due keys are ordered by last-known weekly downloads. Same `fetched_at` / `carried_forward` stamping as GitHub.

## PyPI / pypistats

- Docs: [PyPI Stats API](https://pypistats.org/api/)
- `GET https://pypistats.org/api/packages/{package}/recent`
- Returns `last_day`, `last_week`, `last_month`. We map **`data.last_month`** onto `pypi_last_month_downloads` (not a wrong key). The same JSON also has `last_week`; data is updated once daily.
- **`pypi_last_month_downloads` is not a growth signal.** pypistats can return `last_week` greater than `last_month` (weekly > monthly). Movers and public growth use **`pypi_last_week_downloads`**. Monthly is kept so a stuck month can be flagged frozen; it is not a week-over-week delta.
- Do **not** use `pypi.org/pypi/{package}/json` `downloads` — it is always `-1`
- Throttle `pypistats.org` (~400ms between starts) with **4 requests in flight** (`PYPI_CONCURRENCY`, `RADAR_PYPI_CONCURRENCY`). A 429 pauses every worker that has not started (shared Retry-After, 15s floor). Data updates once daily. Default `RADAR_PYPI_BATCH` 10k covers the current catalog. **daily** coverage + checkpoint under `data/state/pypi/`. Due keys ordered by last-known weekly downloads. Wall-clock budget `PYPI_COLLECT_BUDGET_MS` (default **55 minutes**, `RADAR_PYPI_BUDGET_MS`), one clock per collect including retries. When the budget trips, the checkpoint is keyed by `snapshotDate`, the source is `truncated`, rows not refreshed stay `carried_forward=true` and `frozen=true`, and the same day's manifest is overwritten with `partial: true`. The 19:23 UTC backstop resumes that checkpoint.
- **`weekly > monthly`:** a row with `last_week > last_month` is `pypi_weekly_gt_monthly: true` and `pypi_monthly_frozen: true`. The row stays fresh when weekly was fetched today (`carried_forward` false, `frozen` false), so it counts in both `fetchedShare` and `freshToday`. The merged app carries only `pypi_last_month_downloads`. The source manifest records `weeklyGtMonthlyCount`. Monthly is still not a growth signal.
- Cached **weekly** counts are stamped `carried_forward` like GitHub/npm when the row was not fetched this UTC day.
- **`last_month` can stay identical while `last_week` moves.** Observed `zotero-mcp` monthly **20314** on 2026-10-18 and 2026-10-25 (Oct 23 stays a gap) even though weekly changed. A live `/recent` fetch is not evidence that monthly is fresh. Monthly is flagged `pypi_monthly_frozen` (and `pypi_last_month_downloads_carried_forward` on the merged app) when it is unchanged for N snapshot days **and** weekly moved, or when ≥95% of **live-fetched** monthly values are stuck (`isUnchangedForDays` / source freeze). Carried-forward cache rows are excluded from that 95% ratio so a small daily batch cannot freeze packages that were actually fetched today. Weekly fetched today keeps the **row** fresh: `fetchedShare` and `freshToday` both count it. The row is `frozen` / `carried_forward` only when that package was not fetched today.
- Target: fresh `fetchedShare` ≥0.80 of discovered PyPI packages across the primary run plus the same-day backstop (default `RADAR_PYPI_BATCH` 10k, ~400ms). One run may stop at the 65-minute budget and leave a partial day.
- **Consistency:** `last_month < last_week` is invalid (e.g. monthly **0** with weekly ~100). The monthly field is `pypi_monthly_frozen` and is not a growth signal. The row stays fresh when weekly was fetched today. We keep the numbers; we do not invent a monthly total.

## Gemini CLI extensions gallery

- Public JSON exists: `https://geminicli.com/extensions.json`
- Referenced by the official CLI as `ExtensionRegistryClient.DEFAULT_REGISTRY_URL`
- Array of `{ id, url, fullName, stars, lastUpdated, extensionName, ... }`
- This **is** the live source. A fetch on 2026-10-24 returned exactly **2198** extensions — the same count as every snapshot that week. The gallery is a slowly changing curated catalog, not a collector cache. There is no richer official feed. Per-extension `lastUpdated` is stored as `pushed_at`.
- Gallery `stars` (e.g. `obra/superpowers` 299,294) are static catalog values. The same source-level freeze as Smithery applies: if ≥95% of gallery stars are unchanged for N snapshot days, those rows are `frozen`/`carried_forward`, not stamped fresh. Merged app `stars` prefer the live GitHub GraphQL count and set `stars_source` accordingly; `geminiStars` keeps the gallery number for the Gemini chart.
- The gallery JSON is fetched in full every run (~2.2k rows, one GET). `fetchedShare` counts only fresh rows, so an all-frozen gallery (`sourceFrozen`) scores ~0. `fresh` stays `carried_forward` false and not frozen. Wall-clock budget `GEMINI_COLLECT_BUDGET_MS` (default 5 minutes, `RADAR_GEMINI_BUDGET_MS`).
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

## Collect time budgets

The collect step is killed at 330 minutes. Each source stops at its own wall-clock budget, writes a same-day checkpoint (`snapshotDate`, same contract as `resumeFromCheckpoint`), and the run still writes **one** `manifest.json` for that date (`partial: true` when a source did not finish). A later run for the same `snapshotDate` overwrites that manifest. It does not create a second one. npm and PyPI rows that were not refreshed stay `carried_forward=true` and `frozen=true`.

A day is **clean** only when that single manifest is not partial: no source is `failed` or `truncated`, and fresh coverage is complete. `fetchedShare` counts only rows with `carried_forward` not true and `frozen` not true. The 19:23 UTC backstop (`--if-incomplete`) resumes an npm or PyPI checkpoint whose `snapshotDate` is still today instead of starting those keys over. Each source records `fetch_started_at`, `fetch_ended_at`, and `fetchRunIds`. A resumed source keeps the first start, the latest end, and every run id.

A checkpoint-only push (no manifest) is labeled `data: checkpoint <snapshotDate>`. A commit that includes `manifest.json` is `data: snapshot <date>`.

| Source | Budget | Override |
| --- | --- | --- |
| MCP registry | 15 min | `RADAR_MCP_BUDGET_MS` |
| Smithery | 20 min | `RADAR_SMITHERY_BUDGET_MS` |
| Gemini CLI | 5 min | `RADAR_GEMINI_BUDGET_MS` |
| GitHub | 50 min | `RADAR_GITHUB_BUDGET_MS` |
| npm | 100 min | `RADAR_NPM_BUDGET_MS` |
| PyPI | 55 min | `RADAR_PYPI_BUDGET_MS` |

Sum **245 minutes** (worst case **248 minutes** with one 30s HTTP timeout per source). Under 300 minutes and inside the 330-minute step. The budget is opened once per source per collect, including retries.

Live sample from this VM on 2026-11-03, extrapolated to the Nov 3 catalog (6,480 unscoped npm, 8,054 scoped npm, 4,892 PyPI):

- npm bulk: 140 unscoped names, 2 requests of up to 128, sequential, 200ms gap, 751ms, 0 rate limits. Full unscoped pass ≈ 0.3 min.
- npm scoped: 80 names, 4 in flight, 250ms between starts, `@scope%2Fname` URLs, 19.8s (~4 req/s; 55×200, 25×429). Full scoped pass ≈ 33 min. Concurrency 2 at a 400ms gap was ~2.3 req/s ≈ 59 min, still inside the 100-minute budget.
- PyPI: 300 top packages, 4 in flight, 400ms between starts, `GET /api/packages/{name}/recent`, 121.1s, 2×429. Full pass ≈ 33 min.

Unscoped npm uses `GET https://api.npmjs.org/downloads/point/last-week/a,b,c` (max 128). Scoped packages stay individual. Scoped npm and PyPI share one backoff: a 429 pauses every worker that has not started.

## Out of scope (do not collect)

- ChatGPT GPT/app store pages
- claude.ai connectors / plugin store HTML
- Any authenticated scraping of those products
