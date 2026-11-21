import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate/build.ts";
import { movers } from "../src/aggregate/query.ts";
import { runTool } from "../src/aggregate/tools.ts";
import { writeNormalized } from "../src/lib/io.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { emptySourceRow, type SnapshotManifest, type SourceName } from "../src/lib/schema.ts";
import {
  REFETCH_SHARE_FLOOR,
  combinedScore,
  coreClean,
  membershipCount,
  omitPypiMonthly,
  popularityWindow,
  verified_from,
  type CoreCleanResult,
} from "../src/lib/window-guard.ts";

const CORE: SourceName[] = ["mcp-registry", "github", "npm"];

function source(name: SourceName, overrides: Record<string, unknown> = {}) {
  const popularity = name === "github" || name === "npm";
  const existingRows = 100;
  const refetchedExisting = popularity ? 95 : 100;
  const row: Record<string, unknown> = {
    source: name,
    rowCount: 10,
    skipped: false,
    failed: false,
    truncated: false,
    collectedAt: "2026-11-05T12:00:00.000Z",
    existingRows,
    refetchedExisting,
    eligibleCount: 120,
    ...(popularity ? { mismatchChangedNotFresh: 0, mismatchFreshUnchanged: 5 } : {}),
    ...overrides,
  };
  if (
    !("refetchedExistingShare" in overrides) &&
    typeof row.existingRows === "number" &&
    typeof row.refetchedExisting === "number"
  ) {
    row.refetchedExistingShare = row.existingRows <= 0 ? 1 : row.refetchedExisting / row.existingRows;
  }
  return row;
}

function manifest(date: string, overrides: Partial<Record<SourceName, Record<string, unknown>>> = {}): SnapshotManifest {
  return {
    snapshotDate: date,
    collectedAt: `${date}T12:00:00.000Z`,
    appCount: 1,
    sourceRowCount: 1,
    partial: false,
    sources: CORE.map((name) => source(name, overrides[name] ?? {})),
  } as SnapshotManifest;
}

function cleanMap(days: Record<string, unknown>): Record<string, CoreCleanResult> {
  return Object.fromEntries(Object.entries(days).map(([date, day]) => [date, coreClean(day)]));
}

