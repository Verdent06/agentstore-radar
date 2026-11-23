import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collect } from "../src/commands/collect.ts";
import { enqueueCollectRun, type CollectQueueState } from "../src/lib/collect-queue.ts";
import { createHttpClient, type FetchImpl } from "../src/lib/http.ts";
import { readManifest, readSourceRows, writeNormalized } from "../src/lib/io.ts";
import { mergeApps } from "../src/lib/merge.ts";
import {
  COLLECT_JOB_TIMEOUT_MS,
  COLLECT_STEP_TIMEOUT_MS,
  NPM_RECOVERY_MARGIN_MS,
  decideNpmRecovery,
  npmRecoveryBudgetMs,
} from "../src/lib/npm-recovery.ts";
import { loadCheckpoint, persistCheckpoint, persistEntityCache, persistLastFetched } from "../src/lib/rolling.ts";
import { emptySourceRow, type SnapshotManifest } from "../src/lib/schema.ts";

const silent = { info() {}, warn() {}, error() {} };

function point(name: string): Response {
  return new Response(JSON.stringify({ downloads: 4, package: name }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("npm recovery budget", () => {
  it("keeps the safety margin inside the job timeout and before midnight", () => {
    expect(NPM_RECOVERY_MARGIN_MS).toBeLessThanOrEqual(COLLECT_JOB_TIMEOUT_MS - COLLECT_STEP_TIMEOUT_MS);
    const nowMs = Date.parse("2026-11-23T20:00:00.000Z");
    const midnightMs = Date.parse("2026-11-24T00:00:00.000Z");
    const jobDeadlineMs = nowMs + 4 * 60 * 60 * 1000;
    const budgetMs = npmRecoveryBudgetMs({
      nowMs,
      midnightMs,
      jobDeadlineMs,
      configuredBudgetMs: 330 * 60 * 1000,
      marginMs: NPM_RECOVERY_MARGIN_MS,
    });
    expect(budgetMs + NPM_RECOVERY_MARGIN_MS).toBeLessThanOrEqual(midnightMs - nowMs);
    expect(budgetMs + NPM_RECOVERY_MARGIN_MS).toBeLessThanOrEqual(jobDeadlineMs - nowMs);
    expect(budgetMs).toBe(midnightMs - nowMs - NPM_RECOVERY_MARGIN_MS);
    expect(
      decideNpmRecovery({
        manifest: null,
        nowMs: midnightMs - 10 * 60 * 1000,
        midnightMs,
        marginMs: NPM_RECOVERY_MARGIN_MS,
        configuredBudgetMs: 330 * 60 * 1000,
      }).run,
    ).toBe(false);
  });
});

describe("collect concurrency", () => {
  it("cancels a pending npm run when the next collect queues, and that collect recovers npm", async () => {
    let state: CollectQueueState = { active: null, pending: null };
    state = enqueueCollectRun(state, "collect").state;
    const waiting = enqueueCollectRun(state, "npm");
    expect(waiting.cancelled).toBeNull();
    expect(waiting.state.pending).toBe("npm");
    const replaced = enqueueCollectRun(waiting.state, "collect");
    expect(replaced.cancelled).toBe("npm");
    expect(replaced.state.active).toBe("collect");
    expect(replaced.state.pending).toBe("collect");

    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-cancelled-"));
    const date = "2026-11-23";
    const summaryPath = join(dataDir, "summary.md");
    writeFileSync(summaryPath, "");
    persistLastFetched(dataDir, "npm", {
      "@scope/done": `${date}T01:00:00.000Z`,
      "@scope/left": "2026-11-22T01:00:00.000Z",
    });
    persistEntityCache(dataDir, "npm", {
      "@scope/done": { downloads: 2, package: "@scope/done" },
    });
    persistCheckpoint(dataDir, "npm", {
      snapshotDate: date,
      dueKeys: ["@scope/left"],
      nextIndex: 0,
      startedAt: `${date}T01:00:00.000Z`,
    });
    const requested: string[] = [];
    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("geminicli.com")) {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      const name = decodeURIComponent(url.split("/").pop() ?? "");
      requested.push(name);
      return point(name);
    };
    const outcome = await collect({
      date,
      dataDir,
      sources: ["gemini-cli"],
      recoverNpm: true,
      now: new Date(`${date}T12:00:00.000Z`),
      env: { GITHUB_STEP_SUMMARY: summaryPath, RADAR_NPM_SCOPED_CONCURRENCY: "1" },
      http: createHttpClient({ fetchImpl, maxRetries: 0, sleep: async () => {} }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(outcome.wrote).toBe(true);
    expect(requested).toEqual(["@scope/left"]);
    const rows = readSourceRows(date, dataDir).filter((row) => row.source === "npm");
    expect(rows.map((row) => row.source_id).sort()).toEqual(["@scope/done", "@scope/left"]);
    expect(rows.find((row) => row.source_id === "@scope/left")?.carried_forward).toBe(false);
    expect(readManifest(date, dataDir).sources.some((source) => source.source === "npm")).toBe(true);
    expect(readFileSync(summaryPath, "utf8")).toMatch(/Producer: collect recovery/);
    expect(loadCheckpoint(dataDir, "npm")).toBeNull();
  });
});

describe("backup npm recovery", () => {
  it("produces npm rows and a manifest when the 00:20 npm run never happens", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-backup-only-"));
    const date = "2026-11-23";
    const summaryPath = join(dataDir, "summary.md");
    writeFileSync(summaryPath, "");
    persistLastFetched(dataDir, "npm", { "@scope/kept": "2026-11-22T01:00:00.000Z" });
    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("geminicli.com")) {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      return point("@scope/kept");
    };
    const outcome = await collect({
      date,
      dataDir,
      sources: ["gemini-cli"],
      recoverNpm: true,
      now: new Date(`${date}T08:47:00.000Z`),
      env: { GITHUB_STEP_SUMMARY: summaryPath, RADAR_NPM_SCOPED_CONCURRENCY: "1" },
      http: createHttpClient({ fetchImpl, maxRetries: 0, sleep: async () => {} }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(outcome.wrote).toBe(true);
    expect(outcome.manifest?.snapshotDate).toBe(date);
    const npm = outcome.manifest?.sources.find((source) => source.source === "npm");
    expect(npm?.truncated).not.toBe(true);
    expect(npm?.rowCount).toBe(1);
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toMatch(/Producer: collect recovery/);
    expect(summary).toMatch(/Wall-clock minutes:/);
    expect(summary).toMatch(/Scoped requests per minute:/);
    expect(summary).toMatch(/429 count:/);
    expect(summary).toMatch(/Stop:/);
  });

  it("does not run npm when today's npm manifest is already complete", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-already-"));
    const date = "2026-11-23";
    const summaryPath = join(dataDir, "summary.md");
    writeFileSync(summaryPath, "");
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
    const manifest: SnapshotManifest = {
      snapshotDate: date,
      collectedAt,
      appCount: 1,
      sourceRowCount: 1,
      partial: true,
      sources: [
        {
          source: "npm",
          rowCount: 1,
          skipped: false,
          truncated: false,
          failed: false,
          collectedAt,
        },
      ],
    };
    writeNormalized(date, [row], mergeApps(date, [row]), manifest, dataDir);
    let npmCalls = 0;
    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("api.npmjs.org")) {
        npmCalls += 1;
      }
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    };
    const outcome = await collect({
      date,
      dataDir,
      sources: ["gemini-cli"],
      recoverNpm: true,
      now: new Date(`${date}T19:23:00.000Z`),
      env: { GITHUB_STEP_SUMMARY: summaryPath },
      http: createHttpClient({ fetchImpl, maxRetries: 0, sleep: async () => {} }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(npmCalls).toBe(0);
    expect(outcome.wrote).toBe(false);
    expect(readManifest(date, dataDir).sources.find((source) => source.source === "npm")?.truncated).toBe(false);
    expect(readFileSync(summaryPath, "utf8")).toMatch(/already complete and untruncated/);
  });

  it("stops a backup npm lane at UTC midnight and does not write post-midnight rows onto the earlier day", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-backup-midnight-"));
    const date = "2026-11-23";
    const summaryPath = join(dataDir, "summary.md");
    writeFileSync(summaryPath, "");
    persistLastFetched(dataDir, "npm", {
      "@scope/a": "2026-11-22T01:00:00.000Z",
      "@scope/b": "2026-11-22T01:00:00.000Z",
    });
    let wall = new Date(`${date}T23:40:00.000Z`);
    let npmCalls = 0;
    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("geminicli.com")) {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      npmCalls += 1;
      const name = decodeURIComponent(url.split("/").pop() ?? "");
      if (npmCalls >= 2) {
        wall = new Date("2026-11-24T00:00:01.000Z");
      }
      return point(name);
    };
    const outcome = await collect({
      date,
      dataDir,
      sources: ["gemini-cli"],
      recoverNpm: true,
      now: new Date(`${date}T23:40:00.000Z`),
      wallNow: () => wall,
      env: { GITHUB_STEP_SUMMARY: summaryPath, RADAR_NPM_SCOPED_CONCURRENCY: "1" },
      http: createHttpClient({ fetchImpl, maxRetries: 0, sleep: async () => {} }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(npmCalls).toBe(2);
    expect(outcome.wrote).toBe(true);
    expect(outcome.manifest?.sources.find((source) => source.source === "npm")?.truncated).toBe(true);
    const rows = readSourceRows(date, dataDir).filter((row) => row.source === "npm");
    expect(rows.map((row) => row.source_id)).toEqual(["@scope/a"]);
    expect(rows[0]?.fetched_at?.startsWith(date)).toBe(true);
    expect(rows.some((row) => row.fetched_at?.startsWith("2026-11-24"))).toBe(false);
    expect(loadCheckpoint(dataDir, "npm")?.dueKeys).toContain("@scope/b");
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toMatch(/Producer: collect recovery/);
    expect(summary).toMatch(/hit the UTC midnight stop/);
  });
});
