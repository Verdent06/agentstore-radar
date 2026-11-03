import { describe, expect, it } from "vitest";
import { createSharedBackoffPool } from "../src/lib/pool.ts";
import type { SleepFn } from "../src/lib/retry.ts";

describe("shared backoff pool", () => {
  it("keeps 4-8 in-flight requests bounded and pauses every waiter on one 429", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const sleep: SleepFn = async (ms) => {
      sleeps.push(ms);
      now += ms;
    };
    const concurrency = 4;
    const pool = createSharedBackoffPool(concurrency, sleep, () => now);
    const inFlightAtStart: number[] = [];

    for (let index = 0; index < concurrency; index += 1) {
      await pool.acquire();
      inFlightAtStart.push(pool.active);
    }
    expect(pool.active).toBe(concurrency);
    expect(Math.max(...inFlightAtStart)).toBeLessThanOrEqual(concurrency);

    const retryAfterMs = 5_000;
    pool.pauseAll(retryAfterMs);

    let startedAfterPause = 0;
    const extras = [0, 1, 2, 3].map(async () => {
      await pool.acquire();
      startedAfterPause += 1;
      expect(pool.active).toBeLessThanOrEqual(concurrency);
      pool.release();
    });

    await Promise.resolve();
    expect(startedAfterPause).toBe(0);
    expect(pool.active).toBe(concurrency);

    for (let index = 0; index < concurrency; index += 1) {
      pool.release();
    }
    await Promise.all(extras);

    expect(startedAfterPause).toBe(4);
    expect(sleeps.some((ms) => ms === retryAfterMs)).toBe(true);
    expect(pool.active).toBe(0);
    expect(Math.max(...inFlightAtStart, concurrency)).toBeLessThanOrEqual(8);
  });
});
