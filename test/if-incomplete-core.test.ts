import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collect } from "../src/commands/collect.ts";
import { BACKUP_CORE_SOURCES, publishIfIncompleteGate } from "../src/lib/backup-core.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { readManifest, writeNormalized } from "../src/lib/io.ts";
import { createLogger } from "../src/lib/logger.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { emptySourceRow, type SnapshotManifest, type SourceManifest, type SourceName } from "../src/lib/schema.ts";

const silent = createLogger({
  log() {},
  warn() {},
  error() {},
});

const DATE = "2026-11-21";
const COLLECTED_AT = "2026-11-21T05:41:00.000Z";

function source(name: SourceName, extra: Partial<SourceManifest> = {}): SourceManifest {
  return {
    source: name,
    rowCount: 10,
    skipped: false,
    failed: false,
    truncated: false,
    collectedAt: COLLECTED_AT,
    ...extra,
  };
}

function coreCompleteSources(overrides: Partial<Record<SourceName, Partial<SourceManifest>>> = {}): SourceManifest[] {
  const base: SourceManifest[] = [
    source("mcp-registry"),
    source("smithery"),
    source("gemini-cli"),
    source("github", {
      existingRows: 100,
      refetchedExisting: 90,
      refetchedExistingShare: 0.9,
      mismatchChangedNotFresh: 0,
    }),
    source("npm", {
      existingRows: 80,
      refetchedExisting: 76,
      refetchedExistingShare: 0.95,
      mismatchChangedNotFresh: 0,
      fetchedShare: 0.95,
    }),
    source("pypi"),
  ];
  return base.map((entry) => ({ ...entry, ...overrides[entry.source] }));
}

function manifest(partial: boolean, sources: SourceManifest[], extra: Partial<SnapshotManifest> = {}): SnapshotManifest {
  return {
    snapshotDate: DATE,
    collectedAt: COLLECTED_AT,
    appCount: 1,
    sourceRowCount: 1,
    partial,
    sources,
    ...extra,
  };
}

function writeDay(dataDir: string, day: SnapshotManifest): void {
  const rows = [
    emptySourceRow({
      snapshot_date: DATE,
      app_id: "github:example/kept",
      source: "gemini-cli",
      source_id: "kept",
      name: "kept",
      stars: 4,
      fetched_at: COLLECTED_AT,
      carried_forward: false,
    }),
  ];
  writeNormalized(DATE, rows, mergeApps(DATE, rows), day, dataDir);
}

function throwingCollect(dataDir: string, summaryPath?: string) {
  let calls = 0;
  const outcome = collect({
    date: DATE,
    dataDir,
    now: new Date("2026-11-21T19:23:00.000Z"),
    ifIncomplete: true,
    sources: ["mcp-registry"],
    env: summaryPath ? { GITHUB_STEP_SUMMARY: summaryPath } : {},
    http: createHttpClient({
      fetchImpl: async () => {
        calls += 1;
        throw new Error("backup should not fetch when core-complete");
      },
      maxRetries: 0,
    }),
    log: silent,
    sourceAttempts: 1,
    sleep: async () => {},
  });
  return outcome.then((result) => ({ result, calls }));
}

