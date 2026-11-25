import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collect, type CollectOutcome } from "../src/commands/collect.ts";
import {
  COLLECT_TRIGGERS,
  collectRunPlan,
  enqueueCollectRun,
  type CollectQueueState,
  type CollectTrigger,
} from "../src/lib/collect-queue.ts";
import { createHttpClient, type FetchImpl } from "../src/lib/http.ts";
import { readManifest, readSourceRows, writeNormalized } from "../src/lib/io.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { CHAINED_COLLECT_SOURCES, type NpmChainRequest } from "../src/lib/npm-chain.ts";
import { loadCheckpoint, persistEntityCache, persistLastFetched } from "../src/lib/rolling.ts";
import { emptySourceRow, type SnapshotManifest } from "../src/lib/schema.ts";
import { coreClean } from "../src/lib/window-guard.ts";

const silent = { info() {}, warn() {}, error() {} };
const workflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../.github/workflows/collect.yml"),
  "utf8",
);

function point(name: string): Response {
  return new Response(JSON.stringify({ downloads: 4, package: name }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function githubBody(raw: string): Response {
  let query = raw;
  try {
    const parsed = JSON.parse(raw) as { query?: string };
    if (parsed.query) {
      query = parsed.query;
    }
  } catch {
    // The body is already the query string.
  }
  const data: Record<string, unknown> = {
    rateLimit: { remaining: 5000, resetAt: "2026-11-23T18:00:00Z", cost: 1 },
  };
  for (const match of query.matchAll(/r(\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)) {
    const owner = match[2] ?? "";
    const repo = match[3] ?? "";
    data[`r${match[1]}`] = {
      nameWithOwner: `${owner}/${repo}`,
      url: `https://github.com/${owner}/${repo}`,
      stargazerCount: 9,
      forkCount: 1,
      pushedAt: "2026-11-01T00:00:00Z",
      issues: { totalCount: 0 },
    };
  }
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}

function freshDir(label: string): { dataDir: string; summaryPath: string } {
  const dataDir = mkdtempSync(join(tmpdir(), `radar-chain-${label}-`));
  const summaryPath = join(dataDir, "summary.md");
  writeFileSync(summaryPath, "");
  return { dataDir, summaryPath };
}

function seedNpm(dataDir: string, names: string[]): void {
  const last: Record<string, string> = {};
  const cache: Record<string, unknown> = {};
  for (const name of names) {
    last[name] = "2026-11-22T01:00:00.000Z";
    cache[name] = { downloads: 1, package: name };
  }
  persistLastFetched(dataDir, "npm", last);
  persistEntityCache(dataDir, "npm", cache);
}

async function runCollect(input: {
  label: string;
  now: Date;
  sources: Array<"mcp-registry" | "github" | "gemini-cli">;
  budgetMs?: string;
  chain?: string;
  wallNow?: () => Date;
  monotonicNow?: () => number;
  fetchImpl: FetchImpl;
  dispatch?: (request: NpmChainRequest) => void;
  date?: string;
}): Promise<{ outcome: CollectOutcome; summary: string; dataDir: string }> {
  const date = input.date ?? input.now.toISOString().slice(0, 10);
  const { dataDir, summaryPath } = freshDir(input.label);
  const env: NodeJS.ProcessEnv = {
    GITHUB_STEP_SUMMARY: summaryPath,
    GH_STATS_TOKEN: "stats-token",
    RADAR_NPM_SCOPED_CONCURRENCY: "1",
  };
  if (input.budgetMs) {
    env.RADAR_NPM_BUDGET_MS = input.budgetMs;
  }
  if (input.chain) {
    env.RADAR_COLLECT_CHAIN = input.chain;
  }
  const outcome = await collect({
    date,
    dataDir,
    now: input.now,
    wallNow: input.wallNow,
    sources: input.sources,
    ifIncomplete: true,
    recoverNpm: true,
    monotonicNow: input.monotonicNow,
    env,
    http: createHttpClient({ fetchImpl: input.fetchImpl, maxRetries: 0, sleep: async () => {} }),
    log: silent,
    sourceAttempts: 1,
    sleep: async () => {},
    dispatchCollect: input.dispatch,
  });
  return { outcome, summary: readFileSync(summaryPath, "utf8"), dataDir };
}

/** One scoped fetch moves the budget clock by two minutes, so a 60s budget stops after the first package. */
function budgetFetch(clock: { ms: number }, githubCalls: { count: number }): FetchImpl {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("registry.modelcontextprotocol.io")) {
      return new Response(
        JSON.stringify({
          servers: [
            {
              server: {
                name: "io.github.example/one",
                version: "1.0.0",
                repository: { url: "https://github.com/example/one", source: "github" },
                packages: [{ registryType: "npm", identifier: "@scope/one" }],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("api.github.com/graphql")) {
      githubCalls.count += 1;
      return githubBody(String(init?.body ?? ""));
    }
    if (url.includes("geminicli.com")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("api.npmjs.org")) {
      clock.ms += 120_000;
      return point(decodeURIComponent(url.split("/").pop() ?? ""));
    }
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("npm budget chain", () => {
  it("a run that hits its budget dispatches a full --if-incomplete --recover-npm collect", async () => {
    const clock = { ms: Date.parse("2026-11-23T12:00:00.000Z") };
    const dispatched: NpmChainRequest[] = [];
    const { dataDir, summaryPath } = freshDir("dispatch");
    seedNpm(dataDir, ["@scope/one", "@scope/two"]);
    const outcome = await collect({
      date: "2026-11-23",
      dataDir,
      now: new Date("2026-11-23T12:00:00.000Z"),
      sources: ["gemini-cli"],
      ifIncomplete: true,
      recoverNpm: true,
      monotonicNow: () => clock.ms,
      env: {
        GITHUB_STEP_SUMMARY: summaryPath,
        RADAR_NPM_BUDGET_MS: "60000",
        RADAR_NPM_SCOPED_CONCURRENCY: "1",
      },
      http: createHttpClient({
        fetchImpl: budgetFetch(clock, { count: 0 }),
        maxRetries: 0,
        sleep: async () => {},
      }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
      dispatchCollect: (request) => {
        dispatched.push(request);
      },
    });
    expect(outcome.wrote).toBe(true);
    expect(outcome.manifest?.sources.find((source) => source.source === "npm")?.truncated).toBe(true);
    expect(outcome.manifest?.sources.find((source) => source.source === "npm")?.fetchedThisRunCount).toBeGreaterThan(0);
    expect(dispatched).toEqual([
      {
        ifIncomplete: true,
        recoverNpm: true,
        chain: 1,
        sources: [...CHAINED_COLLECT_SOURCES],
      },
    ]);
    expect(dispatched[0]?.sources).not.toEqual(["npm"]);
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toMatch(/Decision: dispatch/);
    expect(summary).toMatch(/Reason: npm hit the wall-clock budget/);
    expect(summary).toMatch(/collect --if-incomplete --recover-npm \(chain 1 of 3\)/);
    expect(workflow).toContain("gh workflow run collect.yml");
    expect(workflow).toContain("-f if_incomplete=true");
    expect(workflow).toContain("--if-incomplete");
    expect(workflow).toContain("--recover-npm");
    expect(workflow).toContain("actions: write");
    expect(workflow).not.toContain("--sources npm");
  });

  it("no dispatch at or after 23:00 UTC, on a midnight stop, when the day is complete, after a no-progress run, or past the chain cap", async () => {
    const dispatched: NpmChainRequest[] = [];
    const remember = (request: NpmChainRequest) => {
      dispatched.push(request);
    };

    const lateClock = { ms: Date.parse("2026-11-23T23:00:00.000Z") };
    const lateDir = freshDir("late");
    seedNpm(lateDir.dataDir, ["@scope/one", "@scope/two"]);
    const late = await collect({
      date: "2026-11-23",
      dataDir: lateDir.dataDir,
      now: new Date("2026-11-23T23:00:00.000Z"),
      sources: ["gemini-cli"],
      ifIncomplete: true,
      recoverNpm: true,
      monotonicNow: () => lateClock.ms,
      env: {
        GITHUB_STEP_SUMMARY: lateDir.summaryPath,
        RADAR_NPM_BUDGET_MS: "60000",
        RADAR_NPM_SCOPED_CONCURRENCY: "1",
      },
      http: createHttpClient({
        fetchImpl: budgetFetch(lateClock, { count: 0 }),
        maxRetries: 0,
        sleep: async () => {},
      }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
      dispatchCollect: remember,
    });
    expect(late.manifest?.sources.find((source) => source.source === "npm")?.truncated).toBe(true);
    expect(readFileSync(lateDir.summaryPath, "utf8")).toMatch(/at or after 23:00 UTC/);

    const date = "2026-11-23";
    const midnightDir = freshDir("midnight-stop");
    persistLastFetched(midnightDir.dataDir, "npm", {
      "@scope/a": "2026-11-22T01:00:00.000Z",
      "@scope/b": "2026-11-22T01:00:00.000Z",
    });
    let wall = new Date(`${date}T23:40:00.000Z`);
    let npmCalls = 0;
    await collect({
      date,
      dataDir: midnightDir.dataDir,
      now: new Date(`${date}T23:40:00.000Z`),
      wallNow: () => wall,
      sources: ["gemini-cli"],
      ifIncomplete: true,
      recoverNpm: true,
      env: { GITHUB_STEP_SUMMARY: midnightDir.summaryPath, RADAR_NPM_SCOPED_CONCURRENCY: "1" },
      http: createHttpClient({
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("geminicli.com")) {
            return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
          }
          npmCalls += 1;
          if (npmCalls >= 2) {
            wall = new Date("2026-11-24T00:00:01.000Z");
          }
          return point(decodeURIComponent(url.split("/").pop() ?? ""));
        },
        maxRetries: 0,
        sleep: async () => {},
      }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
      dispatchCollect: remember,
    });
    expect(readFileSync(midnightDir.summaryPath, "utf8")).toMatch(/hit the UTC midnight stop/);

    const completeDir = freshDir("complete");
    const manifest = coreCompleteManifest(date);
    const row = emptySourceRow({
      snapshot_date: date,
      app_id: "npm:@scope/kept",
      source: "npm",
      source_id: "@scope/kept",
      name: "@scope/kept",
      npm_package: "@scope/kept",
      npm_weekly_downloads: 4,
      fetched_at: `${date}T02:00:00.000Z`,
      carried_forward: false,
    });
    writeNormalized(date, [row], mergeApps(date, [row]), manifest, completeDir.dataDir);
    let fetches = 0;
    const complete = await collect({
      date,
      dataDir: completeDir.dataDir,
      now: new Date(`${date}T12:00:00.000Z`),
      ifIncomplete: true,
      recoverNpm: true,
      env: { GITHUB_STEP_SUMMARY: completeDir.summaryPath },
      http: createHttpClient({
        fetchImpl: async () => {
          fetches += 1;
          throw new Error("complete day must not fetch");
        },
        maxRetries: 0,
      }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
      dispatchCollect: remember,
    });
    expect(complete.skipped).toBe(true);
    expect(complete.wrote).toBe(false);
    expect(fetches).toBe(0);
    expect(readFileSync(completeDir.summaryPath, "utf8")).toMatch(/day is complete/);

    const idleDir = freshDir("idle");
    seedNpm(idleDir.dataDir, ["@scope/one", "@scope/two"]);
    let ticks = 0;
    const idle = await collect({
      date,
      dataDir: idleDir.dataDir,
      now: new Date(`${date}T12:00:00.000Z`),
      sources: ["gemini-cli"],
      ifIncomplete: true,
      recoverNpm: true,
      monotonicNow: () => {
        ticks += 1;
        return ticks * 1_000;
      },
      env: {
        GITHUB_STEP_SUMMARY: idleDir.summaryPath,
        RADAR_NPM_BUDGET_MS: "1",
        RADAR_NPM_SCOPED_CONCURRENCY: "1",
      },
      http: createHttpClient({
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("api.npmjs.org")) {
            throw new Error("no-progress run must not fetch npm");
          }
          return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
        },
        maxRetries: 0,
        sleep: async () => {},
      }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
      dispatchCollect: remember,
    });
    expect(idle.manifest?.sources.find((source) => source.source === "npm")?.fetchedThisRunCount ?? 0).toBe(0);
    expect(readFileSync(idleDir.summaryPath, "utf8")).toMatch(/no npm progress/);

    const cappedClock = { ms: Date.parse(`${date}T12:00:00.000Z`) };
    const cappedDir = freshDir("capped");
    seedNpm(cappedDir.dataDir, ["@scope/one", "@scope/two"]);
    const capped = await collect({
      date,
      dataDir: cappedDir.dataDir,
      now: new Date(`${date}T12:00:00.000Z`),
      sources: ["gemini-cli"],
      ifIncomplete: true,
      recoverNpm: true,
      monotonicNow: () => cappedClock.ms,
      env: {
        GITHUB_STEP_SUMMARY: cappedDir.summaryPath,
        RADAR_NPM_BUDGET_MS: "60000",
        RADAR_NPM_SCOPED_CONCURRENCY: "1",
        RADAR_COLLECT_CHAIN: "3",
      },
      http: createHttpClient({
        fetchImpl: budgetFetch(cappedClock, { count: 0 }),
        maxRetries: 0,
        sleep: async () => {},
      }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
      dispatchCollect: remember,
    });
    expect(capped.manifest?.sources.find((source) => source.source === "npm")?.fetchedThisRunCount).toBeGreaterThan(0);
    expect(readFileSync(cappedDir.summaryPath, "utf8")).toMatch(/chain cap of 3 chained runs in this UTC day/);
    expect(dispatched).toEqual([]);
  });

  it("a chained dispatch that replaces a pending primary or backup still completes core and npm", async () => {
    let state: CollectQueueState = { active: null, pending: null };
    state = enqueueCollectRun(state, "00:20").state;
    state = enqueueCollectRun(state, "05:41").state;
    const replacedPrimary = enqueueCollectRun(state, "chain");
    expect(replacedPrimary.cancelled).toBe("05:41");
    expect(replacedPrimary.state.pending).toBe("chain");
    expect(collectRunPlan("chain")).toEqual({ ifIncomplete: true, recoverNpm: true, npmOnly: false });

    const replacedMorning = enqueueCollectRun({ active: "00:20", pending: "08:47" }, "chain");
    expect(replacedMorning.cancelled).toBe("08:47");
    expect(replacedMorning.state.pending).toBe("chain");
    const replacedBackstop = enqueueCollectRun({ active: "05:41", pending: "19:23" }, "chain");
    expect(replacedBackstop.cancelled).toBe("19:23");
    expect(collectRunPlan(replacedBackstop.state.pending ?? "chain").npmOnly).toBe(false);

    const githubCalls = { count: 0 };
    const clock = { ms: Date.parse("2026-11-23T03:20:00.000Z") };
    const finished = await runCollect({
      label: "chain-survives",
      now: new Date("2026-11-23T03:20:00.000Z"),
      sources: ["mcp-registry", "github"],
      monotonicNow: () => clock.ms,
      fetchImpl: budgetFetch(clock, githubCalls),
    });
    expect(finished.outcome.wrote).toBe(true);
    expect(coreClean(finished.outcome.manifest).clean).toBe(true);
    expect(coreClean(finished.outcome.manifest).reasons.filter((reason) => reason.startsWith("npm:"))).toEqual([]);
    expect(githubCalls.count).toBeGreaterThan(0);
    const rows = readSourceRows("2026-11-23", finished.dataDir);
    expect(rows.some((row) => row.source === "mcp-registry")).toBe(true);
    expect(rows.some((row) => row.source === "github")).toBe(true);
    expect(rows.some((row) => row.source === "npm" && row.carried_forward === false)).toBe(true);
    expect(loadCheckpoint(finished.dataDir, "npm")).toBeNull();
  });

  it("any surviving pending run still completes core and npm, whichever trigger it came from", async () => {
    for (const trigger of COLLECT_TRIGGERS) {
      const other: CollectTrigger = trigger === "00:20" ? "05:41" : "00:20";
      const queued = enqueueCollectRun({ active: other, pending: null }, trigger);
      expect(queued.cancelled).toBeNull();
      expect(queued.state.pending).toBe(trigger);
      expect(collectRunPlan(trigger)).toEqual({ ifIncomplete: true, recoverNpm: true, npmOnly: false });

      const githubCalls = { count: 0 };
      const clock = { ms: Date.parse("2026-11-23T06:20:00.000Z") };
      const finished = await runCollect({
        label: `survivor-${trigger.replace(":", "")}`,
        now: new Date("2026-11-23T06:20:00.000Z"),
        sources: ["mcp-registry", "github"],
        monotonicNow: () => clock.ms,
        fetchImpl: budgetFetch(clock, githubCalls),
      });
      expect(finished.outcome.wrote, trigger).toBe(true);
      expect(coreClean(finished.outcome.manifest).clean, trigger).toBe(true);
      const present = new Set(readSourceRows("2026-11-23", finished.dataDir).map((row) => row.source));
      expect(present.has("mcp-registry"), trigger).toBe(true);
      expect(present.has("github"), trigger).toBe(true);
      expect(present.has("npm"), trigger).toBe(true);
      expect(loadCheckpoint(finished.dataDir, "npm"), trigger).toBeNull();
      expect(githubCalls.count, trigger).toBeGreaterThan(0);
    }
  });

  it("a run with everything already complete fetches nothing and writes no data commit", async () => {
    const date = "2026-11-23";
    const { dataDir, summaryPath } = freshDir("already");
    const manifest = coreCompleteManifest(date);
    const collectedAt = `${date}T02:00:00.000Z`;
    const row = emptySourceRow({
      snapshot_date: date,
      app_id: "npm:@scope/kept",
      source: "npm",
      source_id: "@scope/kept",
      name: "@scope/kept",
      npm_package: "@scope/kept",
      npm_weekly_downloads: 4,
      fetched_at: collectedAt,
      carried_forward: false,
    });
    writeNormalized(date, [row], mergeApps(date, [row]), manifest, dataDir);
    const before = readFileSync(join(dataDir, "normalized", date, "manifest.json"), "utf8");
    let fetches = 0;
    const dispatched: NpmChainRequest[] = [];
    const outcome = await collect({
      date,
      dataDir,
      now: new Date(`${date}T15:20:00.000Z`),
      ifIncomplete: true,
      recoverNpm: true,
      env: { GITHUB_STEP_SUMMARY: summaryPath },
      http: createHttpClient({
        fetchImpl: async () => {
          fetches += 1;
          throw new Error("complete day must not fetch");
        },
        maxRetries: 0,
      }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
      dispatchCollect: (request) => {
        dispatched.push(request);
      },
    });
    expect(outcome.skipped).toBe(true);
    expect(outcome.wrote).toBe(false);
    expect(fetches).toBe(0);
    expect(dispatched).toEqual([]);
    expect(readFileSync(join(dataDir, "normalized", date, "manifest.json"), "utf8")).toBe(before);
    expect(readManifest(date, dataDir).partial).toBe(false);
    expect(readFileSync(summaryPath, "utf8")).toMatch(/day is complete/);
    expect(workflow).toContain("steps.collect.outputs.wrote != 'false'");
  });

  it("no post-midnight rows are written onto the earlier day", async () => {
    const date = "2026-11-23";
    const { dataDir, summaryPath } = freshDir("midnight-rows");
    persistLastFetched(dataDir, "npm", {
      "@scope/a": "2026-11-22T01:00:00.000Z",
      "@scope/b": "2026-11-22T01:00:00.000Z",
    });
    let wall = new Date(`${date}T23:40:00.000Z`);
    let npmCalls = 0;
    const dispatched: NpmChainRequest[] = [];
    const outcome = await collect({
      date,
      dataDir,
      now: new Date(`${date}T23:40:00.000Z`),
      wallNow: () => wall,
      sources: ["gemini-cli"],
      ifIncomplete: true,
      recoverNpm: true,
      env: { GITHUB_STEP_SUMMARY: summaryPath, RADAR_NPM_SCOPED_CONCURRENCY: "1" },
      http: createHttpClient({
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("geminicli.com")) {
            return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
          }
          npmCalls += 1;
          if (npmCalls >= 2) {
            wall = new Date("2026-11-24T00:00:01.000Z");
          }
          return point(decodeURIComponent(url.split("/").pop() ?? ""));
        },
        maxRetries: 0,
        sleep: async () => {},
      }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
      dispatchCollect: (request) => {
        dispatched.push(request);
      },
    });
    expect(npmCalls).toBe(2);
    expect(outcome.wrote).toBe(true);
    expect(outcome.manifest?.snapshotDate).toBe(date);
    expect(outcome.manifest?.sources.find((source) => source.source === "npm")?.truncated).toBe(true);
    const rows = readSourceRows(date, dataDir).filter((row) => row.source === "npm");
    expect(rows.map((row) => row.source_id)).toEqual(["@scope/a"]);
    expect(rows[0]?.snapshot_date).toBe(date);
    expect(rows[0]?.fetched_at?.startsWith(date)).toBe(true);
    expect(rows.some((row) => row.snapshot_date === "2026-11-24" || row.fetched_at?.startsWith("2026-11-24"))).toBe(
      false,
    );
    expect(loadCheckpoint(dataDir, "npm")?.snapshotDate).toBe(date);
    expect(loadCheckpoint(dataDir, "npm")?.dueKeys).toContain("@scope/b");
    expect(dispatched).toEqual([]);
    expect(readFileSync(summaryPath, "utf8")).toMatch(/hit the UTC midnight stop/);
  });
});

function coreCompleteManifest(date: string): SnapshotManifest {
  const collectedAt = `${date}T02:00:00.000Z`;
  return {
    snapshotDate: date,
    collectedAt,
    appCount: 1,
    sourceRowCount: 1,
    partial: false,
    sources: [
      {
        source: "mcp-registry",
        rowCount: 1,
        skipped: false,
        failed: false,
        truncated: false,
        collectedAt,
        existingRows: 1,
        refetchedExisting: 1,
        refetchedExistingShare: 1,
      },
      {
        source: "github",
        rowCount: 1,
        skipped: false,
        failed: false,
        truncated: false,
        collectedAt,
        existingRows: 1,
        refetchedExisting: 1,
        refetchedExistingShare: 1,
        mismatchChangedNotFresh: 0,
      },
      {
        source: "npm",
        rowCount: 1,
        skipped: false,
        failed: false,
        truncated: false,
        collectedAt,
        existingRows: 1,
        refetchedExisting: 1,
        refetchedExistingShare: 1,
        mismatchChangedNotFresh: 0,
      },
      { source: "smithery", rowCount: 1, skipped: false, failed: false, truncated: false, collectedAt },
      { source: "gemini-cli", rowCount: 1, skipped: false, failed: false, truncated: false, collectedAt },
      { source: "pypi", rowCount: 1, skipped: false, failed: false, truncated: false, collectedAt },
    ],
  };
}
