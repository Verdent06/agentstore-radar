import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKUP_CORE_SOURCES,
  decideBackupCore,
  decideIfIncompleteBackup,
  publishIfIncompleteGate,
} from "../src/lib/backup-core.ts";
import type { SnapshotManifest, SourceManifest, SourceName } from "../src/lib/schema.ts";
import { CORE_SOURCES, coreClean } from "../src/lib/window-guard.ts";

const DATE = "2026-11-21";
const COLLECTED_AT = "2026-11-21T05:41:00.000Z";
const NAMES: SourceName[] = ["mcp-registry", "smithery", "gemini-cli", "github", "npm", "pypi"];

function source(name: SourceName, extra: Partial<SourceManifest> = {}): SourceManifest {
  const row: SourceManifest = {
    source: name,
    rowCount: 10,
    skipped: false,
    failed: false,
    truncated: false,
    collectedAt: COLLECTED_AT,
    ...extra,
  };
  const core = name === "mcp-registry" || name === "github" || name === "npm";
  if (!core) {
    return row;
  }
  if (row.existingRows == null) {
    row.existingRows = 100;
  }
  if (row.refetchedExisting == null) {
    row.refetchedExisting = name === "mcp-registry" ? row.existingRows : 95;
  }
  if (row.refetchedExistingShare == null) {
    row.refetchedExistingShare = row.existingRows <= 0 ? 1 : row.refetchedExisting / row.existingRows;
  }
  if (name === "github" || name === "npm") {
    if (row.mismatchChangedNotFresh == null) {
      row.mismatchChangedNotFresh = 0;
    }
    if (row.mismatchFreshUnchanged == null) {
      row.mismatchFreshUnchanged = 4;
    }
  }
  return row;
}

function day(sources: SourceManifest[], partial: boolean): SnapshotManifest {
  return {
    snapshotDate: DATE,
    collectedAt: COLLECTED_AT,
    appCount: 1,
    sourceRowCount: sources.reduce((sum, entry) => sum + entry.rowCount, 0),
    partial,
    sources,
  };
}

function catalog(overrides: Partial<Record<SourceName, Partial<SourceManifest>>> = {}): SourceManifest[] {
  return NAMES.map((name) => source(name, overrides[name] ?? {}));
}

/** Pre-#35 manifests have no existing/refetch counts and no A/B fields. */
function legacySource(name: SourceName): SourceManifest {
  return {
    source: name,
    rowCount: 10,
    skipped: false,
    failed: false,
    truncated: false,
    collectedAt: COLLECTED_AT,
    eligibleCount: 10,
    fetchedShare: 1,
  };
}

const cases: Array<{ name: string; clean: boolean; manifest: SnapshotManifest }> = [
  {
    name: "Nov 21 final shape",
    clean: true,
    manifest: day(catalog({ npm: { fetchedShare: 1 } }), false),
  },
  {
    name: "Nov 21 first-run shape, npm truncated at 0.75 and nothing failed",
    clean: false,
    manifest: day(
      catalog({
        npm: { truncated: true, failed: false, skipped: false, fetchedShare: 0.75 },
      }),
      true,
    ),
  },
  {
    name: "smithery-only failure",
    clean: true,
    manifest: day(
      catalog({
        smithery: { failed: true, skipped: true, error: "circuit_breaker_5xx" },
      }),
      true,
    ),
  },
  {
    name: "registry share 0.999",
    clean: false,
    manifest: day(
      catalog({
        "mcp-registry": {
          existingRows: 1000,
          refetchedExisting: 999,
          refetchedExistingShare: 999 / 1000,
        },
      }),
      false,
    ),
  },
  {
    name: "github share 0.89",
    clean: false,
    manifest: day(
      catalog({
        github: {
          existingRows: 100,
          refetchedExisting: 89,
          refetchedExistingShare: 89 / 100,
          mismatchChangedNotFresh: 0,
        },
      }),
      false,
    ),
  },
  {
    name: "github A=1",
    clean: false,
    manifest: day(catalog({ github: { mismatchChangedNotFresh: 1 } }), false),
  },
  {
    name: "npm A=1",
    clean: false,
    manifest: day(catalog({ npm: { mismatchChangedNotFresh: 1 } }), false),
  },
  {
    name: "missing refetch fields (pre-#35 manifest)",
    clean: false,
    manifest: day(NAMES.map((name) => legacySource(name)), false),
  },
  {
    name: "recorded share mismatch",
    clean: false,
    manifest: day(
      catalog({
        github: {
          existingRows: 100,
          refetchedExisting: 95,
          refetchedExistingShare: 0.91,
          mismatchChangedNotFresh: 0,
        },
      }),
      false,
    ),
  },
];

