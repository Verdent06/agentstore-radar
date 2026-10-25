import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeGeminiExtension } from "../src/adapters/gemini.ts";
import { normalizeGithubRepo } from "../src/adapters/github.ts";
import { normalizeMcpServer } from "../src/adapters/mcp-registry.ts";
import { normalizeNpmPoint } from "../src/adapters/npm.ts";
import { normalizePypiRecent } from "../src/adapters/pypi.ts";
import { smitheryAdapter, smitheryUseCountSearchUrl, normalizeSmitheryServer } from "../src/adapters/smithery.ts";
import { createDiscoveredRefs } from "../src/adapters/types.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { writeNormalized } from "../src/lib/io.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { persistEntityCache, persistLastFetched } from "../src/lib/rolling.ts";
import { emptySourceRow, type SnapshotManifest, type SourceRow } from "../src/lib/schema.ts";
import { fixtureFetch, loadFixture } from "./helpers.ts";

const PIPEWORX_GATEWAY = "pipeworx/gateway";
const PIPEWORX_USE_COUNT = 419019;

describe("source normalizers", () => {
  it("maps official MCP registry rows onto a github app_id and packages", () => {
    const page = loadFixture<{ servers: unknown[] }>("mcp-page.json");
    const weather = normalizeMcpServer("2026-10-15", page.servers[0]);
    expect(weather?.row.app_id).toBe("github:example/weather");
    expect(weather?.row.npm_package).toBe("@example/weather-mcp");
    expect(weather?.row.repo_url).toBe("https://github.com/example/weather");
    expect(weather?.explicitGithub).toBe(true);

    const files = normalizeMcpServer("2026-10-15", page.servers[1]);
    expect(files?.row.app_id).toBe("pypi:example-files-mcp");
    expect(files?.row.pypi_package).toBe("example-files-mcp");
  });

  it("keeps smithery useCount and matches github homepages", () => {
    const page = loadFixture<{ servers: unknown[] }>("smithery-page.json");
    const row = normalizeSmitheryServer("2026-10-15", page.servers[0]);
    expect(row?.use_count).toBe(87579);
    expect(row?.app_id).toBe("github:brave/brave-search-mcp");
  });

  it("maps the Gemini gallery onto github repos and stars", () => {
    const extensions = loadFixture<unknown[]>("gemini.json");
    const row = normalizeGeminiExtension("2026-10-15", extensions[0]);
    expect(row?.app_id).toBe("github:obra/superpowers");
    expect(row?.stars).toBe(299294);
  });

  it("reads GitHub GraphQL repository nodes", () => {
    const payload = loadFixture<{ data: { r0: unknown } }>("github-graphql.json");
    const row = normalizeGithubRepo("2026-10-15", payload.data.r0);
    expect(row?.stars).toBe(42);
    expect(row?.forks).toBe(7);
    expect(row?.open_issues).toBe(3);
    expect(row?.app_id).toBe("github:example/weather");
  });

  it("reads npm weekly downloads and pypistats recent counts", () => {
    const npm = loadFixture<Record<string, unknown>>("npm-point.json");
    const npmRow = normalizeNpmPoint("2026-10-15", "@example/weather-mcp", npm["@example/weather-mcp"]);
    expect(npmRow?.npm_weekly_downloads).toBe(1234);
    expect(npmRow?.app_id).toBe("npm:@example/weather-mcp");

    const pypi = loadFixture<unknown>("pypi-recent.json");
    const pypiRow = normalizePypiRecent("2026-10-15", "example-files-mcp", pypi);
    expect(pypiRow?.pypi_last_week_downloads).toBe(80);
    expect(pypiRow?.app_id).toBe("pypi:example-files-mcp");
  });

  it("drops invalid rows instead of throwing", () => {
    expect(normalizeMcpServer("2026-10-15", { nope: true })).toBeNull();
    expect(normalizeSmitheryServer("2026-10-15", {})).toBeNull();
  });

  it("overlays live Smithery search useCount instead of the stale browse-index value", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-smithery-"));
    const list = loadFixture<{ servers: unknown[]; pagination: unknown }>("smithery-page.json");
    const brave = list.servers[0] as { qualifiedName: string; useCount: number };
    expect(brave.useCount).toBe(87579);
    expect(smitheryUseCountSearchUrl("brave")).toContain("q=brave");
    const result = await smitheryAdapter.collect({
      snapshotDate: "2026-10-25",
      collectedAt: "2026-10-25T12:00:00Z",
      now: new Date("2026-10-25T12:00:00Z"),
      dataDir,
      env: {},
      log: { info() {}, warn() {}, error() {} },
      discovered: createDiscoveredRefs(),
      http: createHttpClient({
        fetchImpl: fixtureFetch([
          {
            match: /[?&]q=brave/,
            body: {
              servers: [{ ...brave, useCount: 119026 }],
              pagination: { currentPage: 1, pageSize: 10, totalPages: 1, totalCount: 1 },
            },
          },
          { match: "api.smithery.ai/servers", body: list },
        ]),
        maxRetries: 0,
      }),
    });
    expect(result.records[0]).toMatchObject({
      use_count: 119026,
      carried_forward: false,
      fetched_at: "2026-10-25T12:00:00Z",
    });
    expect((result.raw as { useCountRefresh?: { updated: number } }).useCountRefresh?.updated).toBe(1);
  });

  it("flags browse-index Smithery useCount as carried_forward when search does not refresh it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-smithery-stale-"));
    persistLastFetched(dataDir, "smithery", { brave: "2026-10-24T12:00:00Z" });
    persistEntityCache(dataDir, "smithery", { brave: { useCount: 119026 } });
    const list = loadFixture<{ servers: unknown[] }>("smithery-page.json");
    const result = await smitheryAdapter.collect({
      snapshotDate: "2026-10-25",
      collectedAt: "2026-10-25T12:00:00Z",
      now: new Date("2026-10-25T12:00:00Z"),
      dataDir,
      env: {},
      log: { info() {}, warn() {}, error() {} },
      discovered: createDiscoveredRefs(),
      http: createHttpClient({
        fetchImpl: fixtureFetch([
          {
            match: /[?&]q=/,
            body: { servers: [], pagination: { currentPage: 1, pageSize: 10, totalPages: 1, totalCount: 0 } },
          },
          { match: "api.smithery.ai/servers", body: list },
        ]),
        maxRetries: 0,
      }),
    });
    expect(result.records[0]).toMatchObject({
      use_count: 119026,
      carried_forward: true,
      fetched_at: "2026-10-24T12:00:00Z",
    });
  });

  it("does not stamp a real unchanged Smithery useCount as fresh (pipeworx/gateway = 419019)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-smithery-frozen-"));
    const pipeworx = {
      qualifiedName: PIPEWORX_GATEWAY,
      displayName: "Pipeworx Gateway",
      useCount: PIPEWORX_USE_COUNT,
    };
    const list = {
      servers: [pipeworx],
      pagination: { currentPage: 1, pageSize: 100, totalPages: 1, totalCount: 1 },
    };
    const writeDay = (date: string) => {
      const rows: SourceRow[] = [
        emptySourceRow({
          snapshot_date: date,
          source: "smithery",
          source_id: PIPEWORX_GATEWAY,
          name: PIPEWORX_GATEWAY,
          use_count: PIPEWORX_USE_COUNT,
          app_id: `smithery:${PIPEWORX_GATEWAY}`,
          fetched_at: `${date}T12:00:00Z`,
        }),
      ];
      const manifest: SnapshotManifest = {
        snapshotDate: date,
        collectedAt: `${date}T12:00:00Z`,
        appCount: 1,
        sourceRowCount: 1,
        partial: false,
        completedSources: ["smithery"],
        sources: [{ source: "smithery", rowCount: 1, skipped: false, collectedAt: `${date}T12:00:00Z` }],
      };
      writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
    };
    writeDay("2026-10-21");
    writeDay("2026-10-22");
    writeDay("2026-10-24");
    persistLastFetched(dataDir, "smithery", { [PIPEWORX_GATEWAY]: "2026-10-24T12:00:00Z" });
    persistEntityCache(dataDir, "smithery", { [PIPEWORX_GATEWAY]: { useCount: PIPEWORX_USE_COUNT } });
    expect(existsSync(join(dataDir, "normalized", "2026-10-23"))).toBe(false);

    const result = await smitheryAdapter.collect({
      snapshotDate: "2026-10-25",
      collectedAt: "2026-10-25T12:00:00Z",
      now: new Date("2026-10-25T12:00:00Z"),
      dataDir,
      env: {},
      log: { info() {}, warn() {}, error() {} },
      discovered: createDiscoveredRefs(),
      http: createHttpClient({
        fetchImpl: fixtureFetch([
          {
            match: /[?&]q=pipeworx%2Fgateway/,
            body: {
              servers: [pipeworx],
              pagination: { currentPage: 1, pageSize: 10, totalPages: 1, totalCount: 1 },
            },
          },
          { match: "api.smithery.ai/servers", body: list },
        ]),
        maxRetries: 0,
      }),
    });

    expect(existsSync(join(dataDir, "normalized", "2026-10-23"))).toBe(false);
    expect(result.records[0]).toMatchObject({
      source_id: PIPEWORX_GATEWAY,
      use_count: PIPEWORX_USE_COUNT,
      carried_forward: true,
      frozen: true,
    });
    expect(result.freshTodayCount).toBe(0);
    expect(result.fetchedThisRunCount).toBe(1);
    expect((result.raw as { useCountRefresh?: { unchanged: number; frozen: number } }).useCountRefresh).toMatchObject({
      unchanged: 1,
      frozen: 1,
    });
  });

  it("counts fetchedThisRun as search hits this run and marks a 429-truncated search partial", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-smithery-429-"));
    const brave = loadFixture<{ servers: Array<{ qualifiedName: string; useCount: number }> }>("smithery-page.json").servers[0]!;
    const extra = {
      qualifiedName: "example/weather",
      displayName: "Weather",
      useCount: 12,
    };
    const list = {
      servers: [extra, brave],
      pagination: { currentPage: 1, pageSize: 100, totalPages: 1, totalCount: 2 },
    };
    let searchCalls = 0;
    const result = await smitheryAdapter.collect({
      snapshotDate: "2026-10-25",
      collectedAt: "2026-10-25T12:00:00Z",
      now: new Date("2026-10-25T12:00:00Z"),
      dataDir,
      env: {},
      log: { info() {}, warn() {}, error() {} },
      discovered: createDiscoveredRefs(),
      http: createHttpClient({
        fetchImpl: async (input) => {
          const url = String(input);
          if (/[?&]q=/.test(url)) {
            searchCalls += 1;
            if (searchCalls === 1) {
              const name = new URL(url).searchParams.get("q") ?? extra.qualifiedName;
              const hit = name === brave.qualifiedName ? brave : extra;
              return new Response(
                JSON.stringify({
                  servers: [hit],
                  pagination: { currentPage: 1, pageSize: 10, totalPages: 1, totalCount: 1 },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
          }
          return new Response(JSON.stringify(list), { status: 200, headers: { "content-type": "application/json" } });
        },
        maxRetries: 0,
        sleep: async () => {},
      }),
      sleep: async () => {},
    });
    expect(result.records).toHaveLength(2);
    expect(result.fetchedThisRunCount).toBe(1);
    expect(result.fetchedThisRunCount).not.toBe(result.records.length);
    expect(result.truncated).toBe(true);
    expect((result.raw as { useCountRefresh?: { truncated: boolean; attempted: number } }).useCountRefresh).toMatchObject({
      truncated: true,
      attempted: 2,
    });
  });
});
