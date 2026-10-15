import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collect } from "../src/commands/collect.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { createLogger } from "../src/lib/logger.ts";
import { existingRawPath, readApps, readManifest, readSourceRows } from "../src/lib/io.ts";
import { fixtureFetch, loadFixture } from "./helpers.ts";

const silent = createLogger({
  log() {},
  warn() {},
  error() {},
});

describe("collect", () => {
  it("paginates catalogs, enriches discovered packages/repos, and writes dated files", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-"));
    const fetchImpl = fixtureFetch([
      { match: /registry.modelcontextprotocol.io\/v0.1\/servers\?limit=100&version=latest$/, body: loadFixture("mcp-page.json") },
      { match: /cursor=page-2/, body: loadFixture("mcp-page-2.json") },
      { match: "api.smithery.ai/servers", body: loadFixture("smithery-page.json") },
      { match: "geminicli.com/extensions.json", body: loadFixture("gemini.json") },
      { match: "api.github.com/graphql", body: loadFixture("github-graphql.json") },
      {
        match: "api.npmjs.org/downloads/point/last-week/@example%2Fweather-mcp",
        body: loadFixture<Record<string, unknown>>("npm-point.json")["@example/weather-mcp"],
      },
      { match: "pypistats.org/api/packages/example-files-mcp/recent", body: loadFixture("pypi-recent.json") },
    ]);

    const manifest = await collect({
      date: "2026-10-15",
      dataDir,
      now: new Date("2026-10-15T12:00:00Z"),
      env: { GITHUB_TOKEN: "test-token" },
      http: createHttpClient({ fetchImpl, maxRetries: 0 }),
      log: silent,
    });

    expect(manifest.sources.find((source) => source.source === "mcp-registry")?.rowCount).toBe(3);
    expect(manifest.sources.find((source) => source.source === "smithery")?.rowCount).toBe(1);
    expect(manifest.sources.find((source) => source.source === "gemini-cli")?.rowCount).toBe(1);
    expect(manifest.sources.find((source) => source.source === "github")?.rowCount).toBe(1);
    expect(manifest.sources.find((source) => source.source === "npm")?.rowCount).toBe(1);
    expect(manifest.sources.find((source) => source.source === "pypi")?.rowCount).toBe(1);

    const apps = readApps("2026-10-15", dataDir);
    const weather = apps.find((app) => app.app_id === "github:example/weather");
    expect(weather?.stars).toBe(42);
    expect(weather?.npm_weekly_downloads).toBe(1234);
    expect(weather?.sources.split("|")).toEqual(expect.arrayContaining(["github", "mcp-registry", "npm"]));

    expect(existingRawPath("mcp-registry", "2026-10-15", dataDir)).toMatch(/2026-10-15\.json/);
    expect(readSourceRows("2026-10-15", dataDir).length).toBeGreaterThan(0);
    expect(readManifest("2026-10-15", dataDir).appCount).toBe(apps.length);
  });

  it("skips GitHub when the token is rejected", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-"));
    const fetchImpl = fixtureFetch([
      { match: /registry.modelcontextprotocol.io/, body: loadFixture("mcp-page-2.json") },
      { match: "api.smithery.ai/servers", body: loadFixture("smithery-page.json") },
      { match: "geminicli.com/extensions.json", body: [] },
      { match: "api.github.com/graphql", body: { message: "Bad credentials" }, status: 401 },
    ]);
    const manifest = await collect({
      date: "2026-10-15",
      dataDir,
      now: new Date("2026-10-15T12:00:00Z"),
      env: { GITHUB_TOKEN: "bad-token" },
      http: createHttpClient({ fetchImpl, maxRetries: 0 }),
      log: silent,
    });
    expect(manifest.sources.find((source) => source.source === "github")?.skipped).toBe(true);
  });

  it("skips GitHub when no token is present", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-"));
    const fetchImpl = fixtureFetch([
      { match: /registry.modelcontextprotocol.io/, body: loadFixture("mcp-page-2.json") },
      { match: "api.smithery.ai/servers", body: loadFixture("smithery-page.json") },
      { match: "geminicli.com/extensions.json", body: [] },
    ]);
    const manifest = await collect({
      date: "2026-10-15",
      dataDir,
      now: new Date("2026-10-15T12:00:00Z"),
      env: {},
      http: createHttpClient({ fetchImpl, maxRetries: 0 }),
      log: silent,
    });
    const github = manifest.sources.find((source) => source.source === "github");
    expect(github?.skipped).toBe(true);
    expect(github?.skipReason).toMatch(/GITHUB_TOKEN/);
  });
});
