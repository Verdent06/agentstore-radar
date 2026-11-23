import { NPM_COLLECT_BUDGET_MS } from "./config.ts";
import type { SnapshotManifest } from "./schema.ts";
import { coreClean } from "./window-guard.ts";

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

/**
 * npm-lane reasons from the shared `coreClean` rule. GitHub or mcp-registry
 * failures do not count. A missing manifest does.
 */
export function npmCoreCleanReasons(manifest: SnapshotManifest | null | undefined): string[] {
  if (!manifest || !Array.isArray(manifest.sources)) {
    return ["npm: missing source"];
  }
  const reasons = coreClean(manifest).reasons;
  if (reasons.some((reason) => reason === "missing field sources")) {
    return ["npm: missing source"];
  }
  return reasons.filter((reason) => reason.startsWith("npm:"));
}

/** True when `coreClean` has an npm reason. A core-clean npm source is left alone. */
export function npmSourceNeedsRecovery(manifest: SnapshotManifest | null | undefined): boolean {
  return npmCoreCleanReasons(manifest).length > 0;
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
  const npmReasons = npmCoreCleanReasons(input.manifest);
  if (npmReasons.length === 0) {
    return {
      run: false,
      budgetMs: 0,
      reason: "npm is already core-clean",
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
  return { run: true, budgetMs, reason: npmReasons.join("; ") };
}
