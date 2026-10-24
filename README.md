# AgentStore Radar

Free, open-source collector for cross-store analytics of AI app / agent stores — App Annie / Sensor Tower, but for MCP servers, ChatGPT apps, Claude connectors, and CLI extension galleries.

**Code:** MIT (this repository)  
**Data:** private (`Verdent06/agentstore-radar-data`). The public site and MCP connector expose **chosen aggregates only** — never bulk `apps.ndjson` / `source_rows.ndjson` history.

Snapshot history does **not** live in this repo. The daily collect job writes into the private data repo via a deploy key (`DATA_REPO_DEPLOY_KEY`). `data/` is gitignored here.

## What we collect (and what we refuse)

v1 uses **only sanctioned public APIs**. We do **not** scrape ChatGPT or claude.ai (ToS / robots). Those stores land later only if they publish a public feed.

| Source | Endpoint | Metric |
| --- | --- | --- |
| Official MCP Registry | `GET /v0.1/servers` (cursor + `version=latest`) | catalog, packages, repo |
| Smithery | `GET /servers` (`useCount`, stable `seed` pagination) | connections |
| Gemini CLI gallery | `https://geminicli.com/extensions.json` | stars, lastUpdated |
| GitHub GraphQL | batches of 50 `repository` nodes via `GH_STATS_TOKEN` or Actions `GITHUB_TOKEN` | stars, forks, open issues, `pushed_at` |
| npm | bulk `downloads/point/last-week` (128 unscoped; scoped one-by-one) | weekly downloads |
| PyPI | `pypistats.org/api/packages/{pkg}/recent` (throttled, rolling) | weekly / monthly downloads |

Research notes, rate-limit behavior, and skipped ideas: [docs/SOURCES.md](docs/SOURCES.md).

Every request sends:

```
User-Agent: agentstore-radar/0.1 (+https://github.com/Verdent06/agentstore-radar)
```

`SMITHERY_API_KEY` is optional. If the public list starts requiring a key and the secret is missing, that source is skipped instead of failing the run.

## Data layout (private repo)

Never overwrite a past day's snapshot. Same-day re-runs may refresh today's files.

```
data/raw/<source>/<YYYY-MM-DD>.json      # or .json.gz when payload ≥ 256 KiB
data/normalized/<YYYY-MM-DD>/source_rows.ndjson(.gz)
data/normalized/<YYYY-MM-DD>/apps.ndjson(.gz)
data/normalized/<YYYY-MM-DD>/manifest.json
data/state/<source>/last_fetched.json    # rolling weekly refresh
data/state/<source>/cache.json           # last-known enrichment payload
data/state/<source>/checkpoint.json      # resume mid-run after rate limits
```

Point `report`, `health`, and the public aggregate builder at that tree with `DATA_DIR` or `--data`:

```bash
export DATA_DIR=/path/to/agentstore-radar-data/data
npm run report
```

`--data` wins over `DATA_DIR`, which wins over `./data`.

### Entity matching

`app_id` is assigned in this order:

1. `github:{owner}/{repo}` when a GitHub URL (or `io.github.owner/repo` MCP name) is present
2. `npm:{package}`
3. `pypi:{package}`
4. `{source}:{source_id}`

The same GitHub repo listed on the MCP registry, Smithery, and the Gemini gallery collapses to one app.

## Collect locally

Requires Node 22+. History is written to `./data` by default (gitignored). To use the private clone:

```bash
git clone git@github.com:Verdent06/agentstore-radar-data.git
export DATA_DIR="$PWD/agentstore-radar-data/data"
npm install
npm run collect
npm run report
npm run health
```

Useful flags:

```bash
npx tsx src/cli.ts collect --data "$DATA_DIR" --sources mcp-registry,gemini-cli
npx tsx src/cli.ts report --data "$DATA_DIR" --limit 15
```

Optional env:

- `DATA_DIR` — snapshot root (see above)
- `DATA_GITHUB_TOKEN` — PAT used by the public aggregate builder to read the private data repo (the only data-token env var to set on Vercel)
- `GH_STATS_TOKEN` — optional PAT used first for GraphQL repo stats (higher budget than the default Actions token)
- `GITHUB_TOKEN` / `GH_TOKEN` — GitHub GraphQL fallback (Actions provides `GITHUB_TOKEN` automatically); also accepted as a local fallback when cloning private snapshots if `DATA_GITHUB_TOKEN` is unset
- `SMITHERY_API_KEY` — only if Smithery starts requiring auth for public list
- `HEALTH_ISSUE_REPO` — `owner/name` for health issues (defaults to unset; we do not open issues on the public repo)
- `HEALTH_ISSUE_TOKEN` — optional token that can write issues on the data repo
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `XAI_API_KEY` — optional; each missing key skips that answer-share provider
- `MAX_CALLS` — hard cap on answer-share API calls (unset = uncapped)
- `ANSWER_SHARE_N` — repeats per prompt per provider (default `3`)
- `OPENAI_MODEL` / `ANTHROPIC_MODEL` / `GEMINI_MODEL` / `XAI_MODEL` — optional model overrides

