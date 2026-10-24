import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCollectorMissedAlert } from "../src/commands/alert-missed.ts";
import { writeNormalized } from "../src/lib/io.ts";
import type { SnapshotManifest } from "../src/lib/schema.ts";

const silent = { info() {}, warn() {}, error() {} };

function snapshot(date: string): SnapshotManifest {
  return {
    snapshotDate: date,
    collectedAt: `${date}T12:00:00Z`,
    appCount: 1,
    sourceRowCount: 1,
    sources: [{ source: "gemini-cli", rowCount: 1, skipped: false, collectedAt: `${date}T12:00:00Z` }],
  };
}

describe("collector missed alert", () => {
  it("opens an issue when collect failed and today's snapshot is missing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-alert-"));
    const openIssue = vi.fn(async () => ({ created: true, commented: false, url: "https://github.com/x/y/issues/1" }));
    const report = await runCollectorMissedAlert({
      date: "2026-10-23",
      dataDir,
      collectFailed: true,
      openIssue,
      log: silent,
    });
    expect(report.alerted).toBe(true);
    expect(report.created).toBe(true);
    expect(openIssue.mock.calls[0]?.[0].title).toBe("Collector missed 2026-10-23");
  });

  it("comments on an existing issue after the backstop if still missing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-alert2-"));
    const openIssue = vi.fn(async () => ({ created: false, commented: true, url: "https://github.com/x/y/issues/1" }));
    const report = await runCollectorMissedAlert({
      date: "2026-10-17",
      dataDir,
      backstop: true,
      openIssue,
      log: silent,
    });
    expect(report.commented).toBe(true);
    expect(openIssue).toHaveBeenCalledOnce();
  });

  it("does not open a missed-day issue when a usable snapshot exists", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-alert3-"));
    writeNormalized("2026-10-24", [], [], snapshot("2026-10-24"), dataDir);
    const openIssue = vi.fn(async () => ({ created: true, commented: false }));
    const report = await runCollectorMissedAlert({
      date: "2026-10-24",
      dataDir,
      collectFailed: true,
      openIssue,
      log: silent,
    });
    expect(report.usable).toBe(true);
    expect(report.alerted).toBe(false);
    expect(openIssue).not.toHaveBeenCalled();
  });
});
