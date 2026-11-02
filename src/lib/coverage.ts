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

/**
 * Share of eligible keys actually fetched live this run, including rows whose
 * value did not change and catalog rows that stay frozen/unrankable.
 * Unresolved GitHub repos are excluded from the denominator so deleted/renamed
 * aliases cannot inflate or deflate the metric. Separate from `coverage` /
 * `fresh` (carried_forward false AND not frozen).
 */
export function computeFetchedShare(fetchedThisRun: number, eligible: number, unresolvedCount = 0): number {
  const denom = Math.max(0, eligible) - Math.max(0, unresolvedCount);
  if (denom <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, fetchedThisRun) / denom);
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
