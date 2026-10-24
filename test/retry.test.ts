import { describe, expect, it } from "vitest";
import { retryAsync, sourceRetryWaitMs } from "../src/lib/retry.ts";

describe("retry helper", () => {
  it("retries with exponential backoff then succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await retryAsync(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("boom");
        }
        return "ok";
      },
      {
        attempts: 3,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(value).toBe("ok");
    expect(calls).toBe(3);
    expect(waits).toEqual([sourceRetryWaitMs(0), sourceRetryWaitMs(1)]);
  });

  it("throws the last error after exhausting attempts", async () => {
    await expect(
      retryAsync(
        async () => {
          throw new Error("still down");
        },
        { attempts: 2, sleep: async () => {} },
      ),
    ).rejects.toThrow(/still down/);
  });
});
