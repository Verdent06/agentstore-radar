import { NPM_COLLECT_BUDGET_MS } from "./config.ts";
import type { SnapshotManifest, SourceManifest } from "./schema.ts";

/**
 * Reserved after the npm lane stops so the process can write the snapshot
 * and the push step can finish. The collect step timeout is 340 minutes and
 * the job timeout is 360, so this 15-minute margin fits in the 20 minutes
 * the job keeps outside that step.
 */
export const NPM_RECOVERY_MARGIN_MS = 15 * 60 * 1000;
export const COLLECT_JOB_TIMEOUT_MS = 360 * 60 * 1000;
export const COLLECT_STEP_TIMEOUT_MS = 340 * 60 * 1000;

/** UTC midnight that ends `nowMs`'s calendar day. */
export function nextUtcMidnightMs(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

/**
 * Budget for an npm lane that runs inside a collect job after the other sources.
 * The lesser of the configured budget, the time left before 00:00 UTC, and the
 * time left before the step is killed, each minus {@link NPM_RECOVERY_MARGIN_MS}.
 */
export function npmRecoveryBudgetMs(input: {
  nowMs: number;
  configuredBudgetMs?: number;
  marginMs?: number;
  midnightMs?: number;
  jobDeadlineMs?: number;
}): number {
  const marginMs = input.marginMs ?? NPM_RECOVERY_MARGIN_MS;
  const midnightMs = input.midnightMs ?? nextUtcMidnightMs(input.nowMs);
  const caps = [
    input.configuredBudgetMs ?? NPM_COLLECT_BUDGET_MS,
    midnightMs - input.nowMs - marginMs,
  ];
  if (input.jobDeadlineMs != null) {
    caps.push(input.jobDeadlineMs - input.nowMs - marginMs);
  }
  return Math.max(0, Math.floor(Math.min(...caps)));
}

/** Missing, failed, skipped, or truncated npm needs another lane. A finished npm source does not. */
export function npmSourceNeedsRecovery(manifest: SnapshotManifest | null | undefined): boolean {
  if (!manifest) {
    return true;
  }
  const npm = manifest.sources.find((source) => source.source === "npm");
  if (!npm) {
    return true;
  }
  return npmNeedsRecovery(npm);
}

function npmNeedsRecovery(source: SourceManifest): boolean {
  return source.truncated === true || source.failed === true || source.skipped === true;
}

export type NpmRecoveryDecision = {
  run: boolean;
  budgetMs: number;
  reason: string;
};

export function decideNpmRecovery(input: {
  manifest: SnapshotManifest | null | undefined;
  nowMs: number;
  configuredBudgetMs?: number;
  marginMs?: number;
  midnightMs?: number;
  jobDeadlineMs?: number;
}): NpmRecoveryDecision {
  if (!npmSourceNeedsRecovery(input.manifest)) {
    return {
      run: false,
      budgetMs: 0,
      reason: "npm is already complete and untruncated",
    };
  }
  const budgetMs = npmRecoveryBudgetMs(input);
  if (budgetMs < 1) {
    return {
      run: false,
      budgetMs: 0,
      reason: "not enough time before 00:00 UTC and the job timeout to keep the safety margin",
    };
  }
  const why = input.manifest?.sources.some((source) => source.source === "npm")
    ? "npm is truncated or failed"
    : "npm is missing";
  return { run: true, budgetMs, reason: why };
}
