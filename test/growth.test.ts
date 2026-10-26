import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubAdapter, githubStatsToken, buildGithubGraphqlQuery } from "../src/adapters/github.ts";
import { npmAdapter, npmBulkUrl, isScopedNpmPackage } from "../src/adapters/npm.ts";
import { pypiAdapter, pypiMonthlyInconsistent, pypiRecentUrl } from "../src/adapters/pypi.ts";
import { createDiscoveredRefs, type CollectContext } from "../src/adapters/types.ts";
import { GITHUB_GRAPHQL_BATCH, NPM_BULK_LIMIT, SOURCE_FREEZE_RATIO } from "../src/lib/config.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { writeNormalized } from "../src/lib/io.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { persistEntityCache, persistLastFetched } from "../src/lib/rolling.ts";
import { emptySourceRow, type SnapshotManifest, type SourceRow } from "../src/lib/schema.ts";
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
    expect(result.freshWithin7dCount).toBe(1);
    expect(result.fetchedThisRunCount).toBe(1);
    expect(result.coverage).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("refetches repos last seen on a previous UTC day", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-gh-"));
    persistLastFetched(dataDir, "github", { "example/weather": "2026-10-14T00:00:00Z" });
    persistEntityCache(dataDir, "github", {
      "example/weather": {
        nameWithOwner: "example/weather",
        url: "https://github.com/example/weather",
        stargazerCount: 1,
        forkCount: 0,
        pushedAt: "2026-10-01T00:00:00Z",
        isArchived: false,
        issues: { totalCount: 0 },
      },
    });
    const discovered = createDiscoveredRefs();
    discovered.githubRepos.set("example/weather", { owner: "example", repo: "weather" });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify(loadFixture("github-graphql.json")), {
        status: 200,
        headers: { "content-type": "application/json" },
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
    expect(calls).toBe(1);
    expect(result.fetchedThisRunCount).toBe(1);
    expect(result.freshTodayCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      stars: 42,
      carried_forward: false,
      fetched_at: "2026-10-15T12:00:00Z",
    });
  });

  it("skips repos already fetched today and still emits cached rows", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-gh-today-"));
    persistLastFetched(dataDir, "github", { "example/weather": "2026-10-15T06:00:00Z" });
    persistEntityCache(dataDir, "github", {
      "example/weather": loadFixture<{ data: { r0: unknown } }>("github-graphql.json").data.r0,
    });
    const discovered = createDiscoveredRefs();
    discovered.githubRepos.set("example/weather", { owner: "example", repo: "weather" });
    let calls = 0;
    const result = await githubAdapter.collect(
      ctx({
        dataDir,
        http: createHttpClient({
          fetchImpl: async () => {
            calls += 1;
            throw new Error("should not fetch same-day live values");
          },
          maxRetries: 0,
        }),
        env: { GITHUB_TOKEN: "test-token" },
        discovered,
      }),
    );
    expect(calls).toBe(0);
    expect(result.fetchedThisRunCount).toBe(0);
    expect(result.freshTodayCount).toBe(1);
    expect(result.records[0]?.carried_forward).toBe(false);
    expect(result.records[0]?.fetched_at).toBe("2026-10-15T06:00:00Z");
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
    expect(result.freshTodayCount).toBe(1);
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
        http: createHttpClient({ fetchImpl, maxRetries: 0, sleep: async () => {} }),
        discovered,
        sleep: async () => {},
      }),
    );
    expect(calls).toBeGreaterThan(1);
    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.eligibleCount).toBe(2);
    expect(result.coverage).toBe(0.5);
  });

  it("retries a scoped 429 and still finishes without truncating", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-retry-"));
    const discovered = createDiscoveredRefs();
    discovered.npmPackages.add("left-pad");
    discovered.npmPackages.add("@scope/pkg");
    let calls = 0;
    const fetchImpl = async (input: string | URL) => {
      calls += 1;
      const url = String(input);
      if (url.includes("left-pad")) {
        return new Response(JSON.stringify({ downloads: 9, package: "left-pad" }), { status: 200 });
      }
      if (calls < 3) {
        return new Response("error code: 1015", {
          status: 429,
          headers: { "retry-after": "0", "cf-mitigated": "challenge" },
        });
      }
      return new Response(JSON.stringify({ downloads: 4, package: "@scope/pkg" }), { status: 200 });
    };
    const result = await npmAdapter.collect(
      ctx({
        dataDir,
        http: createHttpClient({ fetchImpl, maxRetries: 0, sleep: async () => {} }),
        discovered,
        sleep: async () => {},
      }),
    );
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(result.truncated).toBe(false);
    expect(result.rowCount).toBe(2);
    expect(result.coverage).toBe(1);
  });

  it("marks npm partial when more than 20% of due keys fail", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-failshare-"));
    const discovered = createDiscoveredRefs();
    for (const name of ["ok-1", "ok-2", "ok-3", "fail-1", "fail-2"]) {
      discovered.npmPackages.add(name);
    }
    const result = await npmAdapter.collect(
      ctx({
        dataDir,
        http: createHttpClient({
          fetchImpl: fixtureFetch([
            {
              match: "api.npmjs.org/downloads/point/last-week/",
              body: {
                "ok-1": { downloads: 1, package: "ok-1" },
                "ok-2": { downloads: 2, package: "ok-2" },
                "ok-3": { downloads: 3, package: "ok-3" },
              },
            },
          ]),
          maxRetries: 0,
        }),
        discovered,
      }),
    );
    expect(result.fetchedThisRunCount).toBe(3);
    expect(result.eligibleCount).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.stoppedAt?.error).toMatch(/failed 2\/5/);
  });

  it("does not mark npm partial when 20% or fewer due keys fail", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-okshare-"));
    const discovered = createDiscoveredRefs();
    for (const name of ["ok-1", "ok-2", "ok-3", "ok-4", "fail-1"]) {
      discovered.npmPackages.add(name);
    }
    const result = await npmAdapter.collect(
      ctx({
        dataDir,
        http: createHttpClient({
          fetchImpl: fixtureFetch([
            {
              match: "api.npmjs.org/downloads/point/last-week/",
              body: {
                "ok-1": { downloads: 1, package: "ok-1" },
                "ok-2": { downloads: 2, package: "ok-2" },
                "ok-3": { downloads: 3, package: "ok-3" },
                "ok-4": { downloads: 4, package: "ok-4" },
              },
            },
          ]),
          maxRetries: 0,
        }),
        discovered,
      }),
    );
    expect(result.fetchedThisRunCount).toBe(4);
    expect(result.truncated).toBe(false);
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
    expect(result.records[0]).toMatchObject({
      pypi_last_week_downloads: 80,
      pypi_last_month_downloads: 300,
      carried_forward: false,
      frozen: false,
    });
  });

  it("treats last_month < last_week as an invalid PyPI row, not fresh", async () => {
    expect(pypiMonthlyInconsistent(100, 0)).toBe(true);
    expect(pypiMonthlyInconsistent(80, 300)).toBe(false);
    const dataDir = mkdtempSync(join(tmpdir(), "radar-pypi-inconsistent-"));
    const discovered = createDiscoveredRefs();
    discovered.pypiPackages.add("zotero-mcp");
    const result = await pypiAdapter.collect(
      ctx({
        snapshotDate: "2026-10-25",
        collectedAt: "2026-10-25T12:00:00Z",
        now: new Date("2026-10-25T12:00:00Z"),
        dataDir,
        http: createHttpClient({
          fetchImpl: fixtureFetch([
            {
              match: "pypistats.org/api/packages/zotero-mcp/recent",
              body: {
                data: { last_day: 20, last_week: 100, last_month: 0 },
                package: "zotero-mcp",
                type: "recent_downloads",
              },
            },
          ]),
          maxRetries: 0,
        }),
        discovered,
      }),
    );
    expect(result.records[0]).toMatchObject({
      pypi_last_week_downloads: 100,
      pypi_last_month_downloads: 0,
      carried_forward: true,
      frozen: true,
    });
    const apps = mergeApps("2026-10-25", result.records);
    expect(apps[0]).toMatchObject({
      pypi_last_week_downloads_carried_forward: true,
      pypi_last_month_downloads_carried_forward: true,
    });
  });

  it("does not stamp a frozen PyPI last_month as fresh when weekly moved (zotero-mcp = 20314)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-pypi-month-"));
    const writeDay = (date: string, week: number, month: number) => {
      const rows: SourceRow[] = [
        emptySourceRow({
          snapshot_date: date,
          source: "pypi",
          source_id: "zotero-mcp",
          name: "zotero-mcp",
          pypi_package: "zotero-mcp",
          pypi_last_week_downloads: week,
          pypi_last_month_downloads: month,
          app_id: "pypi:zotero-mcp",
          fetched_at: `${date}T12:00:00Z`,
        }),
      ];
      const manifest: SnapshotManifest = {
        snapshotDate: date,
        collectedAt: `${date}T12:00:00Z`,
        appCount: 1,
        sourceRowCount: 1,
        partial: false,
        completedSources: ["pypi"],
        sources: [{ source: "pypi", rowCount: 1, skipped: false, collectedAt: `${date}T12:00:00Z` }],
      };
      writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
    };
    writeDay("2026-10-18", 900, 20314);
    writeDay("2026-10-22", 1100, 20314);
    writeDay("2026-10-24", 1300, 20314);
    expect(existsSync(join(dataDir, "normalized", "2026-10-23"))).toBe(false);
    const discovered = createDiscoveredRefs();
    discovered.pypiPackages.add("zotero-mcp");
    const result = await pypiAdapter.collect(
      ctx({
        snapshotDate: "2026-10-25",
        collectedAt: "2026-10-25T12:00:00Z",
        now: new Date("2026-10-25T12:00:00Z"),
        dataDir,
        http: createHttpClient({
          fetchImpl: fixtureFetch([
            {
              match: "pypistats.org/api/packages/zotero-mcp/recent",
              body: {
                data: { last_day: 50, last_week: 1400, last_month: 20314 },
                package: "zotero-mcp",
                type: "recent_downloads",
              },
            },
          ]),
          maxRetries: 0,
        }),
        discovered,
      }),
    );
    expect(existsSync(join(dataDir, "normalized", "2026-10-23"))).toBe(false);
    expect(result.records[0]).toMatchObject({
      pypi_last_week_downloads: 1400,
      pypi_last_month_downloads: 20314,
      carried_forward: false,
      frozen: true,
    });
    const apps = mergeApps("2026-10-25", result.records);
    expect(apps[0]).toMatchObject({
      pypi_last_week_downloads: 1400,
      pypi_last_week_downloads_carried_forward: false,
      pypi_last_month_downloads: 20314,
      pypi_last_month_downloads_carried_forward: true,
    });
  });

  it("freezes one stuck PyPI last_month when 19 of 20 packages still move", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-pypi-per-row-"));
    const stuck = "zotero-mcp";
    const live = Array.from({ length: 19 }, (_, index) => `live-mcp-${String(index).padStart(2, "0")}`);
    const names = [...live, stuck];
    expect(names).toHaveLength(20);
    expect(1 / names.length).toBeLessThan(SOURCE_FREEZE_RATIO);

    const liveWeek = (name: string, day: number) => 100 * day + Number(name.slice(-2));
    const liveMonth = (name: string, day: number) => 1000 * day + Number(name.slice(-2));
    const writeDay = (date: string, day: number) => {
      const rows: SourceRow[] = names.map((name) =>
        emptySourceRow({
          snapshot_date: date,
          source: "pypi",
          source_id: name,
          name,
          pypi_package: name,
          pypi_last_week_downloads: name === stuck ? 1000 + day * 100 : liveWeek(name, day),
          pypi_last_month_downloads: name === stuck ? 20314 : liveMonth(name, day),
          app_id: `pypi:${name}`,
          fetched_at: `${date}T12:00:00Z`,
        }),
      );
      const manifest: SnapshotManifest = {
        snapshotDate: date,
        collectedAt: `${date}T12:00:00Z`,
        appCount: rows.length,
        sourceRowCount: rows.length,
        partial: false,
        completedSources: ["pypi"],
        sources: [{ source: "pypi", rowCount: rows.length, skipped: false, collectedAt: `${date}T12:00:00Z` }],
      };
      writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
    };
    writeDay("2026-10-22", 2);
    writeDay("2026-10-24", 3);
    expect(existsSync(join(dataDir, "normalized", "2026-10-23"))).toBe(false);

    const discovered = createDiscoveredRefs();
    for (const name of names) {
      discovered.pypiPackages.add(name);
    }
    const result = await pypiAdapter.collect(
      ctx({
        snapshotDate: "2026-10-25",
        collectedAt: "2026-10-25T12:00:00Z",
        now: new Date("2026-10-25T12:00:00Z"),
        dataDir,
        sleep: async () => {},
        http: createHttpClient({
          fetchImpl: fixtureFetch(
            names.map((name) => ({
              match: `pypistats.org/api/packages/${name}/recent`,
              body: {
                data:
                  name === stuck
                    ? { last_day: 50, last_week: 1400, last_month: 20314 }
                    : {
                        last_day: 10,
                        last_week: liveWeek(name, 4),
                        last_month: liveMonth(name, 4),
                      },
                package: name,
                type: "recent_downloads",
              },
            })),
          ),
          maxRetries: 0,
          sleep: async () => {},
        }),
        discovered,
      }),
    );

    expect(existsSync(join(dataDir, "normalized", "2026-10-23"))).toBe(false);
    expect(result.records).toHaveLength(20);
    const stuckRow = result.records.find((row) => row.source_id === stuck);
    expect(stuckRow).toMatchObject({
      pypi_last_week_downloads: 1400,
      pypi_last_month_downloads: 20314,
      carried_forward: false,
      frozen: true,
    });
    const liveRows = result.records.filter((row) => row.source_id !== stuck);
    expect(liveRows).toHaveLength(19);
    expect(liveRows.every((row) => row.frozen === false && row.carried_forward === false)).toBe(true);
    expect(liveRows.every((row) => (row.pypi_last_month_downloads ?? 0) > (row.pypi_last_week_downloads ?? 0))).toBe(
      true,
    );

    const apps = mergeApps("2026-10-25", result.records);
    expect(apps.find((app) => app.pypi_package === stuck)).toMatchObject({
      pypi_last_week_downloads_carried_forward: false,
      pypi_last_month_downloads_carried_forward: true,
    });
    expect(
      apps.filter((app) => app.pypi_package !== stuck).every(
        (app) =>
          app.pypi_last_week_downloads_carried_forward === false &&
          app.pypi_last_month_downloads_carried_forward === false,
      ),
    ).toBe(true);
  });
});
