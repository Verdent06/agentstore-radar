import { describe, expect, it } from "vitest";
import { computeCoverage, computeFetchedShare, freshFetchedShare, formatCoveragePct, isLowCoverage } from "../src/lib/coverage.ts";

describe("coverage", () => {
  it("is 1 when nothing is eligible", () => {
    expect(computeCoverage(0, 0)).toEqual({ eligible: 0, fetched: 0, coverage: 1 });
  });

  it("is fetched/eligible otherwise", () => {
    expect(computeCoverage(10, 7).coverage).toBeCloseTo(0.7);
    expect(formatCoveragePct(0.834)).toBe("83.4%");
    expect(formatCoveragePct(undefined)).toBe("n/a");
  });

  it("flags coverage below 70% only when there are eligible keys", () => {
    expect(isLowCoverage(0.69, 100)).toBe(true);
    expect(isLowCoverage(0.7, 100)).toBe(false);
    expect(isLowCoverage(0, 0)).toBe(false);
    expect(isLowCoverage(undefined, 50)).toBe(false);
  });
});

describe("fetchedShare", () => {
  it("is fetchedThisRun / (eligible - unresolved)", () => {
    expect(computeFetchedShare(136, 31_799, 3_864)).toBeCloseTo(136 / (31_799 - 3_864));
    expect(computeFetchedShare(1_412, 13_835)).toBeCloseTo(1_412 / 13_835);
    expect(computeFetchedShare(22_348, 27_935)).toBeCloseTo(0.8);
  });

  it("is 1 when the resolvable set is empty", () => {
    expect(computeFetchedShare(0, 0)).toBe(1);
    expect(computeFetchedShare(0, 3_864, 3_864)).toBe(1);
  });

  it("is 0 for a truncated or failed source whose denominator is empty", () => {
    expect(computeFetchedShare(0, 0, 0, true)).toBe(0);
    expect(computeFetchedShare(0, 4, 4, true)).toBe(0);
    expect(computeFetchedShare(0, 0, 0, false)).toBe(1);
  });

  it("does not count unresolved GitHub repos as fetched", () => {
    expect(computeFetchedShare(0, 1, 1)).toBe(1);
    expect(computeFetchedShare(100, 200, 50)).toBeCloseTo(100 / 150);
  });

  it("counts an unchanged live fetch in the numerator when that row is fresh", () => {
    expect(computeFetchedShare(1, 1)).toBe(1);
    expect(computeFetchedShare(1, 2)).toBe(0.5);
  });

  it("scores frozen and carried-forward rows as not fetched", () => {
    const rows = [
      { carried_forward: true, frozen: true },
      { carried_forward: false, frozen: true },
      { carried_forward: true, frozen: false },
      { carried_forward: false, frozen: false },
    ];
    expect(freshFetchedShare(rows, rows.length)).toBeCloseTo(0.25);
    expect(freshFetchedShare([{ carried_forward: true, frozen: true }], 4)).toBe(0);
  });
});
