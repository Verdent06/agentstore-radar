import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { adapters } from "../src/adapters/index.ts";
import { npmAdapter } from "../src/adapters/npm.ts";
import { smitheryAdapter } from "../src/adapters/smithery.ts";
import type { SourceAdapter, SourceResult } from "../src/adapters/types.ts";
import { collect, collectAdapter } from "../src/commands/collect.ts";
import type { SourceBudget } from "../src/lib/budget.ts";
import { freshRowCount } from "../src/lib/coverage.ts";
import { createHttpClient } from "../src/lib/http.ts";
import {
  cleanupBrokenNormalizedEntries,
  inspectSnapshot,
  listSnapshotDates,
  readManifest,
  readSourceRows,
  writeNormalized,
} from "../src/lib/io.ts";
import { createLogger } from "../src/lib/logger.ts";
import { mergeApps } from "../src/lib/merge.ts";
import type { NpmChainRequest } from "../src/lib/npm-chain.ts";
import {
  SOURCE_NAMES,
  emptySourceRow,
  type SnapshotManifest,
  type SourceManifest,
  type SourceName,
  type SourceRow,
} from "../src/lib/schema.ts";
import { fixtureFetch, loadFixture } from "./helpers.ts";

vi.mock("../src/lib/io.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/io.ts")>();
  return {
    ...actual,
    writeNormalized: vi.fn((...args: Parameters<typeof actual.writeNormalized>) => actual.writeNormalized(...args)),
  };
});

const silent = createLogger({
  log() {},
  warn() {},
  error() {},
});

const catalogs = [
  { match: "api.smithery.ai/servers", body: loadFixture("smithery-page.json") },
  { match: "geminicli.com/extensions.json", body: loadFixture("gemini.json") },
  {
    match: "api.npmjs.org/downloads/point/last-week/@example%2Fweather-mcp",
    body: loadFixture<Record<string, unknown>>("npm-point.json")["@example/weather-mcp"],
  },
  { match: "pypistats.org/api/packages/example-files-mcp/recent", body: loadFixture("pypi-recent.json") },
];

