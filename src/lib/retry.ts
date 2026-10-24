import { SOURCE_RETRY_BASE_MS, SOURCE_RETRY_MAX_WAIT_MS } from "./config.ts";
import { sleep as defaultSleep } from "./util.ts";

export type SleepFn = (ms: number) => Promise<void>;

export function sourceRetryWaitMs(attempt: number, baseMs = SOURCE_RETRY_BASE_MS, maxMs = SOURCE_RETRY_MAX_WAIT_MS): number {
  return Math.min(maxMs, baseMs * 2 ** attempt);
}

export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  options?: {
    attempts?: number;
    sleep?: SleepFn;
    waitMs?: (attempt: number) => number;
    onRetry?: (attempt: number, error: unknown, waitMs: number) => void;
  },
): Promise<T> {
  const attempts = options?.attempts ?? 3;
  const sleep = options?.sleep ?? defaultSleep;
  const waitMs = options?.waitMs ?? sourceRetryWaitMs;
  if (attempts < 1) {
    throw new Error("retry attempts must be at least 1");
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1) {
        break;
      }
      const wait = waitMs(attempt);
      options?.onRetry?.(attempt, error, wait);
      await sleep(wait);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
