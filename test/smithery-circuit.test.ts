import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSmitheryUseCountOutage, smitheryAdapter } from "../src/adapters/smithery.ts";
import { createDiscoveredRefs } from "../src/adapters/types.ts";
import { collect } from "../src/commands/collect.ts";
import { evaluateHealth } from "../src/commands/health.ts";
import { HTTP_MAX_RETRIES, SMITHERY_USECOUNT_CIRCUIT_BREAKER_THRESHOLD } from "../src/lib/config.ts";
import { HttpError, createHttpClient, type FetchImpl } from "../src/lib/http.ts";
import { inspectSnapshot, readSourceRows } from "../src/lib/io.ts";
import { createLogger } from "../src/lib/logger.ts";
import { persistEntityCache, persistLastFetched } from "../src/lib/rolling.ts";
import { snapshotIsPartial } from "../src/lib/schema.ts";
import { fixtureFetch, jsonResponse, loadFixture } from "./helpers.ts";

const silent = createLogger({
  log() {},
  warn() {},
  error() {},
});

function smitheryServer(index: number, homepage = false) {
  return {
    qualifiedName: `srv/${String(index).padStart(2, "0")}`,
    displayName: `Server ${index}`,
    useCount: 1000 - index,
    ...(homepage ? { homepage: "https://github.com/brave/brave-search-mcp" } : {}),
  };
}

function smitheryList(count: number) {
  const servers = Array.from({ length: count }, (_, index) => smitheryServer(index, index === 0));
  return {
    servers,
    pagination: { currentPage: 1, pageSize: 100, totalPages: 1, totalCount: count },
  };
}

