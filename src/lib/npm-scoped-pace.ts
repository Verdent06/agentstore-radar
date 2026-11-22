import {
  MAX_RATE_LIMIT_WAIT_MS,
  NPM_SCOPED_CONCURRENCY,
  NPM_SCOPED_MIN_INTERVAL_MS,
} from "./config.ts";
import { retryWaitMs } from "./http.ts";
import { prioritizeStalestFirst, type LastFetchedMap } from "./rolling.ts";
import type { SleepFn } from "./retry.ts";

/**
 * Scoped npm pacing, from the 2026-11-22 collect logs on the 400ms pacer.
 *
 * Runs 45028304407 and 45044927456 (and the 2026-11-21 runs of the same
 * pacer) accepted about 0.55 requests/s. After the first Cloudflare 429 the
 * gap widened once to 600ms and never recovered, then a 429 arrived about
 * every 44s. Each one waited exactly 30s because the response had no positive
 * Retry-After. About two thirds of the 100-minute budget was that sleep.
 * A cold start still accepted ~42 requests; after each 30s quiet only ~24
 * more were accepted. 1.8s is one request per 1.8s, the smooth rate those
 * logs actually got accepted (about 33 per minute).
 *
 * On a 429 the interval is multiplied by 1.5 and that value becomes the
 * floor for the rest of the run. A long clean streak may shorten the gap by
 * one small step, and it cannot go under the floor set by the last 429.
 * Bulk downloads share this start gate. They still go out in batches of 128.
 */
export { NPM_SCOPED_CONCURRENCY, NPM_SCOPED_MIN_INTERVAL_MS };

export const NPM_SCOPED_WINDOW_MS = 10_000;
/** Shortest Cloudflare pause in the steady state that was followed by successes. */
export const NPM_SCOPED_CLOUDFLARE_BACKOFF_MS = 30_000;
export const NPM_SCOPED_CLOUDFLARE_BACKOFF_CAP_MS = 60_000;
/** Multiplicative slowdown applied on every 429. The result is the new floor. */
export const NPM_SCOPED_SLOWDOWN = 1.5;
/** Added back only while the interval is still above the last-429 floor. */
export const NPM_SCOPED_RECOVERY_STEP_MS = 100;
/** About three and a half minutes at the 1.8s start, longer once slowed. */
export const NPM_SCOPED_RECOVERY_STREAK = 120;
export const NPM_SCOPED_MEASURED_FRESH_PACKAGES = 10_602;
export const NPM_SCOPED_MEASURED_FRESH_BULK_REQUESTS = 61;

