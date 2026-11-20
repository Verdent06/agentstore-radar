import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REFETCH_SHARE_FLOOR,
  combinedScore,
  coreClean,
  popularityWindow,
  verified_from,
} from "../../src/lib/window-guard.ts";

function source(name: string, overrides: Record<string, unknown> = {}) {
  return {
    source: name,
    skipped: false,
    failed: false,
    truncated: false,
    existingCount: 100,
    refetchedExisting: 95,
    A: 0,
    ...overrides,
  };
}

function manifest(overrides: Record<string, Record<string, unknown>> = {}) {
  return {
    sources: ["mcp-registry", "github", "npm"].map((name) => source(name, overrides[name] ?? {})),
  };
}

describe("mcp imports the shared window guard", () => {
  it("refuses Nov 4 npm truncated and allows a clean Nov 5 to Nov 6 window", () => {
    assert.equal(verified_from, "2026-11-04");
    assert.equal(REFETCH_SHARE_FLOOR, 0.9);
    const nov4 = coreClean(manifest({ npm: { truncated: true } }));
    assert.equal(nov4.clean, false);
    assert.ok(nov4.reasons.includes("npm: truncated"));
    const clean = { clean: true, reasons: [] as string[] };
    const allowed = popularityWindow({
      start: "2026-11-05",
      end: "2026-11-06",
      presentDates: ["2026-11-05", "2026-11-06"],
      cleanByDate: { "2026-11-05": clean, "2026-11-06": clean },
      requested: "1d",
    });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.label, "1d");
  });

  it("fails closed without refetchedExisting and keeps frozen sources out of the score", () => {
    const day = manifest();
    delete day.sources[2]!.refetchedExisting;
    const result = coreClean(day);
    assert.equal(result.clean, false);
    assert.ok(result.reasons.includes("npm: missing field refetchedExisting"));
    const low = coreClean(manifest({ github: { refetchedExisting: 85, existingCount: 100 } }));
    assert.ok(low.reasons.some((reason) => reason.includes("refetch share 0.85")));
    assert.equal(combinedScore({ github: 2, npm: 3, mcp: 4, smithery: 9, gemini: 8, pypi: 7 }), 9);
    const gap = popularityWindow({
      start: "2026-10-24",
      end: "2026-10-25",
      presentDates: ["2026-10-24", "2026-10-25"],
      cleanByDate: {
        "2026-10-24": { clean: true, reasons: [] },
        "2026-10-25": { clean: true, reasons: [] },
      },
      requested: "1d",
    });
    assert.equal(gap.allowed, false);
    assert.ok(gap.reasons.some((reason) => reason.includes("2026-10-24") && reason.includes(verified_from)));
    const jump = popularityWindow({
      start: "2026-11-05",
      end: "2026-11-07",
      presentDates: ["2026-11-05", "2026-11-07"],
      cleanByDate: {
        "2026-11-05": { clean: true, reasons: [] },
        "2026-11-07": { clean: true, reasons: [] },
      },
      requested: "7d",
    });
    assert.equal(jump.label, "2d");
    assert.notEqual(jump.label, "1d");
    assert.deepEqual(jump.missingDates, ["2026-11-06"]);
  });
});