describe("collect resilience", () => {
  it("writes other sources when mcp-registry fails after retries", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-partial-"));
    let mcpCalls = 0;
    const catalogFetch = fixtureFetch(catalogs);
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("registry.modelcontextprotocol.io")) {
        mcpCalls += 1;
        return new Response(JSON.stringify({ title: "Internal Server Error", status: 500, detail: "Failed to get registry list" }), {
          status: 500,
        });
      }
      return catalogFetch(input, init);
    };
    const outcome = await collect({
      date: "2026-10-17",
      dataDir,
      now: new Date("2026-10-17T12:00:00Z"),
      env: {},
      http: createHttpClient({ fetchImpl, maxRetries: 0 }),
      log: silent,
      sourceAttempts: 3,
      sleep: async () => {},
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.wrote).toBe(true);
    expect(mcpCalls).toBe(3);
    expect(outcome.failedSources).toEqual(["mcp-registry"]);
    expect(outcome.manifest?.partial).toBe(true);
    expect(outcome.manifest?.completedSources).not.toContain("mcp-registry");
    expect(outcome.manifest?.completedSources).toEqual(expect.arrayContaining(["smithery", "gemini-cli"]));
    const mcp = outcome.manifest?.sources.find((source) => source.source === "mcp-registry");
    expect(mcp?.failed).toBe(true);
    expect(mcp?.skipped).toBe(true);
    expect(mcp?.stoppedAt).toMatchObject({ source: "mcp-registry", page: 1 });
    expect(mcp?.stoppedAt?.error).toMatch(/500|Failed to get registry list/i);
    expect(outcome.manifest?.sources.find((source) => source.source === "smithery")?.rowCount).toBe(1);
    expect(outcome.manifest?.sources.find((source) => source.source === "gemini-cli")?.rowCount).toBe(1);
    expect(inspectSnapshot("2026-10-17", dataDir).usable).toBe(true);
    expect(readSourceRows("2026-10-17", dataDir).some((row) => row.source === "smithery")).toBe(true);
  });

  it("retries a source that fails once then succeeds", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-retry-"));
    let mcpCalls = 0;
    const catalogFetch = fixtureFetch([
      { match: /registry.modelcontextprotocol.io\/v0.1\/servers\?limit=100&version=latest$/, body: loadFixture("mcp-page-2.json") },
      ...catalogs,
    ]);
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("registry.modelcontextprotocol.io")) {
        mcpCalls += 1;
        if (mcpCalls === 1) {
          return new Response("Failed to get registry list", { status: 500 });
        }
      }
      return catalogFetch(input, init);
    };
    const outcome = await collect({
      date: "2026-10-18",
      dataDir,
      now: new Date("2026-10-18T12:00:00Z"),
      env: {},
      http: createHttpClient({ fetchImpl, maxRetries: 0 }),
      log: silent,
      sourceAttempts: 3,
      sleep: async () => {},
    });
    expect(outcome.ok).toBe(true);
    expect(mcpCalls).toBe(2);
    expect(outcome.failedSources).toEqual([]);
    expect(outcome.manifest?.sources.find((source) => source.source === "mcp-registry")?.failed).toBeFalsy();
  });

  it("does not write a snapshot when every source fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-none-"));
    const fetchImpl = async () => new Response("down", { status: 500 });
    const outcome = await collect({
      date: "2026-10-23",
      dataDir,
      now: new Date("2026-10-23T12:00:00Z"),
      env: {},
      http: createHttpClient({ fetchImpl, maxRetries: 0 }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.wrote).toBe(false);
    expect(inspectSnapshot("2026-10-23", dataDir).usable).toBe(false);
  });

  it("refuses to overwrite a complete snapshot unless --force", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-no-overwrite-"));
    const manifest: SnapshotManifest = {
      snapshotDate: "2026-10-24",
      collectedAt: "2026-10-24T11:07:24.740Z",
      appCount: 1,
      sourceRowCount: 1,
      partial: false,
      completedSources: [...SOURCE_NAMES],
      sources: SOURCE_NAMES.map((source) => ({
        source,
        rowCount: source === "gemini-cli" ? 1 : 0,
        skipped: false,
        collectedAt: "2026-10-24T11:07:24.740Z",
      })),
    };
    const rows = [
      emptySourceRow({
        snapshot_date: "2026-10-24",
        app_id: "github:x/y",
        source: "gemini-cli",
        source_id: "x",
        name: "x",
        stars: 1,
        fetched_at: "2026-10-24T11:07:24.740Z",
        carried_forward: false,
      }),
    ];
    writeNormalized("2026-10-24", rows, mergeApps("2026-10-24", rows), manifest, dataDir);
    let calls = 0;
    const skipped = await collect({
      date: "2026-10-24",
      dataDir,
      now: new Date("2026-10-24T19:48:02Z"),
      http: createHttpClient({
        fetchImpl: async () => {
          calls += 1;
          throw new Error("should not fetch");
        },
        maxRetries: 0,
      }),
      log: silent,
    });
    expect(skipped.skipped).toBe(true);
    expect(skipped.wrote).toBe(false);
    expect(skipped.skipReason).toMatch(/already complete.*--force/);
    expect(calls).toBe(0);
    expect(readManifest("2026-10-24", dataDir).collectedAt).toBe("2026-10-24T11:07:24.740Z");

    const catalogFetch = fixtureFetch(catalogs);
    const forced = await collect({
      date: "2026-10-24",
      dataDir,
      now: new Date("2026-10-24T19:48:02Z"),
      force: true,
      env: {},
      http: createHttpClient({
        fetchImpl: async (input, init) => {
          calls += 1;
          if (String(input).includes("registry.modelcontextprotocol.io")) {
            return new Response("nope", { status: 500 });
          }
          return catalogFetch(input, init);
        },
        maxRetries: 0,
      }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(forced.skipped).toBe(false);
    expect(forced.wrote).toBe(true);
    expect(forced.manifest?.collectedAt).toBe("2026-10-24T19:48:02.000Z");
    expect(readManifest("2026-10-24", dataDir).collectedAt).toBe("2026-10-24T19:48:02.000Z");
    expect(calls).toBeGreaterThan(0);
  });

  it("backs up the previous complete snapshot on --force and records the overwrite", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-force-backup-"));
    const rows = [
      emptySourceRow({
        snapshot_date: "2026-10-24",
        app_id: "github:x/y",
        source: "gemini-cli",
        source_id: "x",
        name: "x",
        stars: 1,
        fetched_at: "2026-10-24T11:07:24.740Z",
        carried_forward: false,
      }),
    ];
    writeNormalized(
      "2026-10-24",
      rows,
      mergeApps("2026-10-24", rows),
      {
        snapshotDate: "2026-10-24",
        collectedAt: "2026-10-24T11:07:24.740Z",
        appCount: 1,
        sourceRowCount: 1,
        partial: false,
        completedSources: ["gemini-cli"],
        runId: "run-morning",
        sources: [
          {
            source: "gemini-cli",
            rowCount: 1,
            skipped: false,
            collectedAt: "2026-10-24T11:07:24.740Z",
          },
        ],
      },
      dataDir,
    );
    execSync("git init && git add -A && git -c user.email=test@example.com -c user.name=test commit -m previous", {
      cwd: dataDir,
      encoding: "utf8",
    });
    const previousCommit = execSync("git rev-parse HEAD", { cwd: dataDir, encoding: "utf8" }).trim();
    const newSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const catalogFetch = fixtureFetch(catalogs);
    const forced = await collect({
      date: "2026-10-24",
      dataDir,
      now: new Date("2026-10-24T19:48:02Z"),
      force: true,
      runId: "run-evening",
      env: { GITHUB_SHA: newSha },
      http: createHttpClient({
        fetchImpl: async (input, init) => {
          if (String(input).includes("registry.modelcontextprotocol.io")) {
            return new Response("nope", { status: 500 });
          }
          return catalogFetch(input, init);
        },
        maxRetries: 0,
      }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(forced.wrote).toBe(true);
    const next = readManifest("2026-10-24", dataDir);
    expect(next.runId).toBe("run-evening");
    expect(next.overwrite).toMatchObject({
      overwrittenAt: "2026-10-24T19:48:02.000Z",
      previousCollectedAt: "2026-10-24T11:07:24.740Z",
      previousRunId: "run-morning",
      previousCommit,
      runId: "run-evening",
      reason: "force overwrite of existing snapshot",
      newSha,
    });
    expect(next.overwrite?.previousCommit).toMatch(/^[0-9a-f]{7,40}$/i);
    expect(next.overwrite?.reason).toBe("force overwrite of existing snapshot");
    expect(next.overwrite?.newSha).toBe(newSha);
    const backupRel = next.overwrite?.previousBackupPath;
    expect(backupRel).toMatch(/^backups\/normalized\/2026-10-24\//);
    const backupDir = join(dataDir, backupRel!);
    expect(existsSync(join(backupDir, "manifest.json"))).toBe(true);
    const previous = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8")) as SnapshotManifest;
    expect(previous.collectedAt).toBe("2026-10-24T11:07:24.740Z");
    expect(previous.runId).toBe("run-morning");
    expect(listSnapshotDates(dataDir)).toEqual(["2026-10-24"]);
    expect(cleanupBrokenNormalizedEntries(dataDir)).toEqual([]);
    expect(existsSync(join(backupDir, "manifest.json"))).toBe(true);
  });

  it("restores the previous complete snapshot when --force writeNormalized throws", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-force-restore-"));
    const rows = Array.from({ length: 800 }, (_, index) =>
      emptySourceRow({
        snapshot_date: "2026-10-24",
        app_id: `github:example/app-${index}`,
        source: "gemini-cli",
        source_id: `app-${index}`,
        name: `app-${index}`,
        description: "x".repeat(400),
        stars: 1,
        fetched_at: "2026-10-24T11:07:24.740Z",
        carried_forward: false,
      }),
    );
    writeNormalized(
      "2026-10-24",
      rows,
      mergeApps("2026-10-24", rows),
      {
        snapshotDate: "2026-10-24",
        collectedAt: "2026-10-24T11:07:24.740Z",
        appCount: rows.length,
        sourceRowCount: rows.length,
        partial: false,
        completedSources: ["gemini-cli"],
        sources: [
          {
            source: "gemini-cli",
            rowCount: rows.length,
            skipped: false,
            collectedAt: "2026-10-24T11:07:24.740Z",
          },
        ],
      },
      dataDir,
    );
    const appsGz = join(dataDir, "normalized", "2026-10-24", "apps.ndjson.gz");
    expect(existsSync(appsGz)).toBe(true);

    const catalogFetch = fixtureFetch(catalogs);
    vi.mocked(writeNormalized).mockImplementationOnce(() => {
      throw new Error("writeNormalized failed");
    });
    await expect(
      collect({
        date: "2026-10-24",
        dataDir,
        now: new Date("2026-10-24T19:48:02Z"),
        force: true,
        env: {},
        http: createHttpClient({
          fetchImpl: async (input, init) => {
            if (String(input).includes("registry.modelcontextprotocol.io")) {
              return new Response("nope", { status: 500 });
            }
            return catalogFetch(input, init);
          },
          maxRetries: 0,
        }),
        log: silent,
        sourceAttempts: 1,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/writeNormalized failed/);

    expect(readManifest("2026-10-24", dataDir).collectedAt).toBe("2026-10-24T11:07:24.740Z");
    expect(existsSync(join(dataDir, "normalized", "2026-10-24", "manifest.json"))).toBe(true);
    expect(existsSync(appsGz)).toBe(true);
  });

  it("skips collect when --if-incomplete and today's snapshot is complete", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-skip-"));
    const manifest: SnapshotManifest = {
      snapshotDate: "2026-10-24",
      collectedAt: "2026-10-24T12:00:00Z",
      appCount: 1,
      sourceRowCount: 1,
      sources: [
        {
          source: "mcp-registry",
          rowCount: 1,
          skipped: false,
          failed: false,
          truncated: false,
          collectedAt: "2026-10-24T12:00:00Z",
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
          collectedAt: "2026-10-24T12:00:00Z",
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
          collectedAt: "2026-10-24T12:00:00Z",
          existingRows: 1,
          refetchedExisting: 1,
          refetchedExistingShare: 1,
          mismatchChangedNotFresh: 0,
        },
        {
          source: "gemini-cli",
          rowCount: 1,
          skipped: false,
          collectedAt: "2026-10-24T12:00:00Z",
        },
      ],
    };
    const rows = [
      emptySourceRow({
        snapshot_date: "2026-10-24",
        app_id: "github:x/y",
        source: "gemini-cli",
        source_id: "x",
        name: "x",
        stars: 1,
        fetched_at: "2026-10-24T12:00:00Z",
        carried_forward: false,
      }),
    ];
    writeNormalized("2026-10-24", rows, mergeApps("2026-10-24", rows), manifest, dataDir);
    let calls = 0;
    const outcome = await collect({
      date: "2026-10-24",
      dataDir,
      now: new Date("2026-10-24T18:00:00Z"),
      ifIncomplete: true,
      http: createHttpClient({
        fetchImpl: async () => {
          calls += 1;
          throw new Error("should not fetch");
        },
        maxRetries: 0,
      }),
      log: silent,
    });
    expect(outcome.skipped).toBe(true);
    expect(outcome.ok).toBe(true);
    expect(outcome.wrote).toBe(false);
    expect(calls).toBe(0);
    expect(readManifest("2026-10-24", dataDir).snapshotDate).toBe("2026-10-24");
  });

  it("re-collects when --if-incomplete sees a failed source", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-retry-snap-"));
    const manifest: SnapshotManifest = {
      snapshotDate: "2026-10-24",
      collectedAt: "2026-10-24T06:00:00Z",
      appCount: 1,
      sourceRowCount: 1,
      partial: true,
      failedSourceCount: 1,
      sources: [
        {
          source: "mcp-registry",
          rowCount: 0,
          skipped: true,
          failed: true,
          collectedAt: "2026-10-24T06:00:00Z",
        },
        {
          source: "gemini-cli",
          rowCount: 1,
          skipped: false,
          collectedAt: "2026-10-24T06:00:00Z",
        },
      ],
    };
    writeNormalized("2026-10-24", [], [], manifest, dataDir);
    const catalogFetch = fixtureFetch([
      { match: /registry.modelcontextprotocol.io/, body: loadFixture("mcp-page-2.json") },
      ...catalogs,
    ]);
    const outcome = await collect({
      date: "2026-10-24",
      dataDir,
      now: new Date("2026-10-24T18:00:00Z"),
      ifIncomplete: true,
      env: {},
      http: createHttpClient({ fetchImpl: catalogFetch, maxRetries: 0 }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(outcome.skipped).toBe(false);
    expect(outcome.wrote).toBe(true);
    expect(outcome.manifest?.sources.find((source) => source.source === "mcp-registry")?.failed).toBeFalsy();
  });

  it("removes a zero-size date placeholder before collecting", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-empty-"));
    mkdirSync(join(dataDir, "normalized"), { recursive: true });
    writeFileSync(join(dataDir, "normalized", "2026-10-19"), "");
    const catalogFetch = fixtureFetch(catalogs);
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("registry.modelcontextprotocol.io")) {
        return new Response("nope", { status: 500 });
      }
      return catalogFetch(input, init);
    };
    const outcome = await collect({
      date: "2026-10-19",
      dataDir,
      now: new Date("2026-10-19T12:00:00Z"),
      env: {},
      http: createHttpClient({ fetchImpl, maxRetries: 0 }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(outcome.cleaned).toContain("2026-10-19");
    expect(outcome.wrote).toBe(true);
    expect(inspectSnapshot("2026-10-19", dataDir).isDirectory).toBe(true);
    expect(inspectSnapshot("2026-10-19", dataDir).usable).toBe(true);
  });

  it("retries a mid-catalog MCP 500 on the same cursor and keeps earlier pages", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-mcp-cursor-"));
    const urls: string[] = [];
    let page2Calls = 0;
    const catalogFetch = fixtureFetch(catalogs);
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("registry.modelcontextprotocol.io")) {
        urls.push(url);
        if (url.includes("cursor=page-2")) {
          page2Calls += 1;
          if (page2Calls < 3) {
            return new Response(JSON.stringify({ title: "Internal Server Error", detail: "Failed to get registry list" }), {
              status: 500,
            });
          }
          return new Response(JSON.stringify(loadFixture("mcp-page-2.json")), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify(loadFixture("mcp-page.json")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return catalogFetch(input, init);
    };
    const outcome = await collect({
      date: "2026-10-17",
      dataDir,
      now: new Date("2026-10-17T12:00:00Z"),
      env: {},
      http: createHttpClient({ fetchImpl, maxRetries: 4, sleep: async () => {} }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.manifest?.partial).toBe(false);
    expect(page2Calls).toBe(3);
    expect(urls.filter((url) => !url.includes("cursor="))).toHaveLength(1);
    expect(urls.filter((url) => url.includes("cursor=page-2")).length).toBe(3);
    expect(outcome.manifest?.sources.find((source) => source.source === "mcp-registry")?.rowCount).toBe(3);
    expect(outcome.manifest?.completedSources).toContain("mcp-registry");
  });

  it("saves a partial MCP catalog with stoppedAt when the cursor page keeps returning 500", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-mcp-partial-"));
    const urls: string[] = [];
    const catalogFetch = fixtureFetch(catalogs);
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("registry.modelcontextprotocol.io")) {
        urls.push(url);
        if (url.includes("cursor=page-2")) {
          return new Response(JSON.stringify({ title: "Internal Server Error", detail: "Failed to get registry list" }), {
            status: 500,
          });
        }
        return new Response(JSON.stringify(loadFixture("mcp-page.json")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return catalogFetch(input, init);
    };
    const outcome = await collect({
      date: "2026-10-19",
      dataDir,
      now: new Date("2026-10-19T12:00:00Z"),
      env: {},
      http: createHttpClient({ fetchImpl, maxRetries: 2, sleep: async () => {} }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.wrote).toBe(true);
    expect(outcome.manifest?.partial).toBe(true);
    expect(outcome.manifest?.completedSources).not.toContain("mcp-registry");
    expect(outcome.manifest?.completedSources).toEqual(expect.arrayContaining(["smithery", "gemini-cli"]));
    const mcp = outcome.manifest?.sources.find((source) => source.source === "mcp-registry");
    expect(mcp?.truncated).toBe(true);
    expect(mcp?.failed).toBeFalsy();
    expect(mcp?.rowCount).toBe(2);
    expect(mcp?.stoppedAt).toMatchObject({
      source: "mcp-registry",
      page: 2,
      cursor: "page-2",
    });
    expect(mcp?.stoppedAt?.error).toMatch(/500|Failed to get registry list/i);
    expect(urls.filter((url) => !url.includes("cursor="))).toHaveLength(1);
    expect(urls.every((url) => !url.includes("cursor=") || url.includes("cursor=page-2"))).toBe(true);
    expect(inspectSnapshot("2026-10-19", dataDir).needsRetry).toBe(true);
    expect(readSourceRows("2026-10-19", dataDir).some((row) => row.source === "mcp-registry")).toBe(true);
    expect(readSourceRows("2026-10-19", dataDir).some((row) => row.source === "smithery")).toBe(true);
  });

  it("opens one source budget in collect.ts, does not retry after it is spent, and stays within the cap", async () => {
    const budgetMs = 5_000;
    const origin = Date.parse("2026-11-03T12:00:00.000Z");
    let now = origin;
    let calls = 0;
    let slept = false;
    const seen: SourceBudget[] = [];
    const adapter: SourceAdapter = {
      name: "npm",
      kind: "enrichment",
      async collect(ctx) {
        calls += 1;
        if (!ctx.budget) {
          throw new Error("collect.ts did not pass a budget on ctx");
        }
        seen.push(ctx.budget);
        now = ctx.budget.startedAtMs + ctx.budget.budgetMs;
        throw new Error("adapter exhausted its budget on attempt 1");
      },
    };

    const result = await collectAdapter(
      adapter,
      {
        snapshotDate: "2026-11-03",
        collectedAt: "2026-11-03T12:00:00.000Z",
        dataDir: mkdtempSync(join(tmpdir(), "radar-budget-once-")),
        now: new Date(origin),
        env: { RADAR_NPM_BUDGET_MS: String(budgetMs) },
        http: createHttpClient({ fetchImpl: async () => { throw new Error("no http"); }, maxRetries: 0 }),
        log: silent,
        discovered: { githubRepos: new Map(), npmPackages: new Set(), pypiPackages: new Set() },
        monotonicNow: () => now,
      },
      3,
      async () => {
        slept = true;
        now += budgetMs;
      },
    );

    expect(calls).toBe(1);
    expect(slept).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toBe("npm");
    expect(seen[0]?.budgetMs).toBe(budgetMs);
    expect(seen[0]?.startedAtMs).toBe(origin);
    expect(now - seen[0]!.startedAtMs).toBeLessThanOrEqual(budgetMs);
    expect(result.truncated).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.source).toBe("npm");

    calls = 0;
    slept = false;
    now = origin;
    const reused: SourceBudget[] = [];
    const retrying: SourceAdapter = {
      name: "pypi",
      kind: "enrichment",
      async collect(ctx) {
        calls += 1;
        reused.push(ctx.budget!);
        if (calls === 1) {
          now = origin + 100;
          throw new Error("transient before the budget is spent");
        }
        now = ctx.budget!.startedAtMs + ctx.budget!.budgetMs;
        throw new Error("budget spent on the retry");
      },
    };
    const retried = await collectAdapter(
      retrying,
      {
        snapshotDate: "2026-11-03",
        collectedAt: "2026-11-03T12:00:00.000Z",
        dataDir: mkdtempSync(join(tmpdir(), "radar-budget-reuse-")),
        now: new Date(origin),
        env: { RADAR_PYPI_BUDGET_MS: String(budgetMs) },
        http: createHttpClient({ fetchImpl: async () => { throw new Error("no http"); }, maxRetries: 0 }),
        log: silent,
        discovered: { githubRepos: new Map(), npmPackages: new Set(), pypiPackages: new Set() },
        monotonicNow: () => now,
      },
      3,
      async () => {
        slept = true;
        now += 50;
      },
    );
    expect(calls).toBe(2);
    expect(slept).toBe(true);
    expect(reused[0]).toBe(reused[1]);
    expect(reused[0]?.startedAtMs).toBe(origin);
    expect(reused[1]?.startedAtMs).toBe(origin);
    expect(now - origin).toBeLessThanOrEqual(budgetMs);
    expect(retried.truncated).toBe(true);
    expect(retried.failed).toBe(false);
  });

  it("keeps prior rows frozen when an adapter throws a budget error", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-budget-partial-"));
    const priorRow = emptySourceRow({
      snapshot_date: "2026-11-02",
      source: "npm",
      source_id: "@scope/kept",
      name: "@scope/kept",
      app_id: "npm:@scope/kept",
      npm_package: "@scope/kept",
      npm_weekly_downloads: 42,
      fetched_at: "2026-11-02T12:00:00.000Z",
    });
    const priorManifest: SnapshotManifest = {
      snapshotDate: "2026-11-02",
      collectedAt: "2026-11-02T12:00:00.000Z",
      appCount: 1,
      sourceRowCount: 1,
      partial: false,
      sources: [{ source: "npm", rowCount: 1, skipped: false, collectedAt: "2026-11-02T12:00:00.000Z" }],
    };
    writeNormalized("2026-11-02", [priorRow], mergeApps("2026-11-02", [priorRow]), priorManifest, dataDir);

    const original = npmAdapter.collect;
    npmAdapter.collect = async () => {
      throw new Error("npm wall-clock budget of 0m exhausted (test)");
    };
    try {
      const outcome = await collect({
        date: "2026-11-03",
        dataDir,
        sources: ["npm"],
        now: new Date("2026-11-03T12:00:00.000Z"),
        env: { RADAR_NPM_BUDGET_MS: "1000" },
        http: createHttpClient({
          fetchImpl: async () => {
            throw new Error("no http");
          },
          maxRetries: 0,
        }),
        log: silent,
        sourceAttempts: 3,
        sleep: async () => {
          throw new Error("budget throw must not be retried");
        },
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.wrote).toBe(true);
      expect(outcome.manifest?.partial).toBe(true);
      const npm = outcome.manifest?.sources.find((source) => source.source === "npm");
      expect(npm?.truncated).toBe(true);
      expect(npm?.failed).toBeFalsy();
      expect(npm?.eligibleCount).toBe(1);
      expect(npm?.fetchedShare).toBeCloseTo(0);
      const rows = readSourceRows("2026-11-03", dataDir).filter((row) => row.source === "npm");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source_id: "@scope/kept",
        npm_weekly_downloads: 42,
        carried_forward: true,
        frozen: true,
        snapshot_date: "2026-11-03",
      });
    } finally {
      npmAdapter.collect = original;
    }
  });

  it("leaves a complete manifest unchanged when a late primary runs without --force", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-late-primary-complete-"));
    const date = "2026-11-05";
    const collectedAt = "2026-11-05T08:47:00.000Z";
    const rows = [
      emptySourceRow({
        snapshot_date: date,
        app_id: "github:example/kept",
        source: "gemini-cli",
        source_id: "kept",
        name: "kept",
        stars: 4,
        fetched_at: collectedAt,
        carried_forward: false,
        frozen: false,
      }),
    ];
    const manifest: SnapshotManifest = {
      snapshotDate: date,
      collectedAt,
      appCount: 1,
      sourceRowCount: 1,
      partial: false,
      completedSources: [...SOURCE_NAMES],
      sources: SOURCE_NAMES.map((source) => ({
        source,
        rowCount: source === "gemini-cli" ? 1 : 0,
        skipped: false,
        collectedAt,
        freshTodayCount: source === "gemini-cli" ? 1 : 0,
        fetchedShare: 1,
      })),
    };
    writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
    const before = readFileSync(join(dataDir, "normalized", date, "manifest.json"), "utf8");
    let calls = 0;
    const outcome = await collect({
      date,
      dataDir,
      now: new Date("2026-11-05T13:30:00.000Z"),
      force: false,
      sources: ["gemini-cli"],
      http: createHttpClient({
        fetchImpl: async () => {
          calls += 1;
          throw new Error("late primary must not fetch a complete day");
        },
        maxRetries: 0,
      }),
      log: silent,
    });
    expect(outcome.skipped).toBe(true);
    expect(outcome.wrote).toBe(false);
    expect(outcome.skipReason).toMatch(/already complete/);
    expect(calls).toBe(0);
    expect(readFileSync(join(dataDir, "normalized", date, "manifest.json"), "utf8")).toBe(before);
    expect(readManifest(date, dataDir).collectedAt).toBe(collectedAt);
    expect(freshRowCount(readSourceRows(date, dataDir))).toBe(1);
  });

  it("re-collects a partial day but does not replace it with fewer fresh rows", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-late-primary-partial-"));
    const date = "2026-11-05";
    const collectedAt = "2026-11-05T08:47:00.000Z";
    const rows = ["a", "b", "c"].map((id) =>
      emptySourceRow({
        snapshot_date: date,
        app_id: `github:example/${id}`,
        source: "gemini-cli",
        source_id: id,
        name: id,
        stars: 4,
        repo_url: `https://github.com/example/${id}`,
        fetched_at: collectedAt,
        carried_forward: false,
        frozen: false,
      }),
    );
    const manifest: SnapshotManifest = {
      snapshotDate: date,
      collectedAt,
      appCount: rows.length,
      sourceRowCount: rows.length,
      partial: true,
      completedSources: [],
      sources: [
        {
          source: "gemini-cli",
          rowCount: rows.length,
          skipped: false,
          truncated: true,
          collectedAt,
          freshTodayCount: rows.length,
        },
      ],
    };
    writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
    const before = readFileSync(join(dataDir, "normalized", date, "manifest.json"), "utf8");
    const extension = (id: string) => ({
      id,
      url: `https://github.com/example/${id}`,
      extensionName: id,
      stars: 9,
    });
    const warnings: string[] = [];
    let calls = 0;
    const worse = await collect({
      date,
      dataDir,
      now: new Date("2026-11-05T13:30:00.000Z"),
      force: false,
      sources: ["gemini-cli"],
      http: createHttpClient({
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify([extension("only")]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
        maxRetries: 0,
      }),
      log: {
        info() {},
        warn(message) {
          warnings.push(message);
        },
        error() {},
      },
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(calls).toBe(1);
    expect(worse.skipped).toBe(false);
    expect(worse.wrote).toBe(false);
    expect(worse.skipReason).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/blocked by gemini-cli fresh 3 -> 1/);
    expect(readFileSync(join(dataDir, "normalized", date, "manifest.json"), "utf8")).toBe(before);
    expect(freshRowCount(readSourceRows(date, dataDir))).toBe(3);

    const better = await collect({
      date,
      dataDir,
      now: new Date("2026-11-05T13:40:00.000Z"),
      force: false,
      sources: ["gemini-cli"],
      http: createHttpClient({
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify(["w", "x", "y", "z"].map(extension)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
        maxRetries: 0,
      }),
      log: silent,
      sourceAttempts: 1,
      sleep: async () => {},
    });
    expect(calls).toBe(2);
    expect(better.skipped).toBe(false);
    expect(better.wrote).toBe(true);
    expect(freshRowCount(readSourceRows(date, dataDir))).toBe(4);
    expect(readManifest(date, dataDir).collectedAt).toBe("2026-11-05T13:40:00.000Z");
  });

  it("does not replace a partial day when the total rises but one source loses fresh rows", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-late-primary-mixed-"));
    const date = "2026-11-05";
    const collectedAt = "2026-11-05T08:47:00.000Z";
    const npmRows = ["n0", "n1"].map((id) =>
      emptySourceRow({
        snapshot_date: date,
        app_id: `npm:${id}`,
        source: "npm",
        source_id: id,
        name: id,
        npm_package: id,
        npm_weekly_downloads: 10,
        fetched_at: collectedAt,
        carried_forward: false,
        frozen: false,
      }),
    );
    const smitheryRow = emptySourceRow({
      snapshot_date: date,
      app_id: "smithery:held",
      source: "smithery",
      source_id: "held",
      name: "held",
      use_count: 1,
      fetched_at: "2026-11-04T00:00:00.000Z",
      carried_forward: true,
      frozen: true,
    });
    const rows = [...npmRows, smitheryRow];
    const manifest: SnapshotManifest = {
      snapshotDate: date,
      collectedAt,
      appCount: rows.length,
      sourceRowCount: rows.length,
      partial: true,
      completedSources: [],
      failedSourceCount: 1,
      sources: [
        {
          source: "npm",
          rowCount: npmRows.length,
          skipped: false,
          truncated: true,
          collectedAt,
          freshTodayCount: npmRows.length,
          fetchedShare: 0.9,
        },
        {
          source: "smithery",
          rowCount: 1,
          skipped: false,
          failed: true,
          collectedAt,
          freshTodayCount: 0,
          fetchedShare: 0,
          error: "circuit_breaker_5xx",
        },
      ],
    };
    writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
    const before = readFileSync(join(dataDir, "normalized", date, "manifest.json"), "utf8");
    const summaryPath = join(dataDir, "step-summary.md");
    writeFileSync(summaryPath, "");
    const warnings: string[] = [];
    const freshRecords = (source: SourceName, count: number, at: string): SourceRow[] =>
      Array.from({ length: count }, (_, index) =>
        emptySourceRow({
          snapshot_date: date,
          app_id: `${source}:new-${index}`,
          source,
          source_id: `new-${index}`,
          name: `new-${index}`,
          fetched_at: at,
          carried_forward: false,
          frozen: false,
        }),
      );
    const resultFor = (source: SourceName, records: SourceRow[], at: string): SourceResult => ({
      source,
      collectedAt: at,
      rowCount: records.length,
      skipped: false,
      records,
      raw: { rows: records.length },
      freshTodayCount: freshRowCount(records),
      eligibleCount: Math.max(records.length, 1),
    });
    const originalNpm = npmAdapter.collect;
    const originalSmithery = smitheryAdapter.collect;
    npmAdapter.collect = async () => resultFor("npm", [], "2026-11-05T13:30:00.000Z");
    smitheryAdapter.collect = async () =>
      resultFor("smithery", freshRecords("smithery", 5, "2026-11-05T13:30:00.000Z"), "2026-11-05T13:30:00.000Z");
    try {
      const outcome = await collect({
        date,
        dataDir,
        now: new Date("2026-11-05T13:30:00.000Z"),
        force: false,
        sources: ["npm", "smithery"],
        env: { GITHUB_STEP_SUMMARY: summaryPath },
        http: createHttpClient({
          fetchImpl: async () => {
            throw new Error("stubbed sources must not fetch");
          },
          maxRetries: 0,
        }),
        log: {
          info() {},
          warn(message) {
            warnings.push(message);
          },
          error() {},
        },
        sourceAttempts: 1,
        sleep: async () => {},
      });
      expect(outcome.skipped).toBe(false);
      expect(outcome.wrote).toBe(false);
      expect(outcome.skipReason).toBeUndefined();
      expect(readFileSync(join(dataDir, "normalized", date, "manifest.json"), "utf8")).toBe(before);
      expect(readManifest(date, dataDir).partial).toBe(true);
      expect(freshRowCount(readSourceRows(date, dataDir).filter((row) => row.source === "npm"))).toBe(2);
      const warning = warnings.join("\n");
      expect(warning).toMatch(/blocked by npm fresh 2 -> 0/);
      expect(warning).toMatch(/would have improved smithery fresh 0 -> 5/);
      const summary = readFileSync(summaryPath, "utf8");
      expect(summary).toMatch(/blocked by npm fresh 2 -> 0/);
      expect(summary).toMatch(/would have improved smithery fresh 0 -> 5/);
      expect(summary).toMatch(/npm: 2 -> 0/);
      expect(summary).toMatch(/smithery: 0 -> 5/);
      expect(summary).toMatch(/day stays partial/);
    } finally {
      npmAdapter.collect = originalNpm;
      smitheryAdapter.collect = originalSmithery;
    }
  });

  function freshRows(source: SourceName, count: number, date: string, at: string, carriedForward = false): SourceRow[] {
    const rows: SourceRow[] = [];
    for (let index = 0; index < count; index += 1) {
      rows.push(
        emptySourceRow({
          snapshot_date: date,
          app_id: `${source}:row-${index}`,
          source,
          source_id: `row-${index}`,
          name: `row-${index}`,
          fetched_at: at,
          carried_forward: carriedForward,
          frozen: carriedForward,
        }),
      );
    }
    return rows;
  }

  function stubResult(
    source: SourceName,
    records: SourceRow[],
    at: string,
    extra: Partial<SourceResult> = {},
  ): SourceResult {
    return {
      source,
      collectedAt: at,
      rowCount: records.length,
      skipped: false,
      raw: { rows: records.length },
      records,
      freshTodayCount: freshRowCount(records),
      eligibleCount: Math.max(records.length, 1),
      ...extra,
    };
  }

  function installCollectStubs(produce: (name: SourceName) => SourceResult): { calls: SourceName[]; restore: () => void } {
    const calls: SourceName[] = [];
    const originals = new Map<SourceName, SourceAdapter["collect"]>();
    for (const adapter of adapters) {
      originals.set(adapter.name, adapter.collect);
      adapter.collect = async () => {
        calls.push(adapter.name);
        return produce(adapter.name);
      };
    }
    return {
      calls,
      restore() {
        for (const adapter of adapters) {
          const original = originals.get(adapter.name);
          if (original) {
            adapter.collect = original;
          }
        }
      },
    };
  }

  function completeCore(name: "mcp-registry" | "github", at: string): SourceManifest {
    return {
      source: name,
      rowCount: 1,
      skipped: false,
      failed: false,
      truncated: false,
      collectedAt: at,
      existingRows: 10,
      refetchedExisting: 10,
      refetchedExistingShare: 1,
      ...(name === "github" ? { mismatchChangedNotFresh: 0 } : {}),
    };
  }

  it("keeps saved pypi rows on a later --if-incomplete run instead of re-collecting pypi", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-keep-pypi-"));
    const date = "2026-11-25";
    const at = "2026-11-25T08:00:00.000Z";
    const later = "2026-11-25T12:00:00.000Z";
    const pypiFresh = 8;
    const rows = [
      ...freshRows("pypi", pypiFresh, date, at),
      ...freshRows("npm", 2, date, at),
      ...freshRows("smithery", 1, date, at, true),
      ...freshRows("gemini-cli", 1, date, at),
      ...freshRows("mcp-registry", 1, date, at),
      ...freshRows("github", 1, date, at),
    ];
    const manifest: SnapshotManifest = {
      snapshotDate: date,
      collectedAt: at,
      appCount: rows.length,
      sourceRowCount: rows.length,
      partial: true,
      sources: [
        completeCore("mcp-registry", at),
        {
          source: "smithery",
          rowCount: 1,
          skipped: false,
          failed: true,
          truncated: false,
          collectedAt: at,
          freshTodayCount: 0,
          fetchedThisRunCount: 0,
          error: "circuit_breaker_5xx",
        },
        {
          source: "gemini-cli",
          rowCount: 1,
          skipped: false,
          failed: false,
          truncated: false,
          collectedAt: at,
          freshTodayCount: 1,
        },
        completeCore("github", at),
        {
          source: "npm",
          rowCount: 2,
          skipped: false,
          failed: false,
          truncated: true,
          collectedAt: at,
          existingRows: 10,
          refetchedExisting: 10,
          refetchedExistingShare: 1,
          mismatchChangedNotFresh: 0,
          freshTodayCount: 2,
          fetchedThisRunCount: 2,
        },
        {
          source: "pypi",
          rowCount: pypiFresh,
          skipped: false,
          failed: false,
          truncated: true,
          collectedAt: at,
          freshTodayCount: pypiFresh,
          fetchedThisRunCount: pypiFresh,
          error: "pypi wall-clock budget of 55m exhausted (before package)",
        },
      ],
    };
    writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
    const notes: string[] = [];
    const stubs = installCollectStubs((name) => {
      if (name === "npm") {
        return stubResult("npm", freshRows("npm", 3, date, later), later, { fetchedThisRunCount: 1 });
      }
      return stubResult(name, [], later);
    });
    try {
      const outcome = await collect({
        date,
        dataDir,
        now: new Date(later),
        ifIncomplete: true,
        recoverNpm: true,
        sources: ["mcp-registry", "smithery", "gemini-cli", "github", "pypi"],
        env: {},
        http: createHttpClient({
          fetchImpl: async () => {
            throw new Error("stubbed collect must not fetch");
          },
          maxRetries: 0,
        }),
        log: {
          info(message, extra) {
            notes.push(`${message} ${JSON.stringify(extra ?? {})}`);
          },
          warn(message) {
            notes.push(message);
          },
          error(message) {
            notes.push(message);
          },
        },
        sourceAttempts: 1,
        sleep: async () => {},
      });
      expect(outcome.wrote).toBe(true);
      expect(stubs.calls.filter((name) => name === "pypi")).toEqual([]);
      expect(stubs.calls.filter((name) => name === "smithery" || name === "gemini-cli")).toEqual([]);
      expect(freshRowCount(readSourceRows(date, dataDir).filter((row) => row.source === "pypi"))).toBe(pypiFresh);
      expect(readManifest(date, dataDir).sources.find((source) => source.source === "pypi")).toMatchObject({
        truncated: true,
        fetchedThisRunCount: pypiFresh,
        rowCount: pypiFresh,
      });
      expect(notes.join("\n")).toMatch(/keeping saved rows for paused sources/);
      expect(notes.join("\n")).toMatch(/"pypi"/);
    } finally {
      stubs.restore();
    }
  });

  it("writes a snapshot when a non-core source drops fresh rows and a core source improves", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-noncore-drop-"));
    const date = "2026-11-05";
    const at = "2026-11-05T08:47:00.000Z";
    const later = "2026-11-05T13:30:00.000Z";
    const rows = [...freshRows("pypi", 4, date, at), ...freshRows("npm", 2, date, at)];
    const manifest: SnapshotManifest = {
      snapshotDate: date,
      collectedAt: at,
      appCount: rows.length,
      sourceRowCount: rows.length,
      partial: true,
      sources: [
        { source: "pypi", rowCount: 4, skipped: false, truncated: true, collectedAt: at, freshTodayCount: 4 },
        { source: "npm", rowCount: 2, skipped: false, truncated: true, collectedAt: at, freshTodayCount: 2 },
      ],
    };
    writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
    const summaryPath = join(dataDir, "step-summary.md");
    writeFileSync(summaryPath, "");
    const warnings: string[] = [];
    const originalNpm = npmAdapter.collect;
    const originalPypi = adapters.find((adapter) => adapter.name === "pypi")!.collect;
    npmAdapter.collect = async () => stubResult("npm", freshRows("npm", 5, date, later), later);
    adapters.find((adapter) => adapter.name === "pypi")!.collect = async () =>
      stubResult("pypi", freshRows("pypi", 1, date, later), later);
    try {
      const outcome = await collect({
        date,
        dataDir,
        now: new Date(later),
        force: false,
        sources: ["pypi", "npm"],
        env: { GITHUB_STEP_SUMMARY: summaryPath },
        http: createHttpClient({
          fetchImpl: async () => {
            throw new Error("stubbed sources must not fetch");
          },
          maxRetries: 0,
        }),
        log: {
          info() {},
          warn(message) {
            warnings.push(message);
          },
          error() {},
        },
        sourceAttempts: 1,
        sleep: async () => {},
      });
      expect(outcome.wrote).toBe(true);
      expect(warnings.join("\n")).toMatch(/non-core fresh drop on 2026-11-05: pypi fresh 4 -> 1; core improved npm fresh 2 -> 5/);
      const summary = readFileSync(summaryPath, "utf8");
      expect(summary).toMatch(/Non-core fresh drop 2026-11-05/);
      expect(summary).toMatch(/pypi: 4 -> 1/);
      expect(summary).toMatch(/npm: 2 -> 5/);
      expect(freshRowCount(readSourceRows(date, dataDir).filter((row) => row.source === "pypi"))).toBe(1);
      expect(freshRowCount(readSourceRows(date, dataDir).filter((row) => row.source === "npm"))).toBe(5);
    } finally {
      npmAdapter.collect = originalNpm;
      adapters.find((adapter) => adapter.name === "pypi")!.collect = originalPypi;
    }
  });

  it("still refuses to replace a snapshot when a core source loses fresh rows", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-core-drop-"));
    const date = "2026-11-05";
    const at = "2026-11-05T08:47:00.000Z";
    const later = "2026-11-05T13:30:00.000Z";
    const rows = [
      ...freshRows("npm", 2, date, at),
      ...freshRows("github", 1, date, at),
      ...freshRows("pypi", 4, date, at),
    ];
    const manifest: SnapshotManifest = {
      snapshotDate: date,
      collectedAt: at,
      appCount: rows.length,
      sourceRowCount: rows.length,
      partial: true,
      sources: [
        { source: "npm", rowCount: 2, skipped: false, truncated: true, collectedAt: at, freshTodayCount: 2 },
        { source: "github", rowCount: 1, skipped: false, truncated: true, collectedAt: at, freshTodayCount: 1 },
        { source: "pypi", rowCount: 4, skipped: false, truncated: true, collectedAt: at, freshTodayCount: 4 },
      ],
    };
    writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
    const before = readFileSync(join(dataDir, "normalized", date, "manifest.json"), "utf8");
    const warnings: string[] = [];
    const originals = new Map(adapters.map((adapter) => [adapter.name, adapter.collect]));
    const nextCounts: Partial<Record<SourceName, number>> = { npm: 0, github: 3, pypi: 1 };
    for (const adapter of adapters) {
      const count = nextCounts[adapter.name];
      if (count == null) {
        continue;
      }
      adapter.collect = async () => stubResult(adapter.name, freshRows(adapter.name, count, date, later), later);
    }
    try {
      const outcome = await collect({
        date,
        dataDir,
        now: new Date(later),
        force: false,
        sources: ["npm", "github", "pypi"],
        env: {},
        http: createHttpClient({
          fetchImpl: async () => {
            throw new Error("stubbed sources must not fetch");
          },
          maxRetries: 0,
        }),
        log: {
          info() {},
          warn(message) {
            warnings.push(message);
          },
          error() {},
        },
        sourceAttempts: 1,
        sleep: async () => {},
      });
      expect(outcome.wrote).toBe(false);
      expect(warnings.join("\n")).toMatch(/refusing to replace 2026-11-05: blocked by npm fresh 2 -> 0/);
      expect(readFileSync(join(dataDir, "normalized", date, "manifest.json"), "utf8")).toBe(before);
      expect(freshRowCount(readSourceRows(date, dataDir).filter((row) => row.source === "npm"))).toBe(2);
      expect(freshRowCount(readSourceRows(date, dataDir).filter((row) => row.source === "pypi"))).toBe(4);
    } finally {
      for (const adapter of adapters) {
        const original = originals.get(adapter.name);
        if (original) {
          adapter.collect = original;
        }
      }
    }
  });

  it("writes the Nov 26 snapshot when saved pypi fresh rows would drop and npm improves, so the chain can dispatch", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-nov26-pypi-"));
    const date = "2026-11-26";
    const at = "2026-11-26T07:00:00.000Z";
    const later = "2026-11-26T10:08:36.000Z";
    const pypiFresh = 5352;
    const rows = [
      ...freshRows("pypi", pypiFresh, date, at),
      ...freshRows("npm", 2, date, at),
      ...freshRows("smithery", 1, date, at, true),
      ...freshRows("gemini-cli", 1, date, at),
      ...freshRows("mcp-registry", 1, date, at),
      ...freshRows("github", 1, date, at),
    ];
    const manifest: SnapshotManifest = {
      snapshotDate: date,
      collectedAt: at,
      appCount: rows.length,
      sourceRowCount: rows.length,
      partial: true,
      failedSourceCount: 1,
      sources: [
        completeCore("mcp-registry", at),
        {
          source: "smithery",
          rowCount: 1,
          skipped: false,
          failed: true,
          truncated: false,
          collectedAt: at,
          freshTodayCount: 0,
          fetchedThisRunCount: 0,
          error: "circuit_breaker_5xx",
        },
        {
          source: "gemini-cli",
          rowCount: 1,
          skipped: false,
          failed: false,
          truncated: false,
          collectedAt: at,
          freshTodayCount: 1,
        },
        completeCore("github", at),
        {
          source: "npm",
          rowCount: 2,
          skipped: false,
          failed: false,
          truncated: true,
          collectedAt: at,
          existingRows: 10,
          refetchedExisting: 8,
          refetchedExistingShare: 0.8,
          mismatchChangedNotFresh: 0,
          freshTodayCount: 2,
          fetchedThisRunCount: 14933,
          error: "npm wall-clock budget of 240m exhausted (scoped in flight)",
        },
        {
          source: "pypi",
          rowCount: pypiFresh,
          skipped: false,
          failed: false,
          truncated: true,
          collectedAt: at,
          freshTodayCount: pypiFresh,
          fetchedThisRunCount: pypiFresh,
          error: "pypi wall-clock budget of 55m exhausted (before package)",
        },
      ],
    };
    writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
    const summaryPath = join(dataDir, "step-summary.md");
    const outputPath = join(dataDir, "github-output.txt");
    writeFileSync(summaryPath, "");
    const dispatched: NpmChainRequest[] = [];
    const stubs = installCollectStubs((name) => {
      if (name === "npm") {
        return stubResult("npm", freshRows("npm", 3, date, later), later, {
          halt: "budget",
          fetchedThisRunCount: 4139,
          truncated: true,
        });
      }
      return stubResult(name, [], later);
    });
    try {
      const outcome = await collect({
        date,
        dataDir,
        now: new Date(later),
        ifIncomplete: true,
        recoverNpm: true,
        sources: ["mcp-registry", "smithery", "gemini-cli", "github", "pypi"],
        env: {
          GITHUB_STEP_SUMMARY: summaryPath,
          GITHUB_OUTPUT: outputPath,
          RADAR_COLLECT_CHAIN: "1",
        },
        http: createHttpClient({
          fetchImpl: async () => {
            throw new Error("stubbed collect must not fetch");
          },
          maxRetries: 0,
        }),
        log: silent,
        sourceAttempts: 1,
        sleep: async () => {},
        dispatchCollect(request) {
          dispatched.push(request);
        },
      });
      expect(outcome.wrote).toBe(true);
      expect(stubs.calls.filter((name) => name === "pypi")).toEqual([]);
      expect(freshRowCount(readSourceRows(date, dataDir).filter((row) => row.source === "pypi"))).toBe(pypiFresh);
      expect(freshRowCount(readSourceRows(date, dataDir).filter((row) => row.source === "npm"))).toBe(3);
      expect(dispatched).toEqual([
        expect.objectContaining({
          ifIncomplete: true,
          recoverNpm: true,
          chain: 2,
        }),
      ]);
      const output = readFileSync(outputPath, "utf8");
      expect(output).toContain("wrote=true");
      expect(output).toContain("chain_dispatch=true");
      expect(output).not.toContain("collect did not keep the snapshot");
      expect(readFileSync(summaryPath, "utf8")).toMatch(/Decision: dispatch/);
    } finally {
      stubs.restore();
    }
  });

  it("collects every source on the first run of a day when no manifest exists yet", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-first-run-"));
    const date = "2026-11-26";
    const at = "2026-11-26T00:20:00.000Z";
    const stubs = installCollectStubs((name) => stubResult(name, freshRows(name, 1, date, at), at));
    try {
      const outcome = await collect({
        date,
        dataDir,
        now: new Date(at),
        ifIncomplete: true,
        env: {},
        http: createHttpClient({
          fetchImpl: async () => {
            throw new Error("first run stubs must not fetch");
          },
          maxRetries: 0,
        }),
        log: silent,
        sourceAttempts: 1,
        sleep: async () => {},
      });
      expect(outcome.wrote).toBe(true);
      expect(stubs.calls).toEqual([...SOURCE_NAMES]);
    } finally {
      stubs.restore();
    }
  });
});
