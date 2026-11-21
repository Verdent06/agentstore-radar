import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { npmAdapter } from "../src/adapters/npm.ts";
import { createDiscoveredRefs, type CollectContext } from "../src/adapters/types.ts";
import { NPM_COLLECT_BUDGET_MS } from "../src/lib/config.ts";
import { createHttpClient, type FetchImpl } from "../src/lib/http.ts";
import {
  NPM_SCOPED_CLOUDFLARE_BACKOFF_MS,
  NPM_SCOPED_MEASURED_FRESH_BULK_REQUESTS,
  NPM_SCOPED_MEASURED_FRESH_PACKAGES,
  NPM_SCOPED_MEASURED_TRIP_REQUESTS,
  NPM_SCOPED_MIN_INTERVAL_MS,
  NPM_SCOPED_RECOVERY_STREAK,
  NPM_SCOPED_WINDOW_MS,
  createNpmScopedPacer,
  npmScopedFinishMs,
  npmScopedMaxStartsPerWindow,
  orderNpmScopedNames,
  scopedRateLimitWaitMs,
} from "../src/lib/npm-scoped-pace.ts";
import { persistEntityCache, persistLastFetched } from "../src/lib/rolling.ts";
import type { SleepFn } from "../src/lib/retry.ts";

const silent = { info() {}, warn() {}, error() {} };

function clock(): { now: () => number; sleep: SleepFn; sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  const sleep: SleepFn = async (ms) => {
    sleeps.push(ms);
    now += ms;
  };
  return { now: () => now, sleep, sleeps };
}

function ctx(partial: Partial<CollectContext> & Pick<CollectContext, "http" | "dataDir">): CollectContext {
  return {
    snapshotDate: "2026-11-21",
    collectedAt: "2026-11-21T13:00:00.000Z",
    now: new Date("2026-11-21T13:00:00.000Z"),
    env: {},
    log: silent,
    discovered: createDiscoveredRefs(),
    ...partial,
  };
}

