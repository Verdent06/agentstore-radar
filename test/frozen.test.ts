import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isUnchangedForDays, loadPreviousMetricHistory, smitheryFrozenDays } from "../src/lib/frozen.ts";
import { writeNormalized } from "../src/lib/io.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { emptySourceRow, type SnapshotManifest, type SourceRow } from "../src/lib/schema.ts";

/** Real unchanged Smithery value from 2026-10-21..25 (Oct 23 is a gap). */
const PIPEWORX_GATEWAY = "pipeworx/gateway";
const PIPEWORX_USE_COUNT = 419019;

function smitheryRow(date: string, sourceId: string, useCount: number): SourceRow {
  return emptySourceRow({
    snapshot_date: date,
    source: "smithery",
    source_id: sourceId,
    name: sourceId,
    use_count: useCount,
    app_id: `smithery:${sourceId}`,
    fetched_at: `${date}T12:00:00Z`,
    carried_forward: false,
  });
}

function writeDay(dataDir: string, date: string, rows: SourceRow[]): void {
  const manifest: SnapshotManifest = {
    snapshotDate: date,
    collectedAt: `${date}T12:00:00Z`,
    appCount: rows.length,
    sourceRowCount: rows.length,
    partial: false,
    completedSources: ["smithery"],
    sources: [{ source: "smithery", rowCount: rows.length, skipped: false, collectedAt: `${date}T12:00:00Z` }],
  };
  writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
}

describe("frozen metric detection", () => {
  it("reads SMITHERY_FROZEN_DAYS and defaults to 3", () => {
    expect(smitheryFrozenDays({}, 3)).toBe(3);
    expect(smitheryFrozenDays({ SMITHERY_FROZEN_DAYS: "5" }, 3)).toBe(5);
    expect(smitheryFrozenDays({ SMITHERY_FROZEN_DAYS: "0" }, 3)).toBe(3);
    expect(smitheryFrozenDays({ SMITHERY_FROZEN_DAYS: "nope" }, 3)).toBe(3);
  });

  it("marks pipeworx/gateway 419019 frozen after 3 snapshot days, skipping the Oct 23 gap", () => {
    const dates = ["2026-10-21", "2026-10-22", "2026-10-24"];
    const history = dates.map((date) => ({ date, value: PIPEWORX_USE_COUNT }));
    expect(isUnchangedForDays(PIPEWORX_USE_COUNT, history, dates, 3)).toBe(true);
    expect(dates.includes("2026-10-23")).toBe(false);
    expect(isUnchangedForDays(PIPEWORX_USE_COUNT, history.slice(0, 1), dates.slice(0, 1), 3)).toBe(false);
    expect(isUnchangedForDays(419020, history, dates, 3)).toBe(false);
  });

  it("loads previous snapshot values without inventing a missing day", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-frozen-hist-"));
    writeDay(dataDir, "2026-10-21", [smitheryRow("2026-10-21", PIPEWORX_GATEWAY, PIPEWORX_USE_COUNT)]);
    writeDay(dataDir, "2026-10-22", [smitheryRow("2026-10-22", PIPEWORX_GATEWAY, PIPEWORX_USE_COUNT)]);
    writeDay(dataDir, "2026-10-24", [smitheryRow("2026-10-24", PIPEWORX_GATEWAY, PIPEWORX_USE_COUNT)]);
    const loaded = loadPreviousMetricHistory(dataDir, "2026-10-25", "smithery", "use_count", 3);
    expect(loaded.dates).toEqual(["2026-10-21", "2026-10-22", "2026-10-24"]);
    expect(loaded.dates).not.toContain("2026-10-23");
    expect(loaded.byId.get(PIPEWORX_GATEWAY)?.map((row) => row.value)).toEqual([
      PIPEWORX_USE_COUNT,
      PIPEWORX_USE_COUNT,
      PIPEWORX_USE_COUNT,
    ]);
    expect(isUnchangedForDays(PIPEWORX_USE_COUNT, loaded.byId.get(PIPEWORX_GATEWAY) ?? [], loaded.dates, 3)).toBe(true);
  });
});