## Automation

- [`.github/workflows/collect.yml`](.github/workflows/collect.yml) — daily cron (`17 6 * * *`) plus `workflow_dispatch`. `timeout-minutes: 360` so GitHub/npm/PyPI can wait through rate-limit resets. Checks out the private data repo over SSH (`DATA_REPO_DEPLOY_KEY`), **once** copies `data/` from this repo’s git history if the data repo has no snapshots yet (writes `data/.migrated-from-public`), then collects into `DATA_DIR` and pushes **only** to the data repo. After that first success it never reads public history again. `seed_only` skips collect and just does that one-time copy.
- [`.github/workflows/answer-share.yml`](.github/workflows/answer-share.yml) — weekly cron (Mondays `17 7 * * 1`) plus `workflow_dispatch`. Same private-repo deploy key. Asks each configured assistant which apps/tools/MCP servers it would recommend (`N=3` for variance). Missing provider keys are skipped. `MAX_CALLS` is a hard cost cap (workflow default `1200`).
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — lint, typecheck, collector tests, aggregate build (explicit `--allow-fixture` unless a data token/`DATA_DIR` is set), Next.js build, MCP tests.

### Answer share

Weekly probe of which apps / tools / connectors / MCP servers frontier assistants recommend. Official APIs only, with web-search tools enabled: OpenAI Responses `web_search`, Anthropic Messages `web_search_20250305`, Gemini `google_search` grounding, xAI Responses `web_search`.

```bash
npm run answer-share -- --data "$DATA_DIR"
npm run answer-share:report -- --data "$DATA_DIR"
```

Writes into the private data repo:

```
data/raw/answer-share/<YYYY-MM-DD>/responses.ndjson
data/raw/answer-share/<YYYY-MM-DD>/extracted.ndjson
data/raw/answer-share/<YYYY-MM-DD>/manifest.json
data/normalized/answer-share/<YYYY-MM-DD>/mentions.ndjson
data/normalized/answer-share/<YYYY-MM-DD>/shares.json
```

Mentions are matched to the latest `apps.ndjson` via aliases and fuzzy names. Answer share is that app's fraction of mentions, per provider and per category.

Rough full-run cost (100 prompts × 3 repeats = 300 calls / provider, web search on): OpenAI `gpt-4.1-mini` ~$4.20; Anthropic `claude-haiku-4-5` ~$4.40; Gemini `gemini-2.5-flash` ~$0.35 inside the 1,500 free grounded prompts/day else ~$10.85; xAI `grok-4-fast-non-reasoning` ~$1.60. The job prints the estimate before calling and actuals after. Lower `MAX_CALLS` to cap spend.

### Health check

`npm run health` exits non-zero when:

- a source's row count drops **more than 30%** versus the previous snapshot, or
- a non-skipped source's **coverage** is below **70%** (`fetched / eligible`, where fetched means refreshed within 7 days)

Each source's `eligibleCount`, `fetchedCount`, and `coverage` are stored on that day's `manifest.json`. Catalog sources are typically 100%. GitHub / npm / PyPI use rolling weekly refresh: yesterday's last-known stats are carried forward, and only stale or new keys are fetched. Issues are opened on `HEALTH_ISSUE_REPO` (the private data repo) when a token can write there. The public repo is never used as a fallback, and alerts do not attach snapshot files.

**Coverage expectations**

| Source | Eligible set | One-run target | Fallback |
| --- | --- | --- | --- |
| GitHub | every discovered repo with a GitHub URL | all due repos via 50-wide GraphQL (Actions token ~5k points/hour; a 6h run can cover tens of thousands if it waits for resets) | rolling: skip keys fresher than 7 days so every repo refreshes at least weekly |
| npm | every discovered npm package | unscoped in batches of 128; scoped one-by-one | same weekly rolling + resume after Cloudflare 1015 / 429 |
| PyPI | every discovered PyPI package | throttled `pypistats` recent | weekly rolling + resume after 429 |
| MCP / Smithery / Gemini | catalog page rows | full catalog in the run | n/a (no rolling) |

## Development

```bash
npm test
npm run lint
npm run typecheck
```

Adapters live under `src/adapters/` and share a `SourceAdapter` interface (`catalog` then `enrichment`). Zod validates wire payloads; a bad row is dropped, a >50% invalid page fails the source.

## Public site (`/web`)

