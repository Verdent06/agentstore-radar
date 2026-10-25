import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collect } from "../src/commands/collect.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { createLogger } from "../src/lib/logger.ts";
import { existingRawPath, readApps, readManifest, readSourceRows } from "../src/lib/io.ts";
import { loadLastFetched } from "../src/lib/rolling.ts";
import { fixtureFetch, loadFixture } from "./helpers.ts";

const silent = createLogger({
  log() {},
  warn() {},
  error() {},
});

describe("collect", () => {
  it("paginates catalogs, enriches discovered packages/repos, and writes dated files", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-"));
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

    const { manifest } = await collect({
      date: "2026-10-15",
      dataDir,
      now: new Date("2026-10-15T12:00:00Z"),
      env: { GH_STATS_TOKEN: "stats-token", GITHUB_TOKEN: "unused-actions-token" },
      http: createHttpClient({ fetchImpl, maxRetries: 0 }),
      log: silent,
    });

    expect(manifest?.sources.find((source) => source.source === "mcp-registry")?.rowCount).toBe(3);
    expect(manifest?.sources.find((source) => source.source === "smithery")?.rowCount).toBe(1);
    expect(manifest?.sources.find((source) => source.source === "gemini-cli")?.rowCount).toBe(1);
    expect(manifest?.sources.find((source) => source.source === "github")?.rowCount).toBe(3);
    expect(manifest?.sources.find((source) => source.source === "npm")?.rowCount).toBe(1);
    expect(manifest?.sources.find((source) => source.source === "pypi")?.rowCount).toBe(1);
    expect(manifest?.sources.find((source) => source.source === "github")?.coverage).toBe(1);
    expect(manifest?.sources.find((source) => source.source === "github")?.freshTodayCount).toBe(3);
    expect(manifest?.sources.find((source) => source.source === "github")?.freshWithin7dCount).toBe(3);
    expect(manifest?.sources.find((source) => source.source === "github")?.fetchedThisRunCount).toBe(3);
    expect(manifest?.sources.find((source) => source.source === "github")?.fetchedCount).toBeUndefined();
    expect(manifest?.sources.find((source) => source.source === "npm")?.coverage).toBe(1);
    expect(manifest?.sources.find((source) => source.source === "pypi")?.coverage).toBe(1);
    expect(manifest?.partial).toBe(false);
    expect(manifest?.completedSources).toEqual(
      expect.arrayContaining(["mcp-registry", "smithery", "gemini-cli", "github", "npm", "pypi"]),
    );
    expect(manifest?.sources.find((source) => source.source === "mcp-registry")?.coverage).toBe(1);

    const apps = readApps("2026-10-15", dataDir);
    const weather = apps.find((app) => app.app_id === "github:example/weather");
    expect(weather?.stars).toBe(42);
    expect(weather?.stars_source).toBe("github");
    expect(weather?.npm_weekly_downloads).toBe(1234);
    expect(weather?.sources.split("|")).toEqual(expect.arrayContaining(["github", "mcp-registry", "npm"]));

    expect(existingRawPath("mcp-registry", "2026-10-15", dataDir)).toMatch(/2026-10-15\.json/);
    expect(readSourceRows("2026-10-15", dataDir).length).toBeGreaterThan(0);
    expect(readManifest("2026-10-15", dataDir).appCount).toBe(apps.length);
    expect(loadLastFetched(dataDir, "github")["example/weather"]).toBe("2026-10-15T12:00:00.000Z");
    expect(loadLastFetched(dataDir, "npm")["@example/weather-mcp"]).toBe("2026-10-15T12:00:00.000Z");
  });

  it("skips GitHub when the token is rejected", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-"));
    const fetchImpl = fixtureFetch([
      { match: /registry.modelcontextprotocol.io/, body: loadFixture("mcp-page-2.json") },
      { match: "api.smithery.ai/servers", body: loadFixture("smithery-page.json") },
      { match: "geminicli.com/extensions.json", body: [] },
      { match: "api.github.com/graphql", body: { message: "Bad credentials" }, status: 401 },
    ]);
    const { manifest } = await collect({
      date: "2026-10-15",
      dataDir,
      now: new Date("2026-10-15T12:00:00Z"),
      env: { GITHUB_TOKEN: "bad-token" },
      http: createHttpClient({ fetchImpl, maxRetries: 0 }),
      log: silent,
    });
    expect(manifest?.sources.find((source) => source.source === "github")?.skipped).toBe(true);
  });

  it("skips GitHub when no token is present", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-"));
    const fetchImpl = fixtureFetch([
      { match: /registry.modelcontextprotocol.io/, body: loadFixture("mcp-page-2.json") },
      { match: "api.smithery.ai/servers", body: loadFixture("smithery-page.json") },
      { match: "geminicli.com/extensions.json", body: [] },
    ]);
    const { manifest } = await collect({
      date: "2026-10-15",
      dataDir,
      now: new Date("2026-10-15T12:00:00Z"),
      env: {},
      http: createHttpClient({ fetchImpl, maxRetries: 0 }),
      log: silent,
    });
    const github = manifest?.sources.find((source) => source.source === "github");
    expect(github?.skipped).toBe(true);
    expect(github?.skipReason).toMatch(/GITHUB_TOKEN/);
  });
});
