import { describe, expect, it } from "vitest";
import {
  REFETCH_SHARE_FLOOR,
  combinedScore,
  coreClean,
  popularityWindow,
  verified_from,
} from "../../src/lib/window-guard";

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

describe("web imports the shared window guard", () => {
  it("uses one verified_from and refuses a truncated npm day", () => {
    expect(verified_from).toBe("2026-11-04");
    expect(REFETCH_SHARE_FLOOR).toBe(0.9);
    const day = coreClean(manifest({ npm: { truncated: true } }));
    expect(day.clean).toBe(false);
    expect(day.reasons).toContain("npm: truncated");
    const missing = coreClean(manifest());
    const npm = (missing as { sources?: Array<Record<string, unknown>> }).sources;
    expect(npm).toBeUndefined();
    const stripped = manifest();
    delete (stripped.sources[1] as { refetchedExisting?: number }).refetchedExisting;
    expect(coreClean(stripped).reasons).toContain("github: missing field refetchedExisting");
  });

  it("does not label a multi-day jump as 1d and excludes frozen sources from the score", () => {
    const clean = { clean: true, reasons: [] };
    const verdict = popularityWindow({
      start: "2026-11-05",
      end: "2026-11-07",
      presentDates: ["2026-11-05", "2026-11-07"],
      cleanByDate: { "2026-11-05": clean, "2026-11-07": clean },
      requested: "1d",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.dayCount).toBe(2);
    expect(verdict.missingDates).toEqual(["2026-11-06"]);
    expect(verdict.label).not.toBe("1d");
    expect(combinedScore({ github: 10, npm: 4, smithery: 99, gemini: 80, pypi: 70, pypiMonthly: 1000 })).toBe(14);
  });
});
