import type { SleepFn } from "./retry.ts";

export type SharedBackoffPool = {
  acquire(): Promise<void>;
  release(): void;
  /** Every worker still waiting to start sleeps this long before the next request. */
  pauseAll(waitMs: number): void;
  readonly active: number;
};

/**
 * Bounded in-flight work with one shared backoff. A 429 calls `pauseAll`;
 * workers that have not started sleep together instead of issuing more requests.
 * `sleep` is assumed to cover `ms` of the pool clock. A test sleep that does
 * not move `now` still counts, so a frozen clock cannot spin.
 */
export function createSharedBackoffPool(
  concurrency: number,
  sleep: SleepFn,
  now: () => number = Date.now,
): SharedBackoffPool {
  const limit = Math.max(1, Math.floor(concurrency));
  let active = 0;
  let holdUntil = 0;
  let skew = 0;
  const waiters: Array<() => void> = [];

  const current = (): number => now() + skew;

  async function waitForHold(): Promise<void> {
    const start = current();
    if (start >= holdUntil) {
      return;
    }
    const wait = holdUntil - start;
    const before = now();
    await sleep(wait);
    const moved = now() - before;
    if (moved < wait) {
      skew += wait - moved;
    }
  }

  async function acquire(): Promise<void> {
    for (;;) {
      await waitForHold();
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
  }

  function release(): void {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) {
      next();
    }
  }

  function pauseAll(waitMs: number): void {
    if (waitMs <= 0) {
      return;
    }
    holdUntil = Math.max(holdUntil, current() + waitMs);
  }

  return {
    acquire,
    release,
    pauseAll,
    get active() {
      return active;
    },
  };
}
