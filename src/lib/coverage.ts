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
 * Share of eligible keys that are fresh this run.
 * The numerator is a fresh-row count: `carried_forward` is not true and
 * `frozen` is not true. Unresolved GitHub repos are excluded from the
 * denominator so deleted/renamed aliases cannot inflate or deflate the metric.
 * A frozen or carried-forward row does not count, even if a live call returned it.
 */
export function computeFetchedShare(
  freshCount: number,
  eligible: number,
  unresolvedCount = 0,
  incomplete = false,
): number {
  const denom = Math.max(0, eligible) - Math.max(0, unresolvedCount);
  if (denom <= 0) {
    // A truncated or failed source with nothing resolvable is not a clean 100%.
    return incomplete ? 0 : 1;
  }
  return Math.min(1, Math.max(0, freshCount) / denom);
}

export function isFreshRow(row: { carried_forward?: boolean | null; frozen?: boolean | null }): boolean {
  return row.carried_forward !== true && row.frozen !== true;
}

export function freshRowCount(
  rows: ReadonlyArray<{ carried_forward?: boolean | null; frozen?: boolean | null }>,
): number {
  return rows.reduce((count, row) => count + (isFreshRow(row) ? 1 : 0), 0);
}

/** Manifest `fetchedShare`: fresh rows / (eligible − unresolved). */
export function freshFetchedShare(
  rows: ReadonlyArray<{ carried_forward?: boolean | null; frozen?: boolean | null }>,
  eligible: number,
  unresolvedCount = 0,
  incomplete = false,
): number {
  return computeFetchedShare(freshRowCount(rows), eligible, unresolvedCount, incomplete);
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
