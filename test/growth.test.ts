import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubAdapter, githubStatsToken, buildGithubGraphqlQuery } from "../src/adapters/github.ts";
import { npmAdapter, npmBulkUrl, isScopedNpmPackage } from "../src/adapters/npm.ts";
import { pypiAdapter, pypiRecentUrl } from "../src/adapters/pypi.ts";
import { createDiscoveredRefs, type CollectContext } from "../src/adapters/types.ts";
import { GITHUB_GRAPHQL_BATCH, NPM_BULK_LIMIT } from "../src/lib/config.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { persistEntityCache, persistLastFetched } from "../src/lib/rolling.ts";
import { chunk } from "../src/lib/util.ts";
import { fixtureFetch, loadFixture } from "./helpers.ts";

const silent = { info() {}, warn() {}, error() {} };

function ctx(partial: Partial<CollectContext> & Pick<CollectContext, "http" | "dataDir">): CollectContext {
  return {
    snapshotDate: "2026-10-15",
    collectedAt: "2026-10-15T12:00:00Z",
    now: new Date("2026-10-15T12:00:00Z"),
    env: {},
    log: silent,
    discovered: createDiscoveredRefs(),
    ...partial,
  };
}

describe("github growth adapter", () => {
  it("prefers GH_STATS_TOKEN and builds 50-wide GraphQL batches", () => {
    expect(githubStatsToken({ GH_STATS_TOKEN: "stats", GITHUB_TOKEN: "actions" })).toBe("stats");
    expect(githubStatsToken({ GITHUB_TOKEN: "actions" })).toBe("actions");
    expect(GITHUB_GRAPHQL_BATCH).toBe(50);
    const refs = Array.from({ length: 50 }, (_, index) => ({ owner: "org", repo: `r${index}` }));
    const query = buildGithubGraphqlQuery(refs);
    expect(query).toContain("r49: repository");
    expect(query).toContain("rateLimit { remaining resetAt cost }");
    expect(query).not.toContain("r50:");
  });

  it("fetches due repos, checkpoints, and reports full coverage", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-gh-"));
    const discovered = createDiscoveredRefs();
    discovered.githubRepos.set("example/weather", { owner: "example", repo: "weather" });
    const fetchImpl = fixtureFetch([{ match: "api.github.com/graphql", body: loadFixture("github-graphql.json") }]);
    const result = await githubAdapter.collect(
      ctx({
        dataDir,
        http: createHttpClient({ fetchImpl, maxRetries: 0 }),
        env: { GH_STATS_TOKEN: "test-token" },
        discovered,
      }),
    );
    expect(result.skipped).toBe(false);
    expect(result.rowCount).toBe(1);
    expect(result.eligibleCount).toBe(1);
    expect(result.fetchedCount).toBe(1);
    expect(result.coverage).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("skips repos fresher than 7 days and still emits cached rows", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-gh-"));
    persistLastFetched(dataDir, "github", { "example/weather": "2026-10-14T00:00:00Z" });
    persistEntityCache(dataDir, "github", {
      "example/weather": loadFixture<{ data: { r0: unknown } }>("github-graphql.json").data.r0,
    });
    const discovered = createDiscoveredRefs();
    discovered.githubRepos.set("example/weather", { owner: "example", repo: "weather" });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error("should not fetch fresh repos");
    };
    const result = await githubAdapter.collect(
      ctx({
        dataDir,
        http: createHttpClient({ fetchImpl, maxRetries: 0 }),
        env: { GITHUB_TOKEN: "test-token" },
        discovered,
      }),
    );
    expect(calls).toBe(0);
    expect(result.rowCount).toBe(1);
    expect(result.coverage).toBe(1);
    expect(result.fetchedCount).toBe(1);
    expect(result.records[0]?.carried_forward).toBe(true);
    expect(result.records[0]?.fetched_at).toBe("2026-10-14T00:00:00Z");
  });

  it("keeps a partial snapshot after a mid-run rate limit", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-gh-"));
    const discovered = createDiscoveredRefs();
    discovered.githubRepos.set("example/weather", { owner: "example", repo: "weather" });
    for (let index = 0; index < 50; index += 1) {
      discovered.githubRepos.set(`example/extra-${index}`, { owner: "example", repo: `extra-${index}` });
    }
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify(loadFixture("github-graphql.json")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), {
        status: 403,
        headers: { "retry-after": "0" },
      });
    };
    const result = await githubAdapter.collect(
      ctx({
        dataDir,
        http: createHttpClient({ fetchImpl, maxRetries: 0 }),
        env: { GITHUB_TOKEN: "test-token" },
        discovered,
      }),
    );
    expect(calls).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.eligibleCount).toBe(51);
    expect(result.coverage).toBeCloseTo(1 / 51);
  });

  it("logs deleted/renamed repos per-app and does not fail the GitHub source", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-gh-missing-"));
    const discovered = createDiscoveredRefs();
    discovered.githubRepos.set("example/weather", { owner: "example", repo: "weather" });
    discovered.githubRepos.set("deleted/gone", { owner: "deleted", repo: "gone" });
    const warnings: Array<{ message?: string; repo?: string }> = [];
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          data: {
            r0: loadFixture<{ data: { r0: unknown } }>("github-graphql.json").data.r0,
            r1: null,
          },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["r1"],
              message: "Could not resolve to a Repository with the name 'deleted/gone'.",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const result = await githubAdapter.collect(
      ctx({
        dataDir,
        http: createHttpClient({ fetchImpl, maxRetries: 0 }),
        env: { GH_STATS_TOKEN: "test-token" },
        discovered,
        log: {
          info() {},
          warn(_message, extra) {
            warnings.push({ message: String(_message), repo: extra && typeof extra === "object" && "repo" in extra ? String(extra.repo) : undefined });
          },
          error() {},
        },
      }),
    );
    expect(result.failed).toBeFalsy();
    expect(result.skipped).toBe(false);
    expect(result.rowCount).toBe(1);
    expect(warnings.some((row) => row.message?.includes("could not resolve repository") && row.repo === "deleted/gone")).toBe(true);
  });

  it("does not fail when a batch is all unresolved repositories", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-gh-all-missing-"));
    const discovered = createDiscoveredRefs();
    discovered.githubRepos.set("deleted/gone", { owner: "deleted", repo: "gone" });
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          data: null,
          errors: [
            {
              type: "NOT_FOUND",
              path: ["r0"],
              message: "Could not resolve to a Repository with the name 'deleted/gone'.",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const result = await githubAdapter.collect(
      ctx({
        dataDir,
        http: createHttpClient({ fetchImpl, maxRetries: 0 }),
        env: { GITHUB_TOKEN: "test-token" },
        discovered,
      }),
    );
    expect(result.failed).toBeFalsy();
    expect(result.skipped).toBe(false);
    expect(result.rowCount).toBe(0);
  });
});