describe("--if-incomplete core sources", () => {
  it("keeps the core list in one constant", () => {
    expect(BACKUP_CORE_SOURCES).toEqual(["mcp-registry", "github", "npm"]);
  });

  it("skips when the day is partial only because smithery failed and the core three are clean", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-core-smithery-"));
    const summaryPath = join(dataDir, "summary.md");
    const day = manifest(true, coreCompleteSources({
      smithery: { failed: true, skipped: true, error: "circuit_breaker_5xx" },
    }), { failedSourceCount: 1 });
    writeDay(dataDir, day);
    const before = readFileSync(join(dataDir, "normalized", DATE, "manifest.json"), "utf8");
    const { result, calls } = await throwingCollect(dataDir, summaryPath);
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.wrote).toBe(false);
    expect(result.skipReason).toMatch(/core sources complete/);
    expect(result.skipReason).toMatch(/github completed, refetchedExistingShare 0\.900/);
    expect(result.skipReason).toMatch(/npm completed, refetchedExistingShare 0\.950/);
    expect(calls).toBe(0);
    expect(readFileSync(join(dataDir, "normalized", DATE, "manifest.json"), "utf8")).toBe(before);
    expect(readManifest(DATE, dataDir).partial).toBe(true);
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toMatch(/Backup skipped 2026-11-21/);
    expect(summary).toMatch(/Core sources \(mcp-registry, github, npm\) are complete/);
    expect(summary).toMatch(/smithery failed: circuit_breaker_5xx/);
    expect(summary).toMatch(/do not trigger a backup rerun/);
    expect(summary).toMatch(/partial` flag was not changed/);
  });

  it("skips when smithery, gemini-cli, and pypi all failed and the core sources are clean", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-core-noncore-"));
    const day = manifest(true, coreCompleteSources({
      smithery: { failed: true, skipped: true, error: "circuit_breaker_5xx" },
      "gemini-cli": { failed: true, skipped: true, error: "static gallery" },
      pypi: { failed: true, skipped: true, error: "timeout" },
    }));
    writeDay(dataDir, day);
    const { result, calls } = await throwingCollect(dataDir);
    expect(result.skipped).toBe(true);
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
    expect(readManifest(DATE, dataDir).partial).toBe(true);
  });

  it("proceeds when npm is truncated", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-core-npm-trunc-"));
    const day = manifest(true, coreCompleteSources({
      npm: { truncated: true, failed: false, fetchedShare: 0.4 },
    }));
    writeDay(dataDir, day);
    const { result, calls } = await throwingCollect(dataDir);
    expect(result.skipped).toBe(false);
    expect(result.wrote).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });

  it("proceeds for a Nov 21 shaped run: npm truncated at fetchedShare 0.75 and no source failed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-core-nov21-"));
    const day = manifest(true, coreCompleteSources({
      npm: {
        truncated: true,
        failed: false,
        skipped: false,
        fetchedShare: 0.75,
        existingRows: 80,
        refetchedExisting: 76,
        refetchedExistingShare: 0.95,
        mismatchChangedNotFresh: 0,
      },
    }));
    expect(day.sources.every((entry) => entry.failed !== true)).toBe(true);
    writeDay(dataDir, day);
    const { result, calls } = await throwingCollect(dataDir);
    expect(result.skipped).toBe(false);
    expect(calls).toBeGreaterThan(0);
    expect(readManifest(DATE, dataDir).sources.find((entry) => entry.source === "npm")?.fetchedShare).toBe(0.75);
    expect(readManifest(DATE, dataDir).sources.find((entry) => entry.source === "npm")?.truncated).toBe(true);
  });

  it("proceeds when github refetchedExistingShare is below 0.9", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-core-share-"));
    const day = manifest(false, coreCompleteSources({
      github: {
        refetchedExistingShare: 0.89,
        existingRows: 100,
        refetchedExisting: 89,
        mismatchChangedNotFresh: 0,
      },
    }));
    writeDay(dataDir, day);
    const { result, calls } = await throwingCollect(dataDir);
    expect(result.skipped).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });

  it("proceeds when github mismatchChangedNotFresh is above 0", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-core-mismatch-"));
    const day = manifest(false, coreCompleteSources({
      github: {
        refetchedExistingShare: 0.9,
        existingRows: 100,
        refetchedExisting: 90,
        mismatchChangedNotFresh: 4,
      },
    }));
    writeDay(dataDir, day);
    const { result, calls } = await throwingCollect(dataDir);
    expect(result.skipped).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });

  it("proceeds when npm mismatchChangedNotFresh is above 0", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-core-npm-mismatch-"));
    const day = manifest(false, coreCompleteSources({
      npm: { mismatchChangedNotFresh: 1 },
    }));
    writeDay(dataDir, day);
    const { result, calls } = await throwingCollect(dataDir);
    expect(result.skipped).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });

  it("proceeds when mcp-registry is incomplete", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-core-mcp-"));
    const day = manifest(true, coreCompleteSources({
      "mcp-registry": { failed: true, skipped: true, error: "500 Failed to get registry list" },
    }));
    writeDay(dataDir, day);
    const { result, calls } = await throwingCollect(dataDir);
    expect(result.skipped).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });

  it("proceeds when the manifest is missing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-core-missing-"));
    const { result, calls } = await throwingCollect(dataDir);
    expect(result.skipped).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });

  it("proceeds when the manifest is unreadable", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-core-bad-"));
    const dayDir = join(dataDir, "normalized", DATE);
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(dayDir, "manifest.json"), "{not json");
    writeFileSync(join(dayDir, "apps.ndjson"), "{}\n");
    writeFileSync(join(dayDir, "source_rows.ndjson"), "{}\n");
    const { result, calls } = await throwingCollect(dataDir);
    expect(result.skipped).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });

  it("tells the workflow gate to skip a core-complete day and to collect a truncated npm day", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-core-gate-"));
    const outputPath = join(dataDir, "output.txt");
    const summaryPath = join(dataDir, "summary.md");
    writeFileSync(outputPath, "");
    writeFileSync(summaryPath, "");
    const skipDay = manifest(true, coreCompleteSources({
      smithery: { failed: true, skipped: true, error: "circuit_breaker_5xx" },
    }));
    writeDay(dataDir, skipDay);
    const skipped = publishIfIncompleteGate(DATE, dataDir, {
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
    });
    expect(skipped.proceed).toBe(false);
    expect(readFileSync(outputPath, "utf8")).toBe("skip=true\n");
    expect(readFileSync(summaryPath, "utf8")).toMatch(/Backup skipped 2026-11-21/);

    const proceedDir = mkdtempSync(join(tmpdir(), "radar-core-gate-go-"));
    const proceedOutput = join(proceedDir, "output.txt");
    const proceedSummary = join(proceedDir, "summary.md");
    writeFileSync(proceedOutput, "");
    writeFileSync(proceedSummary, "");
    writeDay(proceedDir, manifest(true, coreCompleteSources({
      npm: {
        truncated: true,
        failed: false,
        fetchedShare: 0.75,
        refetchedExistingShare: 0.95,
        mismatchChangedNotFresh: 0,
      },
    })));
    const proceeded = publishIfIncompleteGate(DATE, proceedDir, {
      GITHUB_OUTPUT: proceedOutput,
      GITHUB_STEP_SUMMARY: proceedSummary,
    });
    expect(proceeded.proceed).toBe(true);
    expect(proceeded.reason).toMatch(/npm is truncated/);
    expect(readFileSync(proceedOutput, "utf8")).toBe("skip=false\n");
    expect(readFileSync(proceedSummary, "utf8")).toBe("");
  });
});
