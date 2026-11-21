import {
  MAX_RATE_LIMIT_WAIT_MS,
  NPM_SCOPED_CONCURRENCY,
  NPM_SCOPED_MIN_INTERVAL_MS,
} from "./config.ts";
import { retryWaitMs } from "./http.ts";
import { prioritizeStalestFirst, type LastFetchedMap } from "./rolling.ts";
import type { SleepFn } from "./retry.ts";

/**
 * Scoped npm pacing, from the ubuntu-latest collect logs on 2026-11-21.
 *
 * Fresh pass, run 44846503852 job 136667408118: 10,582 scoped packages and
 * 7,160 unscoped (56 bulk requests). The first Cloudflare 429 was request 44
 * at 10.035s (4.38 req/s). Resume pass, run 44910143087 job 136864016399:
 * request 47 at 9.972s (4.71 req/s). Both runs then spent the rest of the
 * 100-minute budget in 15s/30s/60s waits (`15s * 2^attempt`, no Retry-After).
 * Merged wait on the resume was 5,543s of 6,006s (92%). Useful responses
 * landed at 35/min, so the fresh scoped catalog cannot finish at that pace.
 *
 * 43 requests succeeded inside 10s, so the trip is a short burst limit, not
 * a 50-per-minute cap. 400ms is 25 starts per 10s, under that burst. Bulk and
 * scoped share the pacer because they share the Actions IP. 10,582 + 56
 * starts at 400ms is 70.9 minutes, inside the 100-minute budget.
 *
 * The bulk downloads API still rejects scoped names (HTTP 400, probed
 * 2026-11-21). A package fetched earlier on the snapshot UTC date is already
 * fresh and is not requested again.
 */
export { NPM_SCOPED_CONCURRENCY, NPM_SCOPED_MIN_INTERVAL_MS };

export const NPM_SCOPED_WINDOW_MS = 10_000;
/** Shortest Cloudflare pause in the steady state that was followed by successes. 15s was not. */
export const NPM_SCOPED_CLOUDFLARE_BACKOFF_MS = 30_000;
export const NPM_SCOPED_CLOUDFLARE_BACKOFF_CAP_MS = 60_000;
/** One step only. A permanent drop to this gap would land the fresh catalog near 106 minutes. */
export const NPM_SCOPED_INTERVAL_STEP_MS = 200;
export const NPM_SCOPED_RECOVERY_STREAK = 50;
export const NPM_SCOPED_MEASURED_FRESH_PACKAGES = 10_582;
export const NPM_SCOPED_MEASURED_FRESH_BULK_REQUESTS = 56;
export const NPM_SCOPED_MEASURED_TRIP_REQUESTS = 44;

export function npmScopedMaxStartsPerWindow(
  intervalMs = NPM_SCOPED_MIN_INTERVAL_MS,
  windowMs = NPM_SCOPED_WINDOW_MS,
): number {
  if (intervalMs <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(1, Math.floor(windowMs / intervalMs));
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
 * Positive Retry-After is the wait, including a Cloudflare header under 15s.
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

export type NpmScopedPacer = {
  beforeRequest(): Promise<void>;
  onRateLimit(input: ScopedRateLimitInput): number;
  onSuccess(): void;
  readonly intervalMs: number;
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
  const floorMs = options.intervalMs ?? NPM_SCOPED_MIN_INTERVAL_MS;
  let intervalMs = floorMs;
  let skew = 0;
  let lastStart = Number.NEGATIVE_INFINITY;
  let holdUntil = 0;
  let widenedUntil = 0;
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
    if (t >= widenedUntil) {
      intervalMs = Math.min(floorMs + NPM_SCOPED_INTERVAL_STEP_MS, intervalMs + NPM_SCOPED_INTERVAL_STEP_MS);
      widenedUntil = t + wait;
      successStreak = 0;
    }
    return wait;
  }

  function onSuccess(): void {
    successStreak += 1;
    if (successStreak >= NPM_SCOPED_RECOVERY_STREAK && intervalMs > floorMs) {
      intervalMs = Math.max(floorMs, intervalMs - NPM_SCOPED_INTERVAL_STEP_MS);
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
  };
}
