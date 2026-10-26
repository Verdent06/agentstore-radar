import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubAdapter } from "../src/adapters/github.ts";
import { createDiscoveredRefs, type CollectContext } from "../src/adapters/types.ts";
import { buildAggregate } from "../src/aggregate/build.ts";
import { movers } from "../src/aggregate/query.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { writeNormalized } from "../src/lib/io.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { persistEntityCache, persistLastFetched } from "../src/lib/rolling.ts";
import { emptySourceRow, type SnapshotManifest, type SourceRow } from "../src/lib/schema.ts";
import { loadFixture } from "./helpers.ts";

const silent = { info() {}, warn() {}, error() {} };

function ctx(partial: Partial<CollectContext> & Pick<CollectContext, "http" | "dataDir">): CollectContext {
  return {
    snapshotDate: "2026-10-16",
    collectedAt: "2026-10-16T12:00:00Z",
    now: new Date("2026-10-16T12:00:00Z"),
    env: { GITHUB_TOKEN: "test-token" },
    log: silent,
    discovered: createDiscoveredRefs(),
    ...partial,
  };
}

function manifestFor(date: string, rows: SourceRow[], extra?: Partial<SnapshotManifest>): SnapshotManifest {
  return {
    snapshotDate: date,
    collectedAt: `${date}T12:00:00Z`,
    appCount: 1,
    sourceRowCount: rows.length,
    partial: extra?.partial ?? false,
    completedSources: extra?.completedSources ?? (extra?.partial ? [] : ["github"]),
    sources: extra?.sources ?? [{ source: "github", rowCount: rows.length, skipped: false, collectedAt: `${date}T12:00:00Z` }],
    ...extra,
  };
}

