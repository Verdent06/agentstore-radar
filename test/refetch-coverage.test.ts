import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubAdapter } from "../src/adapters/github.ts";
import { createDiscoveredRefs, type CollectContext } from "../src/adapters/types.ts";
import { collect } from "../src/commands/collect.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { createLogger } from "../src/lib/logger.ts";
import { readManifest, readSourceRows } from "../src/lib/io.ts";
import {
  computeRefetchStats,
  formatRefetchStepSummary,
  meetsRefetchedExistingCoverage,
  planExistingRefetch,
  REFETCH_EXISTING_MIN_SHARE,
  withRefetchStats,
} from "../src/lib/refetch-coverage.ts";
import { persistEntityCache, persistLastFetched, selectRunBatch } from "../src/lib/rolling.ts";
import { emptySourceRow, withObservation, type SourceManifest, type SourceRow } from "../src/lib/schema.ts";
import { fixtureFetch, loadFixture } from "./helpers.ts";

const silent = createLogger({
  log() {},
  warn() {},
  error() {},
});

function ctx(partial: Partial<CollectContext> & Pick<CollectContext, "http" | "dataDir">): CollectContext {
  return {
    snapshotDate: "2026-10-25",
    collectedAt: "2026-10-25T12:00:00Z",
    now: new Date("2026-10-25T12:00:00Z"),
    env: {},
    log: silent,
    discovered: createDiscoveredRefs(),
    ...partial,
  };
}

function githubRow(
  sourceId: string,
  stars: number,
  observation: { fetchedAt: string; carried: boolean; frozen?: boolean },
): SourceRow {
  return withObservation(
    emptySourceRow({
      snapshot_date: "2026-11-01",
      app_id: `github:${sourceId}`,
      source: "github",
      source_id: sourceId,
      name: sourceId,
      stars,
    }),
    observation.fetchedAt,
    observation.carried,
    observation.frozen ?? false,
  );
}