export function npmScopedMaxStartsPerWindow(
  intervalMs = NPM_SCOPED_MIN_INTERVAL_MS,
  windowMs = NPM_SCOPED_WINDOW_MS,
): number {
  if (intervalMs <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  // ceil so a 1.8s gap is not stretched by a 10s window that holds one fewer start.
  return Math.max(1, Math.ceil(windowMs / intervalMs));
}

/** Wall time from the first start to the last, when every start keeps `intervalMs`. */
export function npmScopedFinishMs(requests: number, intervalMs = NPM_SCOPED_MIN_INTERVAL_MS): number {
  if (requests <= 1) {
    return 0;
  }
  return (requests - 1) * intervalMs;
}

export type ScopedRateLimitInput = {
  attempt: number;
  retryAfterMs?: number;
  cloudflare: boolean;
};

/**
 * Positive Retry-After is the wait, including a value under 30s.
 * A missing or zero header on Cloudflare waits 30s, then 60s. Other 429s keep
 * the shared retry schedule.
 */
export function scopedRateLimitWaitMs(input: ScopedRateLimitInput): number {
  const header = input.retryAfterMs != null && input.retryAfterMs > 0 ? input.retryAfterMs : undefined;
  if (header != null) {
    return Math.min(header, MAX_RATE_LIMIT_WAIT_MS);
  }
  if (input.cloudflare) {
    const backoff = Math.min(
      NPM_SCOPED_CLOUDFLARE_BACKOFF_CAP_MS,
      NPM_SCOPED_CLOUDFLARE_BACKOFF_MS * 2 ** input.attempt,
    );
    return Math.min(backoff, MAX_RATE_LIMIT_WAIT_MS);
  }
  return retryWaitMs({
    attempt: input.attempt,
    retryAfterMs: input.retryAfterMs,
    rateLimited: true,
    cloudflare: false,
  });
}

/** Oldest last_fetched first. Missing stamps lead. Equal stamps keep a higher score first. */
export function orderNpmScopedNames(
  names: string[],
  lastFetched: LastFetchedMap,
  scoreOf?: (name: string) => number,
): string[] {
  return prioritizeStalestFirst(names, lastFetched, scoreOf);
}

export type NpmHalt = "budget" | "midnight";

export function formatNpmLaneSummary(input: {
  durationMs: number;
  scopedRequests: number;
  rateLimits: number;
  halt?: NpmHalt;
}): string {
  const minutes = input.durationMs / 60_000;
  const perMinute = minutes > 0 ? input.scopedRequests / minutes : 0;
  const stop =
    input.halt === "budget"
      ? "hit the wall-clock budget"
      : input.halt === "midnight"
        ? "hit the UTC midnight stop"
        : "finished inside the budget and the UTC day";
  return [
    "### npm lane",
    "",
    `- Wall-clock minutes: ${minutes.toFixed(1)}`,
    `- Scoped requests per minute: ${perMinute.toFixed(2)}`,
    `- 429 count: ${input.rateLimits}`,
    `- Stop: ${stop}`,
    "",
  ].join("\n");
}

export type NpmScopedPacer = {
  beforeRequest(): Promise<void>;
  onRateLimit(input: ScopedRateLimitInput): number;
  onSuccess(): void;
  readonly intervalMs: number;
  readonly floorMs: number;
};

/**
 * One start queue for every npm downloads request. A frozen test clock still
 * advances: sleep that does not move `now` is counted, so the loop cannot spin.
 */
export function createNpmScopedPacer(options: {
  sleep: SleepFn;
  now?: () => number;
  intervalMs?: number;
  windowMs?: number;
}): NpmScopedPacer {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? NPM_SCOPED_WINDOW_MS;
  const startMs = options.intervalMs ?? NPM_SCOPED_MIN_INTERVAL_MS;
  let intervalMs = startMs;
  let floorMs = startMs;
  let skew = 0;
  let lastStart = Number.NEGATIVE_INFINITY;
  let holdUntil = 0;
  let successStreak = 0;
  const starts: number[] = [];
  let tail: Promise<void> = Promise.resolve();

  const current = (): number => now() + skew;

  async function sleepForward(wait: number): Promise<void> {
    const before = now();
    await options.sleep(wait);
    const moved = now() - before;
    if (moved < wait) {
      skew += wait - moved;
    }
  }

  async function reserve(): Promise<void> {
    for (;;) {
      const t = current();
      let wait = 0;
      if (t < holdUntil) {
        wait = holdUntil - t;
      }
      if (t - lastStart < intervalMs) {
        wait = Math.max(wait, intervalMs - (t - lastStart));
      }
      const recent = starts.filter((start) => t - start < windowMs);
      const maxPerWindow = npmScopedMaxStartsPerWindow(intervalMs, windowMs);
      if (recent.length >= maxPerWindow) {
        const oldest = recent[0] ?? t;
        wait = Math.max(wait, windowMs - (t - oldest));
      }
      if (wait <= 0) {
        starts.push(t);
        lastStart = t;
        while (starts.length > 0 && t - starts[0]! >= windowMs) {
          starts.shift();
        }
        return;
      }
      await sleepForward(wait);
    }
  }

  function beforeRequest(): Promise<void> {
    const run = tail.then(() => reserve());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function onRateLimit(input: ScopedRateLimitInput): number {
    const wait = scopedRateLimitWaitMs(input);
    const t = current();
    holdUntil = Math.max(holdUntil, t + wait);
    intervalMs = Math.round(intervalMs * NPM_SCOPED_SLOWDOWN);
    floorMs = intervalMs;
    successStreak = 0;
    return wait;
  }

  function onSuccess(): void {
    successStreak += 1;
    if (successStreak >= NPM_SCOPED_RECOVERY_STREAK && intervalMs > floorMs) {
      intervalMs = Math.max(floorMs, intervalMs - NPM_SCOPED_RECOVERY_STEP_MS);
      successStreak = 0;
    }
  }

  return {
    beforeRequest,
    onRateLimit,
    onSuccess,
    get intervalMs() {
      return intervalMs;
    },
    get floorMs() {
      return floorMs;
    },
  };
}