function point(name: string, downloads = 1): Response {
  return new Response(JSON.stringify({ downloads, package: name }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("npm scoped pace", () => {
  it("finishes the measured fresh catalog inside the 100-minute budget", () => {
    const starts = NPM_SCOPED_MEASURED_FRESH_PACKAGES + NPM_SCOPED_MEASURED_FRESH_BULK_REQUESTS;
    expect(npmScopedMaxStartsPerWindow()).toBe(25);
    expect(npmScopedMaxStartsPerWindow()).toBeLessThan(NPM_SCOPED_MEASURED_TRIP_REQUESTS);
    const finishMs = npmScopedFinishMs(starts);
    expect(finishMs).toBe((starts - 1) * NPM_SCOPED_MIN_INTERVAL_MS);
    expect(finishMs).toBeLessThan(NPM_COLLECT_BUDGET_MS);
    expect(finishMs / 60_000).toBeCloseTo(70.9, 0);
  });

  it("honors a positive Retry-After and does not floor a missing Cloudflare header at 15s", () => {
    expect(scopedRateLimitWaitMs({ attempt: 0, retryAfterMs: 2_000, cloudflare: true })).toBe(2_000);
    expect(scopedRateLimitWaitMs({ attempt: 0, retryAfterMs: 0, cloudflare: true })).toBe(
      NPM_SCOPED_CLOUDFLARE_BACKOFF_MS,
    );
    expect(scopedRateLimitWaitMs({ attempt: 0, cloudflare: true })).toBe(NPM_SCOPED_CLOUDFLARE_BACKOFF_MS);
    expect(scopedRateLimitWaitMs({ attempt: 1, cloudflare: true })).toBe(60_000);
    expect(scopedRateLimitWaitMs({ attempt: 4, cloudflare: true })).toBe(60_000);
  });

  it("spaces starts so a 10s window stays at or under 25, and backs off once per 429 episode", async () => {
    const { now, sleep } = clock();
    const pacer = createNpmScopedPacer({ sleep, now });
    const stamps: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      await pacer.beforeRequest();
      stamps.push(now());
    }
    expect(stamps[0]).toBe(0);
    expect(stamps[1]).toBe(NPM_SCOPED_MIN_INTERVAL_MS);
    for (let index = 0; index < stamps.length; index += 1) {
      const inWindow = stamps.filter((stamp) => stamps[index]! - stamp < NPM_SCOPED_WINDOW_MS && stamp <= stamps[index]!);
      expect(inWindow.length).toBeLessThanOrEqual(npmScopedMaxStartsPerWindow());
    }
    expect(stamps[25]! - stamps[0]!).toBeGreaterThanOrEqual(NPM_SCOPED_WINDOW_MS);

    expect(pacer.onRateLimit({ attempt: 0, retryAfterMs: 0, cloudflare: true })).toBe(NPM_SCOPED_CLOUDFLARE_BACKOFF_MS);
    expect(pacer.intervalMs).toBe(NPM_SCOPED_MIN_INTERVAL_MS + 200);
    expect(pacer.onRateLimit({ attempt: 0, cloudflare: true })).toBe(NPM_SCOPED_CLOUDFLARE_BACKOFF_MS);
    expect(pacer.intervalMs).toBe(NPM_SCOPED_MIN_INTERVAL_MS + 200);
    for (let index = 0; index < NPM_SCOPED_RECOVERY_STREAK; index += 1) {
      pacer.onSuccess();
    }
    expect(pacer.intervalMs).toBe(NPM_SCOPED_MIN_INTERVAL_MS);
  });

  it("orders scoped names stalest-first and breaks ties by higher downloads", () => {
    const ordered = orderNpmScopedNames(
      ["@scope/new", "@scope/missing", "@scope/old", "@scope/low", "@scope/high"],
      {
        "@scope/new": "2026-11-20T00:00:00.000Z",
        "@scope/old": "2026-11-01T00:00:00.000Z",
        "@scope/low": "2026-11-10T00:00:00.000Z",
        "@scope/high": "2026-11-10T00:00:00.000Z",
      },
      (name) => (name.endsWith("high") ? 9 : 1),
    );
    expect(ordered).toEqual(["@scope/missing", "@scope/old", "@scope/high", "@scope/low", "@scope/new"]);
  });

  it("requests scoped packages stalest-first with a 400ms gap", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-pace-"));
    const { now, sleep, sleeps } = clock();
    const discovered = createDiscoveredRefs();
    for (const name of ["@scope/new", "@scope/old", "@scope/mid"]) {
      discovered.npmPackages.add(name);
    }
    persistLastFetched(dataDir, "npm", {
      "@scope/new": "2026-11-20T00:00:00.000Z",
      "@scope/old": "2026-11-01T00:00:00.000Z",
      "@scope/mid": "2026-11-10T00:00:00.000Z",
    });
    const requested: string[] = [];
    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      requested.push(decodeURIComponent(url.split("/").pop() ?? ""));
      return point(requested.at(-1)!);
    };
    const result = await npmAdapter.collect(
      ctx({
        dataDir,
        discovered,
        monotonicNow: now,
        sleep,
        http: createHttpClient({ fetchImpl, maxRetries: 0, sleep }),
      }),
    );
    expect(result.truncated).toBe(false);
    expect(requested).toEqual(["@scope/old", "@scope/mid", "@scope/new"]);
    expect(sleeps.filter((ms) => ms > 0)).toEqual([NPM_SCOPED_MIN_INTERVAL_MS, NPM_SCOPED_MIN_INTERVAL_MS]);
  });

  it("skips a package already fetched earlier on the snapshot date and keeps that row fresh", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-fresh-"));
    const discovered = createDiscoveredRefs();
    discovered.npmPackages.add("@scope/today");
    discovered.npmPackages.add("@scope/old");
    persistLastFetched(dataDir, "npm", {
      "@scope/today": "2026-11-21T01:30:00.000Z",
      "@scope/old": "2026-11-20T01:30:00.000Z",
    });
    persistEntityCache(dataDir, "npm", {
      "@scope/today": { downloads: 5, package: "@scope/today" },
      "@scope/old": { downloads: 1, package: "@scope/old" },
    });
    const requested: string[] = [];
    const fetchImpl: FetchImpl = async (input) => {
      const name = decodeURIComponent(String(input).split("/").pop() ?? "");
      requested.push(name);
      return point(name, 8);
    };
    const result = await npmAdapter.collect(
      ctx({
        dataDir,
        discovered,
        http: createHttpClient({ fetchImpl, maxRetries: 0, sleep: async () => {} }),
        sleep: async () => {},
      }),
    );
    expect(requested).toEqual(["@scope/old"]);
    expect(result.truncated).toBe(false);
    expect(result.fetchedShare).toBe(1);
    const today = result.records.find((row) => row.source_id === "@scope/today");
    const old = result.records.find((row) => row.source_id === "@scope/old");
    expect(today?.carried_forward).toBe(false);
    expect(today?.npm_weekly_downloads).toBe(5);
    expect(old?.carried_forward).toBe(false);
    expect(old?.npm_weekly_downloads).toBe(8);
  });

  it("waits a Cloudflare Retry-After of 2s instead of the 15s floor", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-retry-after-"));
    const { now, sleep, sleeps } = clock();
    const discovered = createDiscoveredRefs();
    discovered.npmPackages.add("@scope/pkg");
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("error code: 1015", {
          status: 429,
          headers: { "retry-after": "2", "cf-mitigated": "challenge" },
        });
      }
      return point("@scope/pkg", 4);
    };
    const result = await npmAdapter.collect(
      ctx({
        dataDir,
        discovered,
        monotonicNow: now,
        sleep,
        http: createHttpClient({ fetchImpl, maxRetries: 0, sleep }),
      }),
    );
    expect(calls).toBe(2);
    expect(sleeps).toContain(2_000);
    expect(sleeps).not.toContain(15_000);
    expect(result.truncated).toBe(false);
    expect(result.fetchedShare).toBe(1);
    expect(result.lanes?.find((lane) => lane.lane === "scoped")).toMatchObject({
      requests: 2,
      fetched: 1,
      rateLimits: 1,
    });
  });

  it("waits 30s when Cloudflare sends no Retry-After", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-cf-"));
    const { now, sleep, sleeps } = clock();
    const discovered = createDiscoveredRefs();
    discovered.npmPackages.add("@scope/pkg");
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("error code: 1015", {
          status: 429,
          headers: { "cf-mitigated": "challenge" },
        });
      }
      return point("@scope/pkg", 4);
    };
    const result = await npmAdapter.collect(
      ctx({
        dataDir,
        discovered,
        monotonicNow: now,
        sleep,
        http: createHttpClient({ fetchImpl, maxRetries: 0, sleep }),
      }),
    );
    expect(calls).toBe(2);
    expect(sleeps).toContain(NPM_SCOPED_CLOUDFLARE_BACKOFF_MS);
    expect(sleeps).not.toContain(15_000);
    expect(result.truncated).toBe(false);
    expect(result.lanes?.find((lane) => lane.lane === "scoped")?.rateLimits).toBe(1);
  });
});
