import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compareSourceHealth, evaluateHealth, runHealth } from "../src/commands/health.ts";
import { writeNormalized } from "../src/lib/io.ts";
import type { SnapshotManifest, SourceManifest } from "../src/lib/schema.ts";

function source(name: SourceManifest["source"], rowCount: number, skipped = false): SourceManifest {
  return {
    source: name,
    rowCount,
    skipped,
    collectedAt: "2026-10-15T00:00:00Z",
  };
}

function manifest(date: string, sources: SourceManifest[]): SnapshotManifest {
  return {
    snapshotDate: date,
    collectedAt: `${date}T00:00:00Z`,
    sources,
    appCount: sources.reduce((sum, item) => sum + item.rowCount, 0),
    sourceRowCount: sources.reduce((sum, item) => sum + item.rowCount, 0),
  };
}

describe("health", () => {
  it("flags a >30% row-count drop and ignores skipped sources", () => {
    const finding = compareSourceHealth(
      source("smithery", 60),
      source("smithery", 100),
      "2026-10-16",
      "2026-10-15",
    );
    expect(finding?.dropRatio).toBeCloseTo(0.4);

    expect(
      compareSourceHealth(source("smithery", 80), source("smithery", 100), "2026-10-16", "2026-10-15"),
    ).toBeNull();
    expect(
      compareSourceHealth(source("github", 0, true), source("github", 100), "2026-10-16", "2026-10-15"),
    ).toBeNull();
  });

  it("fails the check and opens an issue when a source drops", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-health-"));
    writeNormalized("2026-10-15", [], [], manifest("2026-10-15", [source("mcp-registry", 100)]), dataDir);
    writeNormalized("2026-10-16", [], [], manifest("2026-10-16", [source("mcp-registry", 50)]), dataDir);

    const report = evaluateHealth({ date: "2026-10-16", dataDir });
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.source).toBe("mcp-registry");

    const openIssue = vi.fn(async () => ({ created: true, url: "https://github.com/x/y/issues/1" }));
    const ran = await runHealth({
      date: "2026-10-16",
      dataDir,
      openIssue,
      log: { info() {}, warn() {}, error() {} },
    });
    expect(ran.ok).toBe(false);
    expect(openIssue).toHaveBeenCalledOnce();
    expect(openIssue.mock.calls[0]?.[0].title).toContain("mcp-registry");
  });
});
