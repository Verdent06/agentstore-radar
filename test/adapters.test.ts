import { mkdtempSync } from "node:fs";
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
import { persistEntityCache, persistLastFetched } from "../src/lib/rolling.ts";
import { fixtureFetch, loadFixture } from "./helpers.ts";

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
});