describe("window guard and backup gate share one core-clean rule", () => {
  it("agrees on the same manifest fixtures (clean <=> skip)", () => {
    expect(BACKUP_CORE_SOURCES).toBe(CORE_SOURCES);
    for (const row of cases) {
      const verdict = coreClean(row.manifest);
      const decision = decideBackupCore(row.manifest);
      expect(verdict.clean, row.name).toBe(row.clean);
      expect(decision.proceed, row.name).toBe(!row.clean);
      expect(verdict.clean, row.name).toBe(!decision.proceed);
      if (row.clean) {
        expect(decision.reason, row.name).toMatch(/core sources complete/);
        expect(verdict.reasons.join(" "), row.name).not.toMatch(/mismatchFreshUnchanged/);
      }
    }

    const final = cases[0]!;
    expect(coreClean(final.manifest).mismatchFreshUnchanged).toEqual({ github: 4, npm: 4 });
    const firstRun = cases[1]!;
    expect(firstRun.manifest.sources.every((entry) => entry.failed !== true)).toBe(true);
    expect(firstRun.manifest.sources.find((entry) => entry.source === "npm")).toMatchObject({
      truncated: true,
      fetchedShare: 0.75,
    });
    expect(decideBackupCore(firstRun.manifest).reason).toMatch(/npm is truncated/);
    const mismatch = cases.find((row) => row.name === "recorded share mismatch");
    expect(coreClean(mismatch?.manifest).reasons.join(" ")).toMatch(/does not match/);
  });

  it("collects when the manifest file is missing or unparseable and does not throw", () => {
    const missingDir = mkdtempSync(join(tmpdir(), "radar-core-absent-"));
    const missing = decideIfIncompleteBackup(DATE, missingDir);
    expect(missing.proceed).toBe(true);
    expect(missing.reason).toMatch(/missing/);

    const payloads = ["{not json", "[]", '{"snapshotDate":"2026-11-21"}'];
    for (const payload of payloads) {
      const dataDir = mkdtempSync(join(tmpdir(), "radar-core-unparseable-"));
      const dayDir = join(dataDir, "normalized", DATE);
      mkdirSync(dayDir, { recursive: true });
      writeFileSync(join(dayDir, "manifest.json"), payload);
      writeFileSync(join(dayDir, "apps.ndjson"), "{}\n");
      writeFileSync(join(dayDir, "source_rows.ndjson"), "{}\n");
      const outputPath = join(dataDir, "output.txt");
      const summaryPath = join(dataDir, "summary.md");
      writeFileSync(outputPath, "");
      writeFileSync(summaryPath, "");

      let decision;
      expect(() => {
        decision = publishIfIncompleteGate(DATE, dataDir, {
          GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: summaryPath,
        });
      }).not.toThrow();
      expect(decision?.proceed).toBe(true);
      expect(decision?.reason.length).toBeGreaterThan(0);
      expect(decision?.reason).toMatch(/invalid manifest\.json|unreadable manifest|missing/);
      expect(readFileSync(outputPath, "utf8")).toBe("skip=false\n");
      expect(readFileSync(summaryPath, "utf8")).toBe("");
    }
  });
});
