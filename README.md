# AgentStore Radar

Free, open-source collector for cross-store analytics of AI app / agent stores — App Annie / Sensor Tower, but for MCP servers, ChatGPT apps, Claude connectors, and CLI extension galleries.

**Code:** MIT (this repository)  
**Data:** private for now (`Verdent06/agentstore-radar-data`). Public charts and leaderboards come later.

Snapshot history does **not** live in this repo. The daily collect job writes into the private data repo via a deploy key (`DATA_REPO_DEPLOY_KEY`). `data/` is gitignored here.

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

## Data layout (private repo)

Never overwrite a past day's snapshot. Same-day re-runs may refresh today's files.

```
data/raw/<source>/<YYYY-MM-DD>.json      # or .json.gz when payload ≥ 256 KiB
data/normalized/<YYYY-MM-DD>/source_rows.ndjson(.gz)
data/normalized/<YYYY-MM-DD>/apps.ndjson(.gz)
data/normalized/<YYYY-MM-DD>/manifest.json
```

Point `report`, `health`, and a future site at that tree with `DATA_DIR` or `--data`:

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
- `GITHUB_TOKEN` / `GH_TOKEN` — GitHub GraphQL (Actions provides this automatically)
- `SMITHERY_API_KEY` — only if Smithery starts requiring auth for public list
- `HEALTH_ISSUE_REPO` — `owner/name` for health issues (defaults to unset; we do not open issues on the public repo)
- `HEALTH_ISSUE_TOKEN` — optional token that can write issues on the data repo

## Automation

- [`.github/workflows/collect.yml`](.github/workflows/collect.yml) — daily cron (`17 6 * * *`) plus `workflow_dispatch`. Checks out the private data repo over SSH (`DATA_REPO_DEPLOY_KEY`), **once** copies `data/` from this repo’s git history if the data repo has no snapshots yet (writes `data/.migrated-from-public`), then collects into `DATA_DIR` and pushes **only** to the data repo. After that first success it never reads public history again. `seed_only` skips collect and just does that one-time copy.
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — lint, typecheck, tests (recorded fixtures, no live network).

### Health check

If a source's row count drops **more than 30%** versus the previous snapshot, `npm run health` exits non-zero. Issues are opened on `HEALTH_ISSUE_REPO` (the private data repo) when a token can write there. The public repo is never used as a fallback, and alerts do not attach snapshot files.

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
- **M4:** public charts / leaderboards on top of the private history