describe("core-clean from the snapshot manifest", () => {
  it("refuses 2026-11-04 → 2026-11-05 because Nov 4 npm is truncated", () => {
    const nov4 = manifest("2026-11-04", { npm: { truncated: true } });
    const nov5 = manifest("2026-11-05");
    const nov4Clean = coreClean(nov4);
    expect(nov4Clean.clean).toBe(false);
    expect(nov4Clean.reasons).toContain("npm: truncated");
    expect(coreClean(nov5).clean).toBe(true);
    const verdict = popularityWindow({
      start: "2026-11-04",
      end: "2026-11-05",
      presentDates: ["2026-11-04", "2026-11-05"],
      cleanByDate: cleanMap({ "2026-11-04": nov4, "2026-11-05": nov5 }),
      requested: "1d",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.label).toBeNull();
    expect(verdict.reasons.join(" ")).toContain("npm: truncated");
    expect(JSON.stringify(verdict)).not.toMatch(/"delta"/);
  });

  it("allows 2026-11-05 → 2026-11-06 when both fixtures are clean", () => {
    const nov5 = manifest("2026-11-05");
    const nov6 = manifest("2026-11-06");
    expect(coreClean(nov5)).toMatchObject({
      clean: true,
      reasons: [],
      mismatchFreshUnchanged: { github: 5, npm: 5 },
    });
    expect(coreClean(nov6).clean).toBe(true);
    const verdict = popularityWindow({
      start: "2026-11-05",
      end: "2026-11-06",
      presentDates: ["2026-11-05", "2026-11-06"],
      cleanByDate: cleanMap({ "2026-11-05": nov5, "2026-11-06": nov6 }),
      requested: "1d",
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.label).toBe("1d");
    expect(verdict.dayCount).toBe(1);
    expect(verdict.missingDates).toEqual([]);
  });

  it("refuses a later day whose refetch share is 0.85", () => {
    const day = manifest("2026-11-07", { github: { refetchedExisting: 85, existingRows: 100 } });
    const result = coreClean(day);
    expect(result.clean).toBe(false);
    expect(result.reasons).toContain(`github: refetch share 0.85 is below ${REFETCH_SHARE_FLOOR}`);
    const verdict = popularityWindow({
      start: "2026-11-06",
      end: "2026-11-07",
      presentDates: ["2026-11-06", "2026-11-07"],
      cleanByDate: cleanMap({ "2026-11-06": manifest("2026-11-06"), "2026-11-07": day }),
      requested: "1d",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("refetch share 0.85");
  });

  it("refuses a later day whose mismatch count A is above 0", () => {
    const day = manifest("2026-11-08", { npm: { mismatchChangedNotFresh: 3 } });
    const result = coreClean(day);
    expect(result.clean).toBe(false);
    expect(result.reasons).toContain("npm: mismatchChangedNotFresh is 3");
    const verdict = popularityWindow({
      start: "2026-11-07",
      end: "2026-11-08",
      presentDates: ["2026-11-07", "2026-11-08"],
      cleanByDate: cleanMap({ "2026-11-07": manifest("2026-11-07"), "2026-11-08": day }),
      requested: "1d",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("npm: mismatchChangedNotFresh is 3");
  });

  it("refuses windows that start on 2026-10-24 or 2026-11-01", () => {
    for (const start of ["2026-10-24", "2026-11-01"]) {
      const end = start === "2026-10-24" ? "2026-10-25" : "2026-11-02";
      const verdict = popularityWindow({
        start,
        end,
        presentDates: [start, end],
        cleanByDate: cleanMap({ [start]: manifest(start), [end]: manifest(end) }),
        requested: "1d",
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reasons).toContain(`start ${start} is before verified_from ${verified_from}`);
      expect(verdict.label).toBeNull();
    }
  });

  it("names a missing middle day, reports the real span, and never labels it 1d", () => {
    const present = ["2026-11-05", "2026-11-07"];
    const cleanByDate = cleanMap({
      "2026-11-05": manifest("2026-11-05"),
      "2026-11-07": manifest("2026-11-07"),
    });
    const refused = popularityWindow({
      start: "2026-11-05",
      end: "2026-11-07",
      presentDates: present,
      cleanByDate,
      requested: "1d",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.dayCount).toBe(2);
    expect(refused.missingDates).toEqual(["2026-11-06"]);
    expect(refused.label).not.toBe("1d");
    expect(refused.reasons.join(" ")).toContain("2026-11-06");
    expect(refused.reasons.join(" ")).toContain("2d");

    const longer = popularityWindow({
      start: "2026-11-05",
      end: "2026-11-07",
      presentDates: present,
      cleanByDate,
      requested: "7d",
    });
    expect(longer.allowed).toBe(true);
    expect(longer.dayCount).toBe(2);
    expect(longer.label).toBe("2d");
    expect(longer.label).not.toBe("1d");
    expect(longer.missingDates).toEqual(["2026-11-06"]);
  });

  it("fails closed when the refetch-share field is missing", () => {
    const day = manifest("2026-11-06", {
      npm: { refetchedExisting: undefined, fetchedShare: 1, eligibleCount: 100, rowCount: 100 },
    });
    const npm = day.sources.find((entry) => entry.source === "npm");
    delete (npm as { refetchedExisting?: number }).refetchedExisting;
    const result = coreClean(day);
    expect(result.clean).toBe(false);
    expect(result.reasons).toContain("npm: missing field refetchedExisting");
  });

  it("fails closed when existingRows is missing even if rowCount and eligibleCount are present", () => {
    const day = manifest("2026-11-06", {
      github: { existingRows: undefined, rowCount: 80, eligibleCount: 80 },
    });
    const github = day.sources.find((entry) => entry.source === "github");
    delete (github as { existingRows?: number }).existingRows;
    const result = coreClean(day);
    expect(result.clean).toBe(false);
    expect(result.reasons).toContain("github: missing field existingRows");
  });

  it("accepts a fully clean day in the collector manifest shape, including absent mcp A/B", () => {
    const day = {
      snapshotDate: "2026-11-06",
      collectedAt: "2026-11-06T12:00:00.000Z",
      appCount: 1,
      sourceRowCount: 3,
      partial: false,
      sources: [
        {
          source: "mcp-registry",
          rowCount: 40,
          skipped: false,
          failed: false,
          truncated: false,
          collectedAt: "2026-11-06T12:00:00.000Z",
          existingRows: 40,
          refetchedExisting: 40,
          refetchedExistingShare: 1,
        },
        {
          source: "github",
          rowCount: 100,
          skipped: false,
          failed: false,
          truncated: false,
          collectedAt: "2026-11-06T12:00:00.000Z",
          existingRows: 100,
          refetchedExisting: 95,
          refetchedExistingShare: 0.95,
          mismatchChangedNotFresh: 0,
          mismatchFreshUnchanged: 12,
        },
        {
          source: "npm",
          rowCount: 80,
          skipped: false,
          failed: false,
          truncated: false,
          collectedAt: "2026-11-06T12:00:00.000Z",
          existingRows: 80,
          refetchedExisting: 72,
          refetchedExistingShare: 0.9,
          mismatchChangedNotFresh: 0,
          mismatchFreshUnchanged: 70,
        },
      ],
    };
    const mcp = day.sources[0];
    expect(mcp).not.toHaveProperty("mismatchChangedNotFresh");
    expect(mcp).not.toHaveProperty("mismatchFreshUnchanged");
    const result = coreClean(day);
    expect(result.clean).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.mismatchFreshUnchanged).toEqual({ github: 12, npm: 70 });
    expect(result.reasons.join(" ")).not.toMatch(/mismatchFreshUnchanged/);
  });

  it("rejects mcp-registry at 90% because membership must be fully fetched", () => {
    const day = manifest("2026-11-09", {
      "mcp-registry": { existingRows: 100, refetchedExisting: 90, refetchedExistingShare: 0.9 },
    });
    const mcp = day.sources.find((entry) => entry.source === "mcp-registry");
    expect(mcp).not.toHaveProperty("mismatchChangedNotFresh");
    expect(mcp).not.toHaveProperty("mismatchFreshUnchanged");
    const result = coreClean(day);
    expect(result.clean).toBe(false);
    expect(result.reasons).toContain("mcp-registry: refetch share 0.9 is below 1");
    expect(result.reasons.join(" ")).not.toMatch(/mismatchChangedNotFresh|mismatchFreshUnchanged/);
  });

  it("fails closed when github omits mismatchChangedNotFresh", () => {
    const day = manifest("2026-11-06");
    const github = day.sources.find((entry) => entry.source === "github");
    delete (github as { mismatchChangedNotFresh?: number }).mismatchChangedNotFresh;
    const result = coreClean(day);
    expect(result.clean).toBe(false);
    expect(result.reasons).toContain("github: missing field mismatchChangedNotFresh");
  });

  it("fails closed when truncated is absent", () => {
    const day = manifest("2026-11-06", { "mcp-registry": { truncated: undefined } });
    const entry = day.sources.find((row) => row.source === "mcp-registry");
    delete (entry as { truncated?: boolean }).truncated;
    expect(coreClean(day).reasons).toContain("mcp-registry: missing field truncated");
  });
});

describe("frozen sources stay out of combined scores", () => {
  it("ignores smithery, gemini, and pypi, including PyPI monthly", () => {
    const score = combinedScore({
      github: 10,
      npm: 20,
      mcp: 3,
      smithery: 1_000_000,
      gemini: 500_000,
      pypi: 400_000,
      pypiMonthly: 9_000_000,
    });
    expect(score).toBe(33);
    expect(membershipCount(["mcp-registry", "github", "npm", "smithery", "gemini-cli", "pypi"])).toBe(6);
  });

  it("drops PyPI monthly fields from a public payload", () => {
    const payload = omitPypiMonthly({
      pypiLastWeekDownloads: 12,
      pypi_last_month_downloads: 99,
      nested: { pypiLastMonthDownloads: 40, stars: 5 },
    }) as { pypiLastWeekDownloads: number; nested: { stars: number } };
    expect(payload.pypiLastWeekDownloads).toBe(12);
    expect(payload.nested.stars).toBe(5);
    expect(JSON.stringify(payload)).not.toMatch(/month/i);
  });
});

describe("movers use the guard", () => {
  function writeDay(dataDir: string, date: string, downloads: number, manifestDay: SnapshotManifest): void {
    const rows = [
      emptySourceRow({
        snapshot_date: date,
        app_id: "github:example/guarded",
        source: "npm",
        source_id: "@example/guarded",
        name: "guarded",
        display_name: "Guarded",
        npm_weekly_downloads: downloads,
        fetched_at: `${date}T12:00:00.000Z`,
        carried_forward: false,
      }),
    ];
    writeNormalized(date, rows, mergeApps(date, rows), { ...manifestDay, snapshotDate: date }, dataDir);
  }

  it("withholds Nov 4 → Nov 5 and shows Nov 5 → Nov 6", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-window-"));
    writeDay(dataDir, "2026-11-03", 80, manifest("2026-11-03"));
    writeDay(dataDir, "2026-11-04", 100, manifest("2026-11-04", { npm: { truncated: true } }));
    writeDay(dataDir, "2026-11-05", 140, manifest("2026-11-05"));
    writeDay(dataDir, "2026-11-06", 180, manifest("2026-11-06"));
    const agg = buildAggregate(dataDir, "fixture");
    expect(agg.meta.coreCleanByDate?.["2026-11-04"]?.clean).toBe(false);
    expect(agg.meta.coreCleanByDate?.["2026-11-04"]?.reasons).toContain("npm: truncated");
    expect(agg.meta.coreCleanByDate?.["2026-11-05"]?.clean).toBe(true);
    expect(agg.meta.coreCleanByDate?.["2026-11-06"]?.clean).toBe(true);
    expect(movers(agg, { window: "1d", metric: "npm_weekly_downloads" })).toEqual([
      expect.objectContaining({ previous: 140, current: 180, delta: 40 }),
    ]);
    const refused = JSON.parse(runTool(agg, "movers", { window: "1d", metric: "pypi_last_week_downloads" }).content[0]!.text);
    expect(refused.rows).toEqual([]);
    expect(refused.reasons).toContain("PyPI growth is disabled");
    expect(JSON.stringify(refused)).not.toMatch(/pypi_last_month|pypiLastMonth/);
  });
});
