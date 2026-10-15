export const DEFAULT_LOW_COVERAGE_THRESHOLD = 0.7;

export type CoverageStats = {
  eligible: number;
  fetched: number;
  coverage: number;
};

export function computeCoverage(eligible: number, fetched: number): CoverageStats {
  const safeEligible = Math.max(0, eligible);
  const safeFetched = Math.max(0, fetched);
  return {
    eligible: safeEligible,
    fetched: safeFetched,
    coverage: safeEligible === 0 ? 1 : safeFetched / safeEligible,
  };
}

export function isLowCoverage(coverage: number | undefined, eligible = 0, threshold = DEFAULT_LOW_COVERAGE_THRESHOLD): boolean {
  if (coverage == null || eligible <= 0) {
    return false;
  }
  return coverage < threshold;
}

export function formatCoveragePct(coverage: number | undefined): string {
  if (coverage == null || Number.isNaN(coverage)) {
    return "n/a";
  }
  return `${(coverage * 100).toFixed(1)}%`;
}
