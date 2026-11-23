import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { npmAdapter } from "../src/adapters/npm.ts";
import { createDiscoveredRefs, type CollectContext } from "../src/adapters/types.ts";
import { collect } from "../src/commands/collect.ts";
import { NPM_COLLECT_BUDGET_MS } from "../src/lib/config.ts";
import { createHttpClient, type FetchImpl } from "../src/lib/http.ts";
import { readSourceRows } from "../src/lib/io.ts";
import {
  NPM_SCOPED_CLOUDFLARE_BACKOFF_MS,
  NPM_SCOPED_MEASURED_FRESH_BULK_REQUESTS,
  NPM_SCOPED_MEASURED_FRESH_PACKAGES,
  NPM_SCOPED_MIN_INTERVAL_MS,
  NPM_SCOPED_RECOVERY_STREAK,
  NPM_SCOPED_SLOWDOWN,
  NPM_SCOPED_WINDOW_MS,
  createNpmScopedPacer,
  formatNpmLaneSummary,
  npmScopedFinishMs,
  npmScopedMaxStartsPerWindow,
  orderNpmScopedNames,
  scopedRateLimitWaitMs,
  type NpmScopedPacer,
  type ScopedRateLimitInput,
} from "../src/lib/npm-scoped-pace.ts";
import { loadCheckpoint, persistEntityCache, persistLastFetched } from "../src/lib/rolling.ts";
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
  it("finishes a cold 10.6k scoped catalog inside the 330-minute budget", () => {
    const starts = NPM_SCOPED_MEASURED_FRESH_PACKAGES + NPM_SCOPED_MEASURED_FRESH_BULK_REQUESTS;
    expect(NPM_SCOPED_MIN_INTERVAL_MS).toBe(1_800);
    expect(npmScopedMaxStartsPerWindow()).toBe(6);
    const scopedMs = npmScopedFinishMs(NPM_SCOPED_MEASURED_FRESH_PACKAGES);
    expect(scopedMs / 60_000).toBeCloseTo(318, 0);
    const finishMs = npmScopedFinishMs(starts);
    expect(finishMs).toBe((starts - 1) * NPM_SCOPED_MIN_INTERVAL_MS);
    expect(finishMs).toBeLessThan(NPM_COLLECT_BUDGET_MS);
    expect(finishMs / 60_000).toBeLessThan(321);
    const resume = npmScopedFinishMs(7_500);
    expect(resume / 60_000).toBeCloseTo(225, 0);
    expect(resume).toBeLessThan(NPM_COLLECT_BUDGET_MS);
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

  it("spaces starts 1.8s apart and keeps a 429 slowdown as the floor", async () => {
    const { now, sleep } = clock();
    const pacer = createNpmScopedPacer({ sleep, now });
    const stamps: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      await pacer.beforeRequest();
      stamps.push(now());
    }
    expect(stamps[0]).toBe(0);
    expect(stamps[1]).toBe(NPM_SCOPED_MIN_INTERVAL_MS);
    expect(stamps[7]! - stamps[6]!).toBe(NPM_SCOPED_MIN_INTERVAL_MS);
    for (let index = 0; index < stamps.length; index += 1) {
      const inWindow = stamps.filter((stamp) => stamps[index]! - stamp < NPM_SCOPED_WINDOW_MS && stamp <= stamps[index]!);
      expect(inWindow.length).toBeLessThanOrEqual(npmScopedMaxStartsPerWindow());
    }

    expect(pacer.onRateLimit({ attempt: 0, retryAfterMs: 0, cloudflare: true })).toBe(NPM_SCOPED_CLOUDFLARE_BACKOFF_MS);
    expect(pacer.intervalMs).toBe(NPM_SCOPED_MIN_INTERVAL_MS * NPM_SCOPED_SLOWDOWN);
    expect(pacer.floorMs).toBe(pacer.intervalMs);
    const slowed = pacer.intervalMs;
    expect(pacer.onRateLimit({ attempt: 0, cloudflare: true })).toBe(NPM_SCOPED_CLOUDFLARE_BACKOFF_MS);
    expect(pacer.intervalMs).toBe(Math.round(slowed * NPM_SCOPED_SLOWDOWN));
    expect(pacer.floorMs).toBe(pacer.intervalMs);
    for (let index = 0; index < NPM_SCOPED_RECOVERY_STREAK * 3; index += 1) {
      pacer.onSuccess();
    }
    expect(pacer.intervalMs).toBe(pacer.floorMs);
    expect(pacer.intervalMs).toBeGreaterThan(NPM_SCOPED_MIN_INTERVAL_MS);
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

  it("requests scoped packages stalest-first with a 1.8s gap", async () => {
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

  it("formats the npm job summary with the stop reason", () => {
    const summary = formatNpmLaneSummary({
      durationMs: 318 * 60_000,
      scopedRequests: 10_602,
      rateLimits: 0,
      halt: "midnight",
    });
    expect(summary).toMatch(/Wall-clock minutes: 318\.0/);
    expect(summary).toMatch(/Scoped requests per minute: 33\.34/);
    expect(summary).toMatch(/429 count: 0/);
    expect(summary).toMatch(/hit the UTC midnight stop/);
  });

  it("drops a response that lands after UTC midnight and does not write it onto the earlier day", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-midnight-"));
    const summaryPath = join(dataDir, "summary.md");
    persistLastFetched(dataDir, "npm", {
      "@scope/a": "2026-11-20T00:00:00.000Z",
      "@scope/b": "2026-11-20T00:00:00.000Z",
    });
    let wall = new Date("2026-11-21T23:59:50.000Z");
    let calls = 0;
    const requested: string[] = [];
    const fetchImpl: FetchImpl = async (input) => {
      calls += 1;
      const name = decodeURIComponent(String(input).split("/").pop() ?? "");
      requested.push(name);
      if (calls >= 2) {
        wall = new Date("2026-11-22T00:00:01.000Z");
      }
      return point(name, 4);
    };
    const outcome = await collect({
      date: "2026-11-21",
      dataDir,
      sources: ["npm"],
      now: new Date("2026-11-21T23:59:50.000Z"),
      wallNow: () => wall,
      env: { GITHUB_STEP_SUMMARY: summaryPath, RADAR_NPM_SCOPED_CONCURRENCY: "1" },
      http: createHttpClient({ fetchImpl, maxRetries: 0, sleep: async () => {} }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(calls).toBe(2);
    expect(requested).toEqual(["@scope/a", "@scope/b"]);
    expect(outcome.wrote).toBe(true);
    expect(outcome.manifest?.partial).toBe(true);
    expect(outcome.manifest?.sources.find((source) => source.source === "npm")?.truncated).toBe(true);
    const rows = readSourceRows("2026-11-21", dataDir).filter((row) => row.source === "npm");
    expect(rows.map((row) => row.source_id)).toEqual(["@scope/a"]);
    expect(rows[0]?.fetched_at?.startsWith("2026-11-21")).toBe(true);
    expect(rows[0]?.carried_forward).toBe(false);
    expect(rows.some((row) => row.fetched_at?.startsWith("2026-11-22"))).toBe(false);
    expect(loadCheckpoint(dataDir, "npm")?.dueKeys).toContain("@scope/b");
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toMatch(/hit the UTC midnight stop/);
  });
});

/** The 400ms pacer shipped in #36: one +200ms widen, capped at 600ms, 30s on a headerless 429. */
function createLegacyPacer(options: { sleep: SleepFn; now: () => number }): NpmScopedPacer {
  const intervalFloor = 400;
  let intervalMs = intervalFloor;
  let lastStart = Number.NEGATIVE_INFINITY;
  let holdUntil = 0;
  let widened = false;
  let streak = 0;
  const now = options.now;
  return {
    async beforeRequest() {
      const t = now();
      const wait = Math.max(0, holdUntil - t, intervalMs - (t - lastStart));
      if (wait > 0) {
        await options.sleep(wait);
      }
      lastStart = now();
    },
    onRateLimit(input: ScopedRateLimitInput) {
      const wait = input.retryAfterMs && input.retryAfterMs > 0 ? input.retryAfterMs : 30_000;
      holdUntil = Math.max(holdUntil, now() + wait);
      if (!widened) {
        intervalMs = Math.min(intervalFloor + 200, intervalMs + 200);
        widened = true;
      }
      streak = 0;
      return wait;
    },
    onSuccess() {
      streak += 1;
      if (streak >= 50 && intervalMs > intervalFloor) {
        intervalMs = Math.max(intervalFloor, intervalMs - 200);
        streak = 0;
      }
    },
    get intervalMs() {
      return intervalMs;
    },
    get floorMs() {
      return intervalFloor;
    },
  };
}

function createTokenBucket(options: { capacity: number; refillPerSec: number; now: () => number }) {
  let tokens = options.capacity;
  let updated = options.now();
  return {
    take(): boolean {
      const t = options.now();
      tokens = Math.min(options.capacity, tokens + ((t - updated) / 1000) * options.refillPerSec);
      updated = t;
      if (tokens < 1) {
        return false;
      }
      tokens -= 1;
      return true;
    },
  };
}

async function drainScoped(options: {
  pacer: NpmScopedPacer;
  now: () => number;
  sleep: SleepFn;
  sleeps: number[];
  packages: number;
  budgetMs: number;
}): Promise<{ done: number; stalls: number }> {
  const bucket = createTokenBucket({ capacity: 42, refillPerSec: 0.56, now: options.now });
  let done = 0;
  let stalls = 0;
  while (done < options.packages && options.now() < options.budgetMs) {
    await options.pacer.beforeRequest();
    if (options.now() >= options.budgetMs) {
      break;
    }
    if (bucket.take()) {
      options.pacer.onSuccess();
      done += 1;
      continue;
    }
    const wait = options.pacer.onRateLimit({ attempt: 0, cloudflare: true });
    stalls += wait >= 30_000 ? 1 : 0;
    await options.sleep(wait);
  }
  return { done, stalls };
}

describe("npm limiter simulation", () => {
  it("stalls the old pacer inside 100 minutes and finishes 10.6k scoped on the new pacer without 30s sleeps", async () => {
    const packages = NPM_SCOPED_MEASURED_FRESH_PACKAGES;
    const legacyClock = clock();
    const legacy = await drainScoped({
      pacer: createLegacyPacer(legacyClock),
      now: legacyClock.now,
      sleep: legacyClock.sleep,
      sleeps: legacyClock.sleeps,
      packages,
      budgetMs: 100 * 60 * 1000,
    });
    expect(legacy.done).toBeLessThan(packages);
    expect(legacy.stalls).toBeGreaterThan(50);
    expect(legacyClock.sleeps.filter((ms) => ms >= 30_000).length).toBeGreaterThan(50);

    const paced = clock();
    const finished = await drainScoped({
      pacer: createNpmScopedPacer({ sleep: paced.sleep, now: paced.now }),
      now: paced.now,
      sleep: paced.sleep,
      sleeps: paced.sleeps,
      packages,
      budgetMs: NPM_COLLECT_BUDGET_MS,
    });
    expect(finished.done).toBe(packages);
    expect(finished.stalls).toBe(0);
    expect(paced.sleeps.filter((ms) => ms >= 30_000)).toEqual([]);
    expect(paced.now()).toBeLessThan(NPM_COLLECT_BUDGET_MS);
    expect(paced.now() / 60_000).toBeCloseTo(318, 0);
  });
});
