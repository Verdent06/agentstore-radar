import { readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { npmAdapter } from "../src/adapters/npm.ts";
import { pypiAdapter } from "../src/adapters/pypi.ts";
import { createDiscoveredRefs } from "../src/adapters/types.ts";
import { collect } from "../src/commands/collect.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { readManifest } from "../src/lib/io.ts";
import { createLogger } from "../src/lib/logger.ts";
import { loadCheckpoint } from "../src/lib/rolling.ts";
import { fixtureFetch, loadFixture } from "./helpers.ts";

const silent = createLogger({
  log() {},
  warn() {},
  error() {},
});

describe("same-day backup resume", () => {
  it("overwrites the one manifest and spans fetch times across both run ids", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-resume-manifest-"));
    const date = "2026-11-03";
    const t0 = Date.parse(`${date}T05:41:00.000Z`);
    const t1 = Date.parse(`${date}T19:23:00.000Z`);
    let primaryTicks = 0;
    const npmBody = { downloads: 12, package: "@example/weather-mcp" };
    const http = () =>
      createHttpClient({
        maxRetries: 0,
        sleep: async () => {},
        fetchImpl: fixtureFetch([
          {
            match: /registry.modelcontextprotocol.io\/v0.1\/servers\?limit=100&version=latest$/,
            body: loadFixture("mcp-page.json"),
          },
          { match: /cursor=page-2/, body: loadFixture("mcp-page-2.json") },
          { match: "api.npmjs.org/downloads/point/last-week/@example%2Fweather-mcp", body: npmBody },
        ]),
      });

    const first = await collect({
      date,
      dataDir,
      sources: ["mcp-registry", "npm"],
      now: new Date(t0),
      runId: "primary",
      env: { RADAR_NPM_BUDGET_MS: "1" },
      monotonicNow: () => t0 + primaryTicks++ * 1_000,
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
      http: http(),
    });
    expect(first.wrote).toBe(true);
    expect(first.manifest?.partial).toBe(true);
    expect(loadCheckpoint(dataDir, "npm")?.snapshotDate).toBe(date);

    let backupTicks = 0;
    const second = await collect({
      date,
      dataDir,
      sources: ["mcp-registry", "npm"],
      now: new Date(t1),
      runId: "backstop",
      ifIncomplete: true,
      monotonicNow: () => t1 + backupTicks++ * 1_000,
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
      http: http(),
    });
    expect(second.wrote).toBe(true);

    const dayDir = join(dataDir, "normalized", date);
    expect(readdirSync(join(dataDir, "normalized")).filter((name) => !name.startsWith("."))).toEqual([date]);
    expect(readdirSync(dayDir).filter((name) => name.includes("manifest"))).toEqual(["manifest.json"]);

    const manifest = readManifest(date, dataDir);
    expect(manifest.snapshotDate).toBe(date);
    const npm = manifest.sources.find((source) => source.source === "npm");
    expect(npm?.fetchRunIds).toEqual(["primary", "backstop"]);
    expect(npm?.fetch_started_at).toBeDefined();
    expect(npm?.fetch_ended_at).toBeDefined();
    expect(Date.parse(npm!.fetch_started_at!)).toBeLessThan(t1);
    expect(Date.parse(npm!.fetch_ended_at!)).toBeGreaterThanOrEqual(t1);
    expect(npm!.fetch_started_at! < npm!.fetch_ended_at!).toBe(true);
  });

  it("resumes a same-snapshotDate npm checkpoint instead of refetching finished keys", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-resume-"));
    const date = "2026-11-03";
    const start = Date.parse(`${date}T05:41:00.000Z`);
    let now = start;
    const seen: string[] = [];
    const discovered = createDiscoveredRefs();
    discovered.npmPackages.add("@scope/one");
    discovered.npmPackages.add("@scope/two");
    const http = createHttpClient({
      maxRetries: 0,
      sleep: async () => {},
      fetchImpl: async (input) => {
        const url = String(input);
        seen.push(url);
        now += 120_000;
        const name = url.includes("one") ? "@scope/one" : "@scope/two";
        return new Response(JSON.stringify({ downloads: 3, package: name }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const base = {
      snapshotDate: date,
      collectedAt: `${date}T05:41:00.000Z`,
      now: new Date(start),
      dataDir,
      env: { RADAR_NPM_BUDGET_MS: "60000", RADAR_NPM_SCOPED_CONCURRENCY: "1" },
      log: silent,
      discovered,
      monotonicNow: () => now,
      sleep: async () => {},
      http,
    };
    const first = await npmAdapter.collect(base);
    expect(first.truncated).toBe(true);
    expect(first.fetchedThisRunCount).toBe(1);
    expect(loadCheckpoint(dataDir, "npm")).toMatchObject({ snapshotDate: date });
    const firstUrls = [...seen];
    expect(firstUrls).toHaveLength(1);

    now = Date.parse(`${date}T19:23:00.000Z`);
    seen.length = 0;
    const second = await npmAdapter.collect({
      ...base,
      collectedAt: `${date}T19:23:00.000Z`,
      now: new Date(now),
      env: { RADAR_NPM_SCOPED_CONCURRENCY: "1" },
    });
    expect(second.raw).toMatchObject({ resumed: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(firstUrls[0]);
    expect(second.truncated).toBe(false);
    expect(loadCheckpoint(dataDir, "npm")).toBeNull();
  });

  it("resumes a same-snapshotDate pypi checkpoint instead of refetching finished keys", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-pypi-resume-"));
    const date = "2026-11-03";
    const start = Date.parse(`${date}T05:41:00.000Z`);
    let now = start;
    const seen: string[] = [];
    const discovered = createDiscoveredRefs();
    discovered.pypiPackages.add("pkg-one");
    discovered.pypiPackages.add("pkg-two");
    const http = createHttpClient({
      maxRetries: 0,
      sleep: async () => {},
      fetchImpl: async (input) => {
        const url = String(input);
        seen.push(url);
        now += 120_000;
        const name = url.includes("pkg-one") ? "pkg-one" : "pkg-two";
        return new Response(
          JSON.stringify({ data: { last_day: 1, last_week: 4, last_month: 9 }, package: name, type: "recent_downloads" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const base = {
      snapshotDate: date,
      collectedAt: `${date}T05:41:00.000Z`,
      now: new Date(start),
      dataDir,
      env: { RADAR_PYPI_BUDGET_MS: "60000", RADAR_PYPI_CONCURRENCY: "1" },
      log: silent,
      discovered,
      monotonicNow: () => now,
      sleep: async () => {},
      http,
    };
    const first = await pypiAdapter.collect(base);
    expect(first.truncated).toBe(true);
    expect(first.fetchedThisRunCount).toBe(1);
    expect(loadCheckpoint(dataDir, "pypi")?.snapshotDate).toBe(date);
    const firstUrl = seen[0];
    now = Date.parse(`${date}T19:23:00.000Z`);
    seen.length = 0;
    const second = await pypiAdapter.collect({
      ...base,
      collectedAt: `${date}T19:23:00.000Z`,
      now: new Date(now),
      env: { RADAR_PYPI_CONCURRENCY: "1" },
    });
    expect(second.raw).toMatchObject({ resumed: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(firstUrl);
    expect(second.truncated).toBe(false);
  });
});