Next.js App Router + Tailwind. Pages: home (headline stats + movers once two snapshot days exist, otherwise top by Smithery use count), per-source charts (Smithery / npm / GitHub / Gemini CLI), multi-store, new arrivals, keyword categories, per-app history, search, answer share (weekly assistant recommendations when `normalized/answer-share/<date>/shares.json` exists; empty state otherwise), and a screenshot-oriented [`/movers?shot=1`](web/app/movers/page.tsx) weekly card. Each leaderboard has an OG image for sharing.

```bash
npm run aggregate                 # requires DATA_DIR or DATA_GITHUB_TOKEN (fails in CI/Vercel without them)
npm run aggregate:fixture         # explicit opt-in to bundled demo snapshots (local + CI)
npm run site:build                # production path: --require-private then Next.js build
npm run site:build:fixture        # local/CI site build from fixtures
npm run dev --workspace=web
```

The builder writes compact `web/data/radar.json` (and `radar.sqlite` when `node:sqlite` is available). That file is a summary: latest app cards, short metric series, coverage. It is **not** a dump of private NDJSON. `meta.source` is `"private"` or `"fixture"` so a production bundle cannot silently look like live data.

Locally, with neither `CI` nor `VERCEL` set, `npm run aggregate` may still use fixtures if no token/`DATA_DIR` is present. **Vercel and CI never do that** unless you pass `--allow-fixture` or set `ALLOW_FIXTURE=1`. `npm run site:build` always passes `--require-private`.

### Vercel

Create a **new** project from this repo. Set **Root Directory** to `web` so Next.js detection, `.next` output, and `next.config.ts` all live in the project root Vercel sees. Keep [web/vercel.json](web/vercel.json); there is no repo-root `vercel.json`.

Leave the dashboard Install / Build overrides empty — the config supplies them. Turn on **Include files outside the root directory** (the Vercel default) so the parent workspace install can reach `scripts/` and `src/`.

| Setting | Value |
| --- | --- |
| Root Directory | `web` |
| Framework | Next.js |
| Install | `cd .. && npm ci` |
| Build | `npx tsx ../scripts/build-aggregate.ts --out data --require-private && next build` |

Refresh live charts by redeploying (a Deploy Hook from the data repo, or a manual redeploy). The Hobby build is static: no ISR revalidation against GitHub.

**Required / recommended env vars** (Production + Preview)

| Name | Required | Purpose |
| --- | --- | --- |
| `DATA_GITHUB_TOKEN` | **yes on Vercel** | Fine-grained PAT, **Contents: Read-only** on `Verdent06/agentstore-radar-data` only. Used at **build time** to sparse-clone `data/normalized`. Mark it Sensitive. Do not set `GITHUB_TOKEN` or `GH_TOKEN` on Vercel — the data-token source should stay unambiguous. |
| `DATA_DIR` | local/CI alternative | Absolute path to the private `data/` tree. |
| `DATA_REPO` | no | Defaults to `Verdent06/agentstore-radar-data`. |
| `NEXT_PUBLIC_SITE_URL` | recommended | Canonical site URL for Open Graph (`https://your-project.vercel.app`). |
| `AGGREGATE_PATH` | no | Override path to `radar.json` (site + MCP). |
| `ALLOW_FIXTURE` | no | Explicit fixture opt-in for local/CI. Ignored when `--require-private` is set (Vercel always sets that). |

A Vercel build **fails** if it cannot load the private data repo. It will not ship demo fixtures. The build log should show `token from DATA_GITHUB_TOKEN` and `source=private`.

The Vercel build never downloads raw history to the public internet. Only the compact aggregate is bundled with the serverless/node build.

## MCP connector (`/mcp`)

Read-only official MCP TypeScript SDK v2 server (`@modelcontextprotocol/server`) with **Streamable HTTP** and **stdio**.

```bash
npm run aggregate                 # or npm run aggregate:fixture for demo data
npx tsx mcp/src/stdio.ts          # stdio
npx tsx mcp/src/http.ts           # http://0.0.0.0:8787/mcp  (PORT / HOST)
```

Tools: `search_apps`, `app_details`, `rank_history`, `top_charts`, `movers`, `competitors`, `category_trends`, `multi_store`, `answer_share`. All read the same aggregate; payloads are capped and never include snapshot files. `answer_share` returns `{ available: false }` when no probe is present.

Listing files:

- [`server.json`](server.json) — official MCP Registry (`io.github.verdent06/agentstore-radar`)
- [`smithery.yaml`](smithery.yaml) — Smithery stdio start command

Publish to the official registry after namespace verification; publish the HTTP URL or stdio command on Smithery once a host is live.

## Roadmap

- **M2:** Glama / PulseMCP / other public MCP catalogs if they offer APIs
- **M3:** ChatGPT apps / Claude connectors *only* via official public data
- **M4:** public charts / leaderboards on top of the private history — **this repo now ships `/web` + `/mcp`**