describe("refetch coverage", () => {
  it("reports share 0 and fails the 0.9 check when a run fetches only new ids", () => {
    const existing = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const lastFetched = Object.fromEntries(existing.map((key, index) => [key, `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00Z`]));
    const due = ["new/one", "new/two", ...existing];
    // The 2026-11-01 batch did this: missing last_fetched sorts first, then the cap
    // keeps only those new ids. Existing repos never enter the batch.
    expect(selectRunBatch(due, lastFetched, 2)).toEqual(["new/one", "new/two"]);

    const previous = existing.map((id, index) =>
      githubRow(id, index + 1, { fetchedAt: "2026-10-28T00:00:00Z", carried: false }),
    );
    const current = [
      ...existing.map((id, index) => githubRow(id, index + 1, { fetchedAt: "2026-10-28T00:00:00Z", carried: true })),
      githubRow("new/one", 4, { fetchedAt: "2026-11-01T00:00:00Z", carried: false }),
      githubRow("new/two", 5, { fetchedAt: "2026-11-01T00:00:00Z", carried: false }),
    ];
    const stats = computeRefetchStats("github", previous, current);
    expect(stats).toMatchObject({
      existingRows: 10,
      refetchedExisting: 0,
      refetchedExistingShare: 0,
      mismatchChangedNotFresh: 0,
      mismatchFreshUnchanged: 0,
    });
    expect(meetsRefetchedExistingCoverage(stats?.refetchedExistingShare ?? 1)).toBe(false);
    expect(REFETCH_EXISTING_MIN_SHARE).toBe(0.9);
  });

  it("a rotation reaches at least 0.9 by keeping the stalest existing repos ahead of new ids", () => {
    const existing = Array.from({ length: 10 }, (_, index) => `exist/${String(index).padStart(2, "0")}`);
    const lastFetched = Object.fromEntries(
      existing.map((key, index) => [key, `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00Z`]),
    );
    const due = [...existing, "new/one", "new/two"];
    const plan = planExistingRefetch(due, lastFetched, 2);
    expect(plan.existingTarget).toBe(9);
    expect(plan.keys.slice(0, 9)).toEqual(existing.slice(0, 9));
    expect(plan.keys.slice(9)).toEqual(["new/one", "new/two"]);
    expect(plan.keys).not.toContain("exist/09");

    const previous = existing.map((id) => githubRow(id, 10, { fetchedAt: lastFetched[id] ?? "", carried: false }));
    const current = [
      ...existing.slice(0, 9).map((id) => githubRow(id, 10, { fetchedAt: "2026-11-01T00:00:00Z", carried: false })),
      githubRow("exist/09", 10, { fetchedAt: lastFetched["exist/09"] ?? "", carried: true }),
      githubRow("new/one", 1, { fetchedAt: "2026-11-01T00:00:00Z", carried: false }),
    ];
    const stats = computeRefetchStats("github", previous, current);
    expect(stats?.refetchedExistingShare).toBe(0.9);
    expect(meetsRefetchedExistingCoverage(stats?.refetchedExistingShare ?? 0)).toBe(true);
    expect(stats?.mismatchFreshUnchanged).toBe(9);
    expect(stats?.mismatchChangedNotFresh).toBe(0);
  });

  it("counts A and B on a small github and npm fixture and skips A/B for mcp-registry", () => {
    const previous = [
      githubRow("changed-stale", 10, { fetchedAt: "2026-10-28T00:00:00Z", carried: false }),
      githubRow("fresh-same", 5, { fetchedAt: "2026-10-28T00:00:00Z", carried: false }),
      githubRow("fresh-moved", 5, { fetchedAt: "2026-10-28T00:00:00Z", carried: false }),
      githubRow("stale-same", 5, { fetchedAt: "2026-10-28T00:00:00Z", carried: false }),
      githubRow("frozen-same", 1, { fetchedAt: "2026-10-28T00:00:00Z", carried: false }),
      githubRow("frozen-moved", 4, { fetchedAt: "2026-10-28T00:00:00Z", carried: false }),
      githubRow("dropped", 7, { fetchedAt: "2026-10-28T00:00:00Z", carried: false }),
      withObservation(
        emptySourceRow({
          snapshot_date: "2026-11-01",
          app_id: "npm:left-pad",
          source: "npm",
          source_id: "left-pad",
          name: "left-pad",
          npm_weekly_downloads: 10,
        }),
        "2026-10-28T00:00:00Z",
        false,
      ),
      withObservation(
        emptySourceRow({
          snapshot_date: "2026-11-01",
          app_id: "npm:right-pad",
          source: "npm",
          source_id: "right-pad",
          name: "right-pad",
          npm_weekly_downloads: 3,
        }),
        "2026-10-28T00:00:00Z",
        false,
      ),
      emptySourceRow({
        snapshot_date: "2026-10-31",
        app_id: "mcp:weather",
        source: "mcp-registry",
        source_id: "io.github.example/weather",
        name: "weather",
      }),
      emptySourceRow({
        snapshot_date: "2026-10-31",
        app_id: "mcp:gone-stale",
        source: "mcp-registry",
        source_id: "io.github.example/stale",
        name: "stale",
      }),
    ];
    const current = [
      githubRow("changed-stale", 12, { fetchedAt: "2026-10-28T00:00:00Z", carried: true }),
      githubRow("fresh-same", 5, { fetchedAt: "2026-11-01T00:00:00Z", carried: false }),
      githubRow("fresh-moved", 8, { fetchedAt: "2026-11-01T00:00:00Z", carried: false }),
      githubRow("stale-same", 5, { fetchedAt: "2026-10-28T00:00:00Z", carried: true }),
      githubRow("frozen-same", 1, { fetchedAt: "2026-11-01T00:00:00Z", carried: false, frozen: true }),
      githubRow("frozen-moved", 9, { fetchedAt: "2026-11-01T00:00:00Z", carried: false, frozen: true }),
      githubRow("brand-new", 3, { fetchedAt: "2026-11-01T00:00:00Z", carried: false }),
      withObservation(
        emptySourceRow({
          snapshot_date: "2026-11-01",
          app_id: "npm:left-pad",
          source: "npm",
          source_id: "left-pad",
          name: "left-pad",
          npm_weekly_downloads: 10,
        }),
        "2026-11-01T00:00:00Z",
        false,
      ),
      withObservation(
        emptySourceRow({
          snapshot_date: "2026-11-01",
          app_id: "npm:right-pad",
          source: "npm",
          source_id: "right-pad",
          name: "right-pad",
          npm_weekly_downloads: 4,
        }),
        "2026-10-28T00:00:00Z",
        true,
      ),
      emptySourceRow({
        snapshot_date: "2026-11-01",
        app_id: "mcp:weather",
        source: "mcp-registry",
        source_id: "io.github.example/weather",
        name: "weather",
        carried_forward: false,
        frozen: false,
      }),
      withObservation(
        emptySourceRow({
          snapshot_date: "2026-11-01",
          app_id: "mcp:gone-stale",
          source: "mcp-registry",
          source_id: "io.github.example/stale",
          name: "stale",
        }),
        "2026-10-28T00:00:00Z",
        true,
      ),
    ];

    expect(computeRefetchStats("github", previous, current)).toEqual({
      existingRows: 6,
      refetchedExisting: 2,
      refetchedExistingShare: 2 / 6,
      mismatchChangedNotFresh: 2,
      mismatchFreshUnchanged: 1,
    });
    expect(computeRefetchStats("npm", previous, current)).toEqual({
      existingRows: 2,
      refetchedExisting: 1,
      refetchedExistingShare: 0.5,
      mismatchChangedNotFresh: 1,
      mismatchFreshUnchanged: 1,
    });
    const mcp = computeRefetchStats("mcp-registry", previous, current);
    expect(mcp).toEqual({
      existingRows: 2,
      refetchedExisting: 1,
      refetchedExistingShare: 0.5,
    });
    expect(mcp?.mismatchChangedNotFresh).toBeUndefined();
    expect(mcp?.mismatchFreshUnchanged).toBeUndefined();
    expect(computeRefetchStats("pypi", previous, current)).toBeUndefined();

    const summary = formatRefetchStepSummary("2026-11-01", [
      withRefetchStats({ source: "github", rowCount: 1, skipped: false, collectedAt: "2026-11-01T00:00:00Z" }, current, previous),
      withRefetchStats({ source: "npm", rowCount: 1, skipped: false, collectedAt: "2026-11-01T00:00:00Z" }, current, previous),
      withRefetchStats(
        { source: "mcp-registry", rowCount: 1, skipped: false, collectedAt: "2026-11-01T00:00:00Z" },
        current,
        previous,
      ),
      { source: "pypi", rowCount: 1, skipped: false, collectedAt: "2026-11-01T00:00:00Z" },
    ] satisfies SourceManifest[]);
    expect(summary).toContain("| github | 6 | 2 | 0.333 | 2 | 1 | fail |");
    expect(summary).toContain("| npm | 2 | 1 | 0.500 | 1 | 1 | fail |");
    expect(summary).toContain("| mcp-registry | 2 | 1 | 0.500 |  |  | fail |");
    expect(summary).not.toContain("pypi");
  });

  it("fetches at least 90% of existing repos when the batch cap only fits the new ids", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-gh-rotate-"));
    const existing = Array.from({ length: 10 }, (_, index) => `org/repo-${String(index).padStart(2, "0")}`);
    const lastFetched: Record<string, string> = {};
    const cache: Record<string, unknown> = {};
    for (const [index, key] of existing.entries()) {
      lastFetched[key] = `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00Z`;
      cache[key] = {
        nameWithOwner: key,
        url: `https://github.com/${key}`,
        stargazerCount: 10,
        forkCount: 0,
        pushedAt: "2026-10-01T00:00:00Z",
        isArchived: false,
        issues: { totalCount: 0 },
      };
    }
    persistLastFetched(dataDir, "github", lastFetched);
    persistEntityCache(dataDir, "github", cache);
    const discovered = createDiscoveredRefs();
    for (const key of existing) {
      const [owner, repo] = key.split("/");
      discovered.githubRepos.set(key, { owner: owner ?? "", repo: repo ?? "" });
    }
    discovered.githubRepos.set("org/new-a", { owner: "org", repo: "new-a" });
    discovered.githubRepos.set("org/new-b", { owner: "org", repo: "new-b" });

    let query = "";
    const result = await githubAdapter.collect(
      ctx({
        dataDir,
        env: { GH_STATS_TOKEN: "test-token", RADAR_GITHUB_BATCH: "2" },
        discovered,
        http: createHttpClient({
          fetchImpl: async (_input, init) => {
            const raw = String(init?.body ?? "");
            query = raw;
            try {
              const parsed = JSON.parse(raw) as { query?: string };
              if (parsed.query) {
                query = parsed.query;
              }
            } catch {
              // raw query
            }
            const data: Record<string, unknown> = {};
            const pattern = /r(\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g;
            for (const match of query.matchAll(pattern)) {
              const owner = match[2] ?? "";
              const repo = match[3] ?? "";
              data[`r${match[1]}`] = {
                nameWithOwner: `${owner}/${repo}`,
                url: `https://github.com/${owner}/${repo}`,
                stargazerCount: 10,
                forkCount: 0,
                pushedAt: "2026-10-01T00:00:00Z",
                isArchived: false,
                issues: { totalCount: 0 },
              };
            }
            return new Response(JSON.stringify({ data }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
          maxRetries: 0,
        }),
      }),
    );

    expect(query).toContain('name: "repo-00"');
    expect(query).toContain('name: "new-a"');
    expect(query).not.toContain('name: "repo-09"');
    const previous = existing.map((id) => githubRow(id, 10, { fetchedAt: lastFetched[id] ?? "", carried: false }));
    const stats = computeRefetchStats("github", previous, result.records);
    expect(stats?.existingRows).toBe(10);
    expect(stats?.refetchedExisting).toBe(9);
    expect(stats?.refetchedExistingShare).toBeGreaterThanOrEqual(0.9);
    expect(meetsRefetchedExistingCoverage(stats?.refetchedExistingShare ?? 0)).toBe(true);
    expect(result.records.find((row) => row.source_id === "org/repo-09")?.carried_forward).toBe(true);
    expect(result.records.find((row) => row.source_id === "org/new-a")?.carried_forward).toBe(false);
  });
});

describe("collect refetch manifest", () => {
  it("writes existing/refetched counts for github, npm, and mcp-registry and prints the step summary", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-refetch-collect-"));
    const summaryPath = join(dataDir, "summary.md");
    const catalogFetch = fixtureFetch([
      { match: /registry.modelcontextprotocol.io\/v0.1\/servers\?limit=100&version=latest$/, body: loadFixture("mcp-page.json") },
      { match: /cursor=page-2/, body: loadFixture("mcp-page-2.json") },
      { match: "api.smithery.ai/servers", body: loadFixture("smithery-page.json") },
      { match: "geminicli.com/extensions.json", body: loadFixture("gemini.json") },
      {
        match: "api.npmjs.org/downloads/point/last-week/@example%2Fweather-mcp",
        body: loadFixture<Record<string, unknown>>("npm-point.json")["@example/weather-mcp"],
      },
      { match: "pypistats.org/api/packages/example-files-mcp/recent", body: loadFixture("pypi-recent.json") },
    ]);
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("api.github.com/graphql")) {
        const raw = String(init?.body ?? "");
        let query = raw;
        try {
          const parsed = JSON.parse(raw) as { query?: string };
          if (parsed.query) {
            query = parsed.query;
          }
        } catch {
          // raw query
        }
        const data: Record<string, unknown> = {};
        const pattern = /r(\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g;
        for (const match of query.matchAll(pattern)) {
          const owner = match[2] ?? "";
          const repo = match[3] ?? "";
          data[`r${match[1]}`] = {
            nameWithOwner: `${owner}/${repo}`,
            url: `https://github.com/${owner}/${repo}`,
            stargazerCount: owner === "example" && repo === "weather" ? 42 : 1,
            forkCount: 7,
            pushedAt: "2026-10-14T12:00:00Z",
            isArchived: false,
            issues: { totalCount: 3 },
          };
        }
        return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return catalogFetch(input, init);
    };
    const http = createHttpClient({ fetchImpl, maxRetries: 0 });

    await collect({
      date: "2026-10-15",
      dataDir,
      now: new Date("2026-10-15T12:00:00Z"),
      env: { GH_STATS_TOKEN: "stats-token" },
      http,
      log: silent,
    });

    const second = await collect({
      date: "2026-10-16",
      dataDir,
      now: new Date("2026-10-16T12:00:00Z"),
      env: { GH_STATS_TOKEN: "stats-token", GITHUB_STEP_SUMMARY: summaryPath },
      http,
      log: silent,
    });

    const manifest = second.manifest ?? readManifest("2026-10-16", dataDir);
    const github = manifest.sources.find((source) => source.source === "github");
    const npm = manifest.sources.find((source) => source.source === "npm");
    const mcp = manifest.sources.find((source) => source.source === "mcp-registry");
    const pypi = manifest.sources.find((source) => source.source === "pypi");
    expect(github?.existingRows).toBeGreaterThan(0);
    expect(github?.refetchedExistingShare).toBeGreaterThanOrEqual(0.9);
    expect(meetsRefetchedExistingCoverage(github?.refetchedExistingShare ?? 0)).toBe(true);
    expect(github?.mismatchChangedNotFresh).toBe(0);
    expect(github?.mismatchFreshUnchanged).toBe(github?.refetchedExisting);
    expect(npm?.existingRows).toBeGreaterThan(0);
    expect(npm?.refetchedExistingShare).toBeGreaterThanOrEqual(0.9);
    expect(npm?.mismatchChangedNotFresh).toBeTypeOf("number");
    expect(mcp?.existingRows).toBeGreaterThan(0);
    expect(mcp?.refetchedExisting).toBe(mcp?.existingRows);
    expect(mcp?.refetchedExistingShare).toBe(1);
    expect(mcp?.mismatchChangedNotFresh).toBeUndefined();
    expect(mcp?.mismatchFreshUnchanged).toBeUndefined();
    expect(pypi?.existingRows).toBeUndefined();

    const previousGithub = readSourceRows("2026-10-15", dataDir).filter((row) => row.source === "github");
    expect(previousGithub.length).toBeGreaterThan(0);
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toContain("### Refetch coverage 2026-10-16");
    expect(summary).toContain("| github |");
    expect(summary).toContain("| npm |");
    expect(summary).toContain("| mcp-registry |");
    expect(summary).toContain("| pass |");
    expect(summary).not.toContain("| pypi |");
  });
});
