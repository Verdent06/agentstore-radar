# AgentStore Radar

Free, open-source, cross-store analytics and **permanent history** for AI app / agent stores — App Annie / Sensor Tower, but for MCP servers, ChatGPT apps, Claude connectors, and CLI extension galleries.

M0+M1 is the collector. Priority one is **start snapshotting today** so history accumulates. This repo uses the [git-scraping](https://simonwillison.net/2020/Oct/9/git-scraping/) pattern: a daily GitHub Action writes dated files and commits them. No warehouse, no scraper fleet.

**Code:** MIT  
**Data:** [CC BY 4.0](data/LICENSE)

## What we collect (and what we refuse)

v1 uses **only sanctioned public APIs**. We do **not** scrape ChatGPT or claude.ai (ToS / robots). Those stores land later only if they publish a public feed.

| Source | Endpoint | Metric |
| --- | --- | --- |
| Official MCP Registry | `GET /v0.1/servers` (cursor + `version=latest`) | catalog, packages, repo |
| Smithery | `GET /servers` (`useCount`, stable `seed` pagination) | connections |
| Gemini CLI gallery | `https://geminicli.com/extensions.json` | stars, lastUpdated |
| GitHub GraphQL | batched `repository` nodes via `GITHUB_TOKEN` | stars, forks, open issues, `pushed_at` |
| npm | `api.npmjs.org/downloads/point/last-week` | weekly downloads |
| PyPI | `pypistats.org/api/packages/{pkg}/recent` | weekly / monthly downloads |

Research notes, rate-limit behavior, and skipped ideas: [docs/SOURCES.md](docs/SOURCES.md).

Every request sends:

```
User-Agent: agentstore-radar/0.1 (+https://github.com/Verdent06/agentstore-radar)
```

`SMITHERY_API_KEY` is optional. If the public list starts requiring a key and the secret is missing, that source is skipped instead of failing the run.

## Data layout

Never overwrite a past day's snapshot. Same-day re-runs may refresh today's files.

```
data/raw/<source>/<YYYY-MM-DD>.json      # or .json.gz when payload ≥ 256 KiB
data/normalized/<YYYY-MM-DD>/source_rows.ndjson(.gz)
data/normalized/<YYYY-MM-DD>/apps.ndjson(.gz)
data/normalized/<YYYY-MM-DD>/manifest.json
```

- `source_rows.ndjson` — one row per listing / enrichment record (Parquet-friendly, flat columns)
- `apps.ndjson` — listings matched onto a stable `app_id`
- Raw JSON is the unmodified API payload (plus a small fetch envelope)

### Entity matching

`app_id` is assigned in this order:

1. `github:{owner}/{repo}` when a GitHub URL (or `io.github.owner/repo` MCP name) is present
2. `npm:{package}`
3. `pypi:{package}`
4. `{source}:{source_id}`

The same GitHub repo listed on the MCP registry, Smithery, and the Gemini gallery collapses to one app.

## Collect locally

Requires Node 22+.

```bash
npm install
npm run collect
npm run report
npm run health
```

Useful flags:

```bash
npx tsx src/cli.ts collect --date 2026-10-15 --sources mcp-registry,gemini-cli
npx tsx src/cli.ts report --limit 15
```

Optional env:

- `GITHUB_TOKEN` / `GH_TOKEN` — GitHub GraphQL (Actions provides this automatically)
- `SMITHERY_API_KEY` — only if Smithery starts requiring auth for public list

## Automation

- [`.github/workflows/collect.yml`](.github/workflows/collect.yml) — daily cron (`17 6 * * *`) plus `workflow_dispatch`. Writes snapshots, commits `data/`, then runs the health check.
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — lint, typecheck, tests (recorded fixtures, no live network).

### Health check

If a source's row count drops **more than 30%** versus the previous snapshot, `npm run health` exits non-zero and opens a GitHub issue labeled `source-health` (deduped if one is already open). Skipped sources (missing optional credentials) are not compared.

## Development

```bash
npm test
npm run lint
npm run typecheck
```

Adapters live under `src/adapters/` and share a `SourceAdapter` interface (`catalog` then `enrichment`). Zod validates wire payloads; a bad row is dropped, a >50% invalid page fails the source.

## Roadmap

- **M2:** Glama / PulseMCP / other public MCP catalogs if they offer APIs
- **M3:** ChatGPT apps / Claude connectors *only* via official public data
- **M4:** hosted explorer on top of this history