describe("smithery useCount circuit breaker", () => {
  it("stops after 10 consecutive 500s, keeps last-known rows, and still collects every other source", async () => {
    expect(SMITHERY_USECOUNT_CIRCUIT_BREAKER_THRESHOLD).toBe(10);
    const catalogSize = SMITHERY_USECOUNT_CIRCUIT_BREAKER_THRESHOLD + 2;
    const dataDir = mkdtempSync(join(tmpdir(), "radar-smithery-breaker-"));
    const date = "2026-11-02";
    persistEntityCache(dataDir, "smithery", {
      "srv/00": { useCount: 111111 },
      "srv/10": { useCount: 424242 },
    });
    persistLastFetched(dataDir, "smithery", { "srv/10": "2026-10-24T01:00:00Z" });

    const list = smitheryList(catalogSize);
    let useCountRequests = 0;
    const useCountNames: string[] = [];
    const catalogFetch = fixtureFetch([
      { match: /registry.modelcontextprotocol.io\/v0.1\/servers\?limit=100&version=latest$/, body: loadFixture("mcp-page.json") },
      { match: /cursor=page-2/, body: loadFixture("mcp-page-2.json") },
      { match: "geminicli.com/extensions.json", body: loadFixture("gemini.json") },
      {
        match: "api.npmjs.org/downloads/point/last-week/@example%2Fweather-mcp",
        body: loadFixture<Record<string, unknown>>("npm-point.json")["@example/weather-mcp"],
      },
      { match: "pypistats.org/api/packages/example-files-mcp/recent", body: loadFixture("pypi-recent.json") },
    ]);
    const fetchImpl: FetchImpl = async (input, init) => {
      const url = String(input);
      if (url.includes("api.smithery.ai")) {
        if (new URL(url).searchParams.has("q")) {
          useCountRequests += 1;
          useCountNames.push(new URL(url).searchParams.get("q") ?? "");
          return new Response("upstream down", { status: 500 });
        }
        return jsonResponse(list);
      }
      if (url.includes("api.github.com/graphql")) {
        const raw = String(init?.body ?? "");
        let query = raw;
        try {
          const parsed = JSON.parse(raw) as { query?: string };
          if (parsed.query) {
            query = parsed.query;
          }
        } catch {
          // body is the raw query
        }
        const data: Record<string, unknown> = {};
        const pattern = /r(\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g;
        for (const match of query.matchAll(pattern)) {
          const owner = match[2]!;
          const repo = match[3]!;
          data[`r${match[1]}`] = {
            nameWithOwner: `${owner}/${repo}`,
            url: `https://github.com/${owner}/${repo}`,
            stargazerCount: 42,
            forkCount: 7,
            pushedAt: "2026-11-01T12:00:00Z",
            isArchived: false,
            issues: { totalCount: 3 },
          };
        }
        return jsonResponse({ data });
      }
      return catalogFetch(input, init);
    };

    const outcome = await collect({
      date,
      dataDir,
      now: new Date(`${date}T12:00:00Z`),
      env: { GH_STATS_TOKEN: "stats-token", GITHUB_TOKEN: "unused-actions-token" },
      http: createHttpClient({ fetchImpl, maxRetries: HTTP_MAX_RETRIES, sleep: async () => {} }),
      log: silent,
      sourceAttempts: 3,
      sleep: async () => {},
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.wrote).toBe(true);
    expect(useCountRequests).toBe(SMITHERY_USECOUNT_CIRCUIT_BREAKER_THRESHOLD);
    expect(useCountRequests).toBeLessThan(catalogSize * (HTTP_MAX_RETRIES + 1));
    expect(useCountNames.filter((name) => name === "srv/00")).toHaveLength(HTTP_MAX_RETRIES + 1);
    expect(useCountNames.filter((name) => name === "srv/01")).toHaveLength(
      SMITHERY_USECOUNT_CIRCUIT_BREAKER_THRESHOLD - (HTTP_MAX_RETRIES + 1),
    );
    expect(useCountNames).not.toContain("srv/02");

    const manifest = outcome.manifest;
    expect(manifest?.partial).toBe(true);
    expect(snapshotIsPartial(manifest!)).toBe(true);
    expect(inspectSnapshot(date, dataDir).needsRetry).toBe(true);
    expect(manifest?.failedSourceCount).toBe(1);
    expect(outcome.failedSources).toEqual(["smithery"]);
    expect(manifest?.completedSources).toEqual(["mcp-registry", "gemini-cli", "github", "npm", "pypi"]);

    const smithery = manifest?.sources.find((source) => source.source === "smithery");
    expect(smithery).toMatchObject({
      failed: true,
      skipped: false,
      error: "circuit_breaker_5xx",
      skipReason: "circuit_breaker_5xx",
      rowCount: catalogSize,
      fetchedThisRunCount: 0,
      fetchedShare: 0,
      stoppedAt: { source: "smithery", error: "circuit_breaker_5xx" },
    });

    const smitheryRows = readSourceRows(date, dataDir).filter((row) => row.source === "smithery");
    expect(smitheryRows).toHaveLength(catalogSize);
    expect(smitheryRows.every((row) => row.carried_forward === true && row.frozen === true)).toBe(true);
    expect(smitheryRows.find((row) => row.source_id === "srv/00")).toMatchObject({ use_count: 111111 });
    expect(smitheryRows.find((row) => row.source_id === "srv/10")).toMatchObject({
      use_count: 424242,
      fetched_at: "2026-10-24T01:00:00Z",
    });
    expect(smitheryRows.find((row) => row.source_id === "srv/11")?.use_count).toBe(1000 - 11);

    for (const name of ["mcp-registry", "gemini-cli", "github", "npm", "pypi"] as const) {
      const source = manifest?.sources.find((row) => row.source === name);
      expect(source?.rowCount).toBeGreaterThan(0);
      expect(source?.failed).toBeFalsy();
      expect(source?.fetchedShare).toBe(1);
    }
    expect(readSourceRows(date, dataDir).some((row) => row.source === "github")).toBe(true);
    expect(readSourceRows(date, dataDir).some((row) => row.source === "npm")).toBe(true);
    expect(readSourceRows(date, dataDir).some((row) => row.source === "pypi")).toBe(true);

    const health = evaluateHealth({ date, dataDir });
    expect(health.ok).toBe(false);
    expect(health.findings).toEqual([]);
    expect(health.coverageFindings.map((finding) => finding.source)).toEqual(["smithery"]);
  });

  it("does not trip when scattered 500s stay under the streak and a success resets the counter", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-smithery-streak-"));
    const count = 19;
    const list = smitheryList(count);
    let useCountRequests = 0;
    const result = await smitheryAdapter.collect({
      snapshotDate: "2026-11-02",
      collectedAt: "2026-11-02T12:00:00Z",
      now: new Date("2026-11-02T12:00:00Z"),
      dataDir,
      env: {},
      log: silent,
      discovered: createDiscoveredRefs(),
      sleep: async () => {},
      http: createHttpClient({
        maxRetries: 0,
        sleep: async () => {},
        fetchImpl: async (input) => {
          const url = String(input);
          if (!url.includes("api.smithery.ai")) {
            throw new Error(`unexpected ${url}`);
          }
          if (!new URL(url).searchParams.has("q")) {
            return jsonResponse(list);
          }
          useCountRequests += 1;
          const name = new URL(url).searchParams.get("q") ?? "";
          const index = Number(name.split("/")[1]);
          // Groups of four 500s separated by a 200. Sixteen failures, no streak of 10.
          if (index % 5 === 4) {
            return jsonResponse({
              servers: [{ qualifiedName: name, useCount: 77 }],
              pagination: { currentPage: 1, pageSize: 10, totalPages: 1, totalCount: 1 },
            });
          }
          return new Response("upstream down", { status: 500 });
        },
      }),
    });

    expect(useCountRequests).toBe(count);
    expect(useCountRequests).toBeGreaterThan(SMITHERY_USECOUNT_CIRCUIT_BREAKER_THRESHOLD);
    expect(result.failed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.skipReason).toBeUndefined();
    expect(result.fetchedShare).toBeCloseTo(3 / count);
    expect(result.fetchedThisRunCount).toBe(count);
    expect((result.raw as { useCountRefresh?: { circuitOpen?: boolean } }).useCountRefresh?.circuitOpen).toBe(false);
    for (const sourceId of ["srv/04", "srv/09", "srv/14"]) {
      expect(result.records.find((row) => row.source_id === sourceId)).toMatchObject({
        use_count: 77,
        carried_forward: false,
        frozen: false,
      });
    }
    expect(result.records.find((row) => row.source_id === "srv/00")).toMatchObject({
      carried_forward: true,
      frozen: false,
    });
    expect(result.records.find((row) => row.source_id === "srv/18")).toMatchObject({
      carried_forward: true,
      frozen: false,
    });
    expect(isSmitheryUseCountOutage(new HttpError("https://api.smithery.ai/servers?q=srv", 500, "down"))).toBe(true);
    expect(isSmitheryUseCountOutage(new HttpError("https://api.smithery.ai/servers?q=srv", 503, "down"))).toBe(true);
    expect(isSmitheryUseCountOutage(new TypeError("fetch failed"))).toBe(true);
    expect(isSmitheryUseCountOutage(new HttpError("https://api.smithery.ai/servers?q=srv", 404, "missing"))).toBe(false);
    expect(isSmitheryUseCountOutage(new Error("Invalid JSON from https://api.smithery.ai/servers"))).toBe(false);
  });

  it("counts consecutive network errors toward the same request limit", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-smithery-network-"));
    const list = smitheryList(4);
    let useCountRequests = 0;
    const result = await smitheryAdapter.collect({
      snapshotDate: "2026-11-02",
      collectedAt: "2026-11-02T12:00:00Z",
      now: new Date("2026-11-02T12:00:00Z"),
      dataDir,
      env: {},
      log: silent,
      discovered: createDiscoveredRefs(),
      sleep: async () => {},
      http: createHttpClient({
        maxRetries: 4,
        sleep: async () => {},
        fetchImpl: async (input) => {
          const url = String(input);
          if (!new URL(url).searchParams.has("q")) {
            return jsonResponse(list);
          }
          useCountRequests += 1;
          throw new TypeError("fetch failed");
        },
      }),
    });
    expect(useCountRequests).toBe(SMITHERY_USECOUNT_CIRCUIT_BREAKER_THRESHOLD);
    expect(result.failed).toBe(true);
    expect(result.error).toBe("circuit_breaker_5xx");
    expect(result.records.every((row) => row.carried_forward === true && row.frozen === true)).toBe(true);
    expect(result.fetchedThisRunCount).toBe(0);
    expect(result.fetchedShare).toBe(0);
  });
});
