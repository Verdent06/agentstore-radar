import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { npmAdapter } from "../src/adapters/npm.ts";
import { pypiAdapter } from "../src/adapters/pypi.ts";
import { createDiscoveredRefs } from "../src/adapters/types.ts";
import { collect } from "../src/commands/collect.ts";
import {
  GITHUB_COLLECT_BUDGET_MS,
  GEMINI_COLLECT_BUDGET_MS,
  MCP_COLLECT_BUDGET_MS,
  NPM_COLLECT_BUDGET_MS,
  PYPI_COLLECT_BUDGET_MS,
  SMITHERY_COLLECT_BUDGET_MS,
} from "../src/lib/config.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { createLogger } from "../src/lib/logger.ts";
import { loadCheckpoint, persistEntityCache, persistLastFetched } from "../src/lib/rolling.ts";
import { fixtureFetch, loadFixture } from "./helpers.ts";

const silent = createLogger({
  log() {},
  warn() {},
  error() {},
});

/** Advances 1s on every read so a 1ms budget is exhausted on the second sample. */
function jumpingClock(): () => number {
  let ticks = 0;
  return () => {
    ticks += 1;
    return ticks * 1_000;
  };
}

describe("source wall-clock budgets", () => {
  it("sums to 250 minutes, inside the 330-minute collect step", () => {
    const total =
      MCP_COLLECT_BUDGET_MS +
      SMITHERY_COLLECT_BUDGET_MS +
      GEMINI_COLLECT_BUDGET_MS +
      GITHUB_COLLECT_BUDGET_MS +
      NPM_COLLECT_BUDGET_MS +
      PYPI_COLLECT_BUDGET_MS;
    expect(total).toBe(250 * 60 * 1000);
    expect(total).toBeLessThan(330 * 60 * 1000);
  });

  it("stops npm on budget, checkpoints that snapshot date, and freezes rows that were not refreshed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-budget-"));
    const date = "2026-11-03";
    persistLastFetched(dataDir, "npm", { "left-behind": "2026-11-02T12:00:00Z" });
    persistEntityCache(dataDir, "npm", {
      "left-behind": { downloads: 10, package: "left-behind" },
    });
    const discovered = createDiscoveredRefs();
    discovered.npmPackages.add("left-behind");
    let fetches = 0;
    const result = await npmAdapter.collect({
      snapshotDate: date,
      collectedAt: `${date}T12:00:00Z`,
      now: new Date(`${date}T12:00:00Z`),
      dataDir,
      env: { RADAR_NPM_BUDGET_MS: "1" },
      log: silent,
      discovered,
      monotonicNow: jumpingClock(),
      sleep: async () => {},
      http: createHttpClient({
        fetchImpl: async () => {
          fetches += 1;
          throw new Error("npm should not fetch after the budget trips");
        },
        maxRetries: 0,
        sleep: async () => {},
      }),
    });

    expect(fetches).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.stoppedAt?.error).toMatch(/npm wall-clock budget/);
    expect(result.records[0]).toMatchObject({
      source_id: "left-behind",
      carried_forward: true,
      frozen: true,
      npm_weekly_downloads: 10,
    });
    expect(result.fetchedShare).toBe(0);
    const checkpoint = loadCheckpoint(dataDir, "npm");
    expect(checkpoint).toMatchObject({ snapshotDate: date, nextIndex: 0, dueKeys: ["left-behind"] });
  });

  it("stops pypi on budget and keeps a same-day checkpoint for the packages left behind", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-pypi-budget-"));
    const date = "2026-11-03";
    persistLastFetched(dataDir, "pypi", { "left-behind": "2026-11-02T12:00:00Z" });
    persistEntityCache(dataDir, "pypi", {
      "left-behind": { data: { last_week: 4, last_month: 9 }, package: "left-behind", type: "recent_downloads" },
    });
    const discovered = createDiscoveredRefs();
    discovered.pypiPackages.add("left-behind");
    let fetches = 0;
    const result = await pypiAdapter.collect({
      snapshotDate: date,
      collectedAt: `${date}T12:00:00Z`,
      now: new Date(`${date}T12:00:00Z`),
      dataDir,
      env: { RADAR_PYPI_BUDGET_MS: "1" },
      log: silent,
      discovered,
      monotonicNow: jumpingClock(),
      sleep: async () => {},
      http: createHttpClient({
        fetchImpl: async () => {
          fetches += 1;
          throw new Error("pypi should not fetch after the budget trips");
        },
        maxRetries: 0,
        sleep: async () => {},
      }),
    });

    expect(fetches).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.stoppedAt?.error).toMatch(/pypi wall-clock budget/);
    expect(result.records[0]).toMatchObject({
      source_id: "left-behind",
      carried_forward: true,
      frozen: true,
    });
    expect(result.fetchedShare).toBe(0);
    expect(loadCheckpoint(dataDir, "pypi")).toMatchObject({
      snapshotDate: date,
      nextIndex: 0,
      dueKeys: ["left-behind"],
    });
  });

  it("still writes a partial manifest when npm and pypi budgets trip", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-budget-manifest-"));
    const date = "2026-11-03";
    persistLastFetched(dataDir, "npm", { "@example/weather-mcp": "2026-11-02T01:00:00Z" });
    persistEntityCache(dataDir, "npm", {
      "@example/weather-mcp": { downloads: 50, package: "@example/weather-mcp" },
    });
    persistLastFetched(dataDir, "pypi", { "example-files-mcp": "2026-11-02T01:00:00Z" });
    persistEntityCache(dataDir, "pypi", {
      "example-files-mcp": {
        data: { last_week: 3, last_month: 8 },
        package: "example-files-mcp",
        type: "recent_downloads",
      },
    });
    const outcome = await collect({
      date,
      dataDir,
      sources: ["mcp-registry", "npm", "pypi"],
      now: new Date(`${date}T12:00:00Z`),
      env: { RADAR_NPM_BUDGET_MS: "1", RADAR_PYPI_BUDGET_MS: "1" },
      monotonicNow: jumpingClock(),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
      http: createHttpClient({
        maxRetries: 0,
        sleep: async () => {},
        fetchImpl: fixtureFetch([
          {
            match: /registry.modelcontextprotocol.io\/v0.1\/servers\?limit=100&version=latest$/,
            body: loadFixture("mcp-page.json"),
          },
          { match: /cursor=page-2/, body: loadFixture("mcp-page-2.json") },
        ]),
      }),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.wrote).toBe(true);
    expect(outcome.manifest?.partial).toBe(true);
    expect(outcome.manifest?.snapshotDate).toBe(date);
    expect(outcome.manifest?.completedSources).toEqual(["mcp-registry"]);
    const npm = outcome.manifest?.sources.find((source) => source.source === "npm");
    const pypi = outcome.manifest?.sources.find((source) => source.source === "pypi");
    expect(npm).toMatchObject({ truncated: true, fetchedShare: 0 });
    expect(pypi).toMatchObject({ truncated: true, fetchedShare: 0 });
    expect(npm?.stoppedAt?.error).toMatch(/wall-clock budget/);
    expect(pypi?.stoppedAt?.error).toMatch(/wall-clock budget/);
    expect(loadCheckpoint(dataDir, "npm")?.snapshotDate).toBe(date);
    expect(loadCheckpoint(dataDir, "pypi")?.snapshotDate).toBe(date);
  });
});
