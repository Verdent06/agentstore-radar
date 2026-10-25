import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collect } from "../src/commands/collect.ts";
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
import { emptySourceRow, type SnapshotManifest } from "../src/lib/schema.ts";
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
      completedSources: ["gemini-cli"],
      sources: [
        {
          source: "gemini-cli",
          rowCount: 1,
          skipped: false,
          collectedAt: "2026-10-24T11:07:24.740Z",
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
    const catalogFetch = fixtureFetch(catalogs);
    const forced = await collect({
      date: "2026-10-24",
      dataDir,
      now: new Date("2026-10-24T19:48:02Z"),
      force: true,
      runId: "run-evening",
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
    });
    expect(forced.wrote).toBe(true);
    const next = readManifest("2026-10-24", dataDir);
    expect(next.runId).toBe("run-evening");
    expect(next.overwrite).toMatchObject({
      overwrittenAt: "2026-10-24T19:48:02.000Z",
      previousCollectedAt: "2026-10-24T11:07:24.740Z",
      previousRunId: "run-morning",
    });
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
});