describe("npm growth adapter", () => {
  it("uses the 128-wide unscoped bulk URL and fetches scoped packages individually", () => {
    expect(NPM_BULK_LIMIT).toBe(128);
    expect(isScopedNpmPackage("@scope/pkg")).toBe(true);
    const names = Array.from({ length: 200 }, (_, index) => `pkg-${index}`);
    const batches = chunk(names, NPM_BULK_LIMIT);
    expect(batches[0]).toHaveLength(128);
    expect(npmBulkUrl(batches[0]!)).toContain("pkg-0,pkg-1");
    expect(npmBulkUrl(batches[0]!).split(",")).toHaveLength(128);
  });

  it("bulk-fetches unscoped packages and records coverage", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-"));
    const discovered = createDiscoveredRefs();
    discovered.npmPackages.add("left-pad");
    discovered.npmPackages.add("once");
    discovered.npmPackages.add("@example/weather-mcp");
    const fetchImpl = fixtureFetch([
      {
        match: "api.npmjs.org/downloads/point/last-week/left-pad,once",
        body: {
          "left-pad": { downloads: 10, package: "left-pad" },
          once: { downloads: 20, package: "once" },
        },
      },
      {
        match: "api.npmjs.org/downloads/point/last-week/once,left-pad",
        body: {
          "left-pad": { downloads: 10, package: "left-pad" },
          once: { downloads: 20, package: "once" },
        },
      },
      {
        match: "api.npmjs.org/downloads/point/last-week/@example%2Fweather-mcp",
        body: loadFixture<Record<string, unknown>>("npm-point.json")["@example/weather-mcp"],
      },
    ]);
    const result = await npmAdapter.collect(
      ctx({
        dataDir,
        http: createHttpClient({ fetchImpl, maxRetries: 0 }),
        discovered,
      }),
    );
    expect(result.rowCount).toBe(3);
    expect(result.coverage).toBe(1);
    expect(result.eligibleCount).toBe(3);
  });

  it("resumes after Cloudflare 1015 with a partial snapshot", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-"));
    const discovered = createDiscoveredRefs();
    discovered.npmPackages.add("left-pad");
    discovered.npmPackages.add("@scope/pkg");
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ downloads: 9, package: "left-pad" }), { status: 200 });
      }
      return new Response("error code: 1015", {
        status: 429,
        headers: { "cf-mitigated": "challenge" },
      });
    };
    const result = await npmAdapter.collect(
      ctx({
        dataDir,
        http: createHttpClient({ fetchImpl, maxRetries: 0 }),
        discovered,
      }),
    );
    expect(calls).toBeGreaterThan(1);
    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.eligibleCount).toBe(2);
    expect(result.coverage).toBe(0.5);
  });
});

describe("pypi growth adapter", () => {
  it("throttles individual pypistats URLs and reports coverage", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-pypi-"));
    const discovered = createDiscoveredRefs();
    discovered.pypiPackages.add("example-files-mcp");
    expect(pypiRecentUrl("example-files-mcp")).toContain("/example-files-mcp/recent");
    const fetchImpl = fixtureFetch([
      { match: "pypistats.org/api/packages/example-files-mcp/recent", body: loadFixture("pypi-recent.json") },
    ]);
    const result = await pypiAdapter.collect(
      ctx({
        dataDir,
        http: createHttpClient({ fetchImpl, maxRetries: 0 }),
        discovered,
      }),
    );
    expect(result.rowCount).toBe(1);
    expect(result.coverage).toBe(1);
  });
});