describe("metric freshness", () => {
  it("writes the live GraphQL payload, not a stale cache.json value, when the key is due", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-fresh-live-"));
    persistLastFetched(dataDir, "github", { "example/weather": "2026-10-08T12:00:00Z" });
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
    const result = await githubAdapter.collect(
      ctx({
        dataDir,
        discovered,
        http: createHttpClient({
          fetchImpl: async () => {
            calls += 1;
            return new Response(JSON.stringify(loadFixture("github-graphql.json")), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
          maxRetries: 0,
        }),
      }),
    );
    expect(calls).toBe(1);
    expect(result.records[0]).toMatchObject({
      stars: 42,
      carried_forward: false,
      fetched_at: "2026-10-16T12:00:00Z",
    });
  });

  it("does not mark a same-day last_fetched cache hit as carried_forward", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-fresh-sameday-"));
    persistLastFetched(dataDir, "github", { "example/weather": "2026-10-16T06:00:00Z" });
    persistEntityCache(dataDir, "github", {
      "example/weather": loadFixture<{ data: { r0: unknown } }>("github-graphql.json").data.r0,
    });
    const discovered = createDiscoveredRefs();
    discovered.githubRepos.set("example/weather", { owner: "example", repo: "weather" });
    let calls = 0;
    const result = await githubAdapter.collect(
      ctx({
        snapshotDate: "2026-10-16",
        collectedAt: "2026-10-16T18:00:00Z",
        now: new Date("2026-10-16T18:00:00Z"),
        dataDir,
        discovered,
        http: createHttpClient({
          fetchImpl: async () => {
            calls += 1;
            throw new Error("should not fetch same-day live values");
          },
          maxRetries: 0,
        }),
      }),
    );
    expect(calls).toBe(0);
    expect(result.records[0]).toMatchObject({
      stars: 42,
      carried_forward: false,
      fetched_at: "2026-10-16T06:00:00Z",
    });
  });

  it("marks cached GitHub rows as carried_forward with the original fetched_at when this run did not refresh them", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-fresh-"));
    persistLastFetched(dataDir, "github", { "example/weather": "2026-10-15T12:00:00Z" });
    persistEntityCache(dataDir, "github", {
      "example/weather": loadFixture<{ data: { r0: unknown } }>("github-graphql.json").data.r0,
    });
    const discovered = createDiscoveredRefs();
    discovered.githubRepos.set("example/weather", { owner: "example", repo: "weather" });
    const result = await githubAdapter.collect(
      ctx({
        dataDir,
        discovered,
        http: createHttpClient({
          fetchImpl: async () =>
            new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), {
              status: 403,
              headers: { "retry-after": "0" },
            }),
          maxRetries: 0,
        }),
      }),
    );
    expect(result.truncated).toBe(true);
    expect(result.fetchedThisRunCount).toBe(0);
    expect(result.records[0]).toMatchObject({
      carried_forward: true,
      fetched_at: "2026-10-15T12:00:00Z",
      stars: 42,
    });
  });

  it("copies per-field freshness onto merged apps from the source that supplied the metric", () => {
    const apps = mergeApps("2026-10-16", [
      emptySourceRow({
        snapshot_date: "2026-10-16",
        app_id: "github:example/weather",
        source: "gemini-cli",
        source_id: "weather",
        name: "weather",
        stars: 99,
        fetched_at: "2026-10-16T12:00:00Z",
        carried_forward: false,
      }),
      emptySourceRow({
        snapshot_date: "2026-10-16",
        app_id: "github:example/weather",
        source: "github",
        source_id: "example/weather",
        name: "example/weather",
        stars: 42,
        fetched_at: "2026-10-15T12:00:00Z",
        carried_forward: true,
      }),
      emptySourceRow({
        snapshot_date: "2026-10-16",
        app_id: "github:example/weather",
        source: "smithery",
        source_id: "weather",
        name: "weather",
        use_count: 10,
        fetched_at: "2026-10-16T12:00:00Z",
        carried_forward: false,
      }),
    ]);
    expect(apps[0]).toMatchObject({
      stars: 42,
      stars_source: "github",
      stars_carried_forward: true,
      stars_fetched_at: "2026-10-15T12:00:00Z",
      use_count: 10,
      use_count_carried_forward: false,
      use_count_fetched_at: "2026-10-16T12:00:00Z",
    });
  });

  it("does not treat a carried-forward GitHub star jump as a 1-day mover", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-movers-"));
    const stale = emptySourceRow({
      snapshot_date: "2026-10-22",
      app_id: "github:morluto/rea",
      source: "github",
      source_id: "morluto/rea",
      name: "morluto/rea",
      stars: 268000,
      fetched_at: "2026-10-15T12:00:00Z",
      carried_forward: true,
    });
    const fresh = emptySourceRow({
      snapshot_date: "2026-10-24",
      app_id: "github:morluto/rea",
      source: "github",
      source_id: "morluto/rea",
      name: "morluto/rea",
      stars: 375000,
      fetched_at: "2026-10-24T12:00:00Z",
      carried_forward: false,
    });
    writeNormalized("2026-10-22", [stale], mergeApps("2026-10-22", [stale]), manifestFor("2026-10-22", [stale]), dataDir);
    writeNormalized("2026-10-24", [fresh], mergeApps("2026-10-24", [fresh]), manifestFor("2026-10-24", [fresh]), dataDir);
    const agg = buildAggregate(dataDir, "data_dir");
    const daily = movers(agg, { window: "1d", metric: "stars" });
    expect(daily.find((row) => row.id === "github:morluto/rea")).toBeUndefined();
    const weekly = movers(agg, { window: "7d", metric: "stars" });
    expect(weekly.find((row) => row.id === "github:morluto/rea")).toBeUndefined();
  });

  it("excludes partial snapshot days from movers growth windows", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-partial-movers-"));
    const day = (date: string, stars: number): SourceRow =>
      emptySourceRow({
        snapshot_date: date,
        app_id: "github:example/weather",
        source: "github",
        source_id: "example/weather",
        name: "example/weather",
        stars,
        fetched_at: `${date}T12:00:00Z`,
        carried_forward: false,
      });
    const complete = (date: string, stars: number) => {
      const rows = [day(date, stars)];
      writeNormalized(date, rows, mergeApps(date, rows), manifestFor(date, rows, { partial: false, completedSources: ["github"] }), dataDir);
    };
    const partial = (date: string, stars: number) => {
      const rows = [day(date, stars)];
      writeNormalized(
        date,
        rows,
        mergeApps(date, rows),
        manifestFor(date, rows, {
          partial: true,
          completedSources: [],
          sources: [
            {
              source: "mcp-registry",
              rowCount: 0,
              skipped: true,
              failed: true,
              collectedAt: `${date}T12:00:00Z`,
              stoppedAt: { source: "mcp-registry", page: 12, cursor: "abc", error: "HTTP 500" },
            },
            { source: "github", rowCount: 1, skipped: false, truncated: true, collectedAt: `${date}T12:00:00Z` },
          ],
        }),
        dataDir,
      );
    };
    complete("2026-10-21", 100);
    partial("2026-10-22", 9_999);
    complete("2026-10-23", 112);
    const agg = buildAggregate(dataDir, "data_dir");
    expect(agg.meta.partialDates).toEqual(["2026-10-22"]);
    expect(agg.meta.latestCompleteDate).toBe("2026-10-23");
    expect(agg.meta.previousCompleteDate).toBe("2026-10-21");
    const daily = movers(agg, { window: "1d", metric: "stars" });
    const weather = daily.find((row) => row.id === "github:example/weather");
    expect(weather).toMatchObject({ previous: 100, current: 110, delta: 10 });
    expect(weather?.previous).not.toBe(9_999);
  });
});
