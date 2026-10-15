/**
 * Small live smoke test for growth-signal adapters. Not part of CI.
 * Hits a handful of public endpoints to confirm bulk/GraphQL/throttle paths.
 */
import { githubAdapter, githubStatsToken } from "../src/adapters/github.ts";
import { npmAdapter } from "../src/adapters/npm.ts";
import { pypiAdapter } from "../src/adapters/pypi.ts";
import { createDiscoveredRefs, type CollectContext } from "../src/adapters/types.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { createLogger } from "../src/lib/logger.ts";
import { parseGithubRepo } from "../src/lib/matching.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const now = new Date();
const dataDir = mkdtempSync(join(tmpdir(), "radar-smoke-"));
const log = createLogger();
const http = createHttpClient({ maxRetries: 3 });
const discovered = createDiscoveredRefs();

for (const slug of ["expressjs/express", "lodash/lodash"]) {
  const ref = parseGithubRepo(`https://github.com/${slug}`);
  if (ref) {
    discovered.githubRepos.set(`${ref.owner}/${ref.repo}`, ref);
  }
}
discovered.npmPackages.add("lodash");
discovered.npmPackages.add("express");
discovered.npmPackages.add("@types/node");
discovered.pypiPackages.add("requests");

const ctx: CollectContext = {
  snapshotDate: now.toISOString().slice(0, 10),
  collectedAt: now.toISOString(),
  dataDir,
  now,
  env: process.env,
  http,
  log,
  discovered,
};

const results = [];
const token = githubStatsToken(process.env);
if (token) {
  results.push(await githubAdapter.collect(ctx));
} else {
  log.warn("smoke: skipping live GitHub (no GH_STATS_TOKEN/GITHUB_TOKEN)");
}
results.push(await npmAdapter.collect(ctx));
results.push(await pypiAdapter.collect(ctx));

let failed = false;
for (const result of results) {
  const coverage = result.coverage ?? 0;
  const ok = !result.skipped && (result.fetchedCount ?? 0) > 0 && coverage >= 1;
  log.info(`smoke ${result.source}`, {
    skipped: result.skipped,
    rows: result.rowCount,
    eligible: result.eligibleCount,
    fetched: result.fetchedCount,
    coverage,
    ok,
  });
  if (!ok) {
    failed = true;
  }
}

if (failed) {
  console.error("growth-signal smoke failed");
  process.exit(1);
}
console.log("growth-signal smoke passed", { dataDir });
