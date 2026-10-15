import { describe, expect, it } from "vitest";
import { computeCoverage, formatCoveragePct, isLowCoverage } from "../src/lib/coverage.ts";

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
