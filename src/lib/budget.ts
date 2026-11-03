import { sourceBudgetMs, type BudgetSourceName } from "./config.ts";

export type MonotonicClock = () => number;

export type SourceBudget = {
  source: BudgetSourceName;
  budgetMs: number;
  startedAtMs: number;
  now: MonotonicClock;
};

export function startBudget(
  source: BudgetSourceName,
  budgetMs: number,
  now: MonotonicClock = Date.now,
): SourceBudget {
  return { source, budgetMs, startedAtMs: now(), now };
}

export function openSourceBudget(
  env: NodeJS.ProcessEnv,
  source: BudgetSourceName,
  now: MonotonicClock = Date.now,
): SourceBudget {
  return startBudget(source, sourceBudgetMs(env, source), now);
}

export function budgetElapsedMs(budget: SourceBudget): number {
  return Math.max(0, budget.now() - budget.startedAtMs);
}

export function budgetRemainingMs(budget: SourceBudget): number {
  return Math.max(0, budget.budgetMs - budgetElapsedMs(budget));
}

export function budgetExhausted(budget: SourceBudget): boolean {
  return budgetElapsedMs(budget) >= budget.budgetMs;
}

/**
 * Real-time deadline for HTTP sleeps. Remaining budget comes from the source
 * clock; the deadline itself is Date.now()-based because the HTTP client is.
 */
export function budgetDeadlineMs(budget: SourceBudget, nowMs = Date.now()): number {
  return nowMs + budgetRemainingMs(budget);
}

export function budgetExhaustedError(budget: SourceBudget, where?: string): Error {
  const minutes = Math.round(budget.budgetMs / 60_000);
  const place = where ? ` (${where})` : "";
  return new Error(`${budget.source} wall-clock budget of ${minutes}m exhausted${place}`);
}

export function isBudgetExhaustedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("wall-clock budget");
}

/** Reuse the budget collect() opened for this source so a retry cannot restart the clock. */
export function adoptSourceBudget(
  ctx: { env: NodeJS.ProcessEnv; monotonicNow?: MonotonicClock; budget?: SourceBudget },
  source: BudgetSourceName,
): SourceBudget {
  if (ctx.budget?.source === source) {
    return ctx.budget;
  }
  return openSourceBudget(ctx.env, source, ctx.monotonicNow ?? Date.now);
}
