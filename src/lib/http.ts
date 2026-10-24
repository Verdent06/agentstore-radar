import { HOST_MIN_INTERVAL_MS, HTTP_5XX_MAX_WAIT_MS, HTTP_MAX_RETRIES, MAX_RATE_LIMIT_WAIT_MS, USER_AGENT } from "./config.ts";
import { sleep } from "./util.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  readonly retryAfterMs?: number;
  readonly remaining?: number;
  readonly resetAt?: number;
  readonly cloudflare?: boolean;

  constructor(
    url: string,
    status: number,
    body: string,
    extra?: { retryAfterMs?: number; remaining?: number; resetAt?: number; cloudflare?: boolean },
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.url = url;
    this.status = status;
    this.body = body;
    this.retryAfterMs = extra?.retryAfterMs;
    this.remaining = extra?.remaining;
    this.resetAt = extra?.resetAt;
    this.cloudflare = extra?.cloudflare;
  }
}

export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type HttpRequestInit = RequestInit & {
  timeoutMs?: number;
  minIntervalMs?: number;
};

export interface HttpClient {
  fetchJson<T>(url: string, init?: HttpRequestInit): Promise<T>;
  fetchText(url: string, init?: HttpRequestInit): Promise<string>;
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Number(trimmed) * 1000);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return Math.max(0, parsed - nowMs);
}

export function parseRateLimitHeaders(headers: Headers): { remaining?: number; resetAt?: number } {
  const remainingRaw = headers.get("x-ratelimit-remaining");
  const resetRaw = headers.get("x-ratelimit-reset");
  const remaining = remainingRaw == null || remainingRaw === "" ? undefined : Number(remainingRaw);
  const resetSeconds = resetRaw == null || resetRaw === "" ? undefined : Number(resetRaw);
  return {
    remaining: remaining != null && Number.isFinite(remaining) ? remaining : undefined,
    resetAt: resetSeconds != null && Number.isFinite(resetSeconds) ? resetSeconds * 1000 : undefined,
  };
}

export function isCloudflareBlock(status: number, body: string, headers?: Headers): boolean {
  if (status === 1015) {
    return true;
  }
  if (headers?.get("cf-mitigated") === "challenge") {
    return true;
  }
  if (/error code:\s*1015/i.test(body)) {
    return true;
  }
  if (/rate limited by cloudflare/i.test(body)) {
    return true;
  }
  return (status === 403 || status === 429) && /cloudflare/i.test(body) && /1015|rate.?limit/i.test(body);
}

export function isRateLimited(status: number, body: string, headers?: Headers): boolean {
  if (status === 429) {
    return true;
  }
  if (isCloudflareBlock(status, body, headers)) {
    return true;
  }
  return status === 403 && /rate limit/i.test(body);
}

export function retryWaitMs(input: {
  attempt: number;
  retryAfterMs?: number;
  rateLimited: boolean;
  cloudflare: boolean;
}): number {
  if (input.retryAfterMs != null) {
    return Math.min(input.retryAfterMs, MAX_RATE_LIMIT_WAIT_MS);
  }
  if (input.cloudflare) {
    return Math.min(180_000, 15_000 * 2 ** input.attempt);
  }
  if (input.rateLimited) {
    return Math.min(180_000, 30_000 * 2 ** input.attempt);
  }
  return Math.min(HTTP_5XX_MAX_WAIT_MS, 1_000 * 2 ** input.attempt);
}

function retryAfterFromBody(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as { retry_after?: number };
    if (typeof parsed.retry_after === "number") {
      return Math.max(0, parsed.retry_after * 1000);
    }
  } catch {
    // not JSON
  }
  return undefined;
}

export function createHttpClient(options?: {
  fetchImpl?: FetchImpl;
  userAgent?: string;
  maxRetries?: number;
  defaultTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): HttpClient {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const userAgent = options?.userAgent ?? USER_AGENT;
  const maxRetries = options?.maxRetries ?? HTTP_MAX_RETRIES;
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? 30_000;
  const sleepFn = options?.sleep ?? sleep;
  const nextAllowed = new Map<string, number>();

  async function throttle(url: string, overrideMs?: number): Promise<void> {
    const host = new URL(url).host;
    const interval = overrideMs ?? HOST_MIN_INTERVAL_MS[host] ?? 100;
    const now = Date.now();
    const allowed = nextAllowed.get(host) ?? 0;
    if (now < allowed) {
      await sleepFn(allowed - now);
    }
    nextAllowed.set(host, Date.now() + interval);
  }

  function noteRateLimit(url: string, headers: Headers, retryAfterMs?: number): void {
    const host = new URL(url).host;
    const { remaining, resetAt } = parseRateLimitHeaders(headers);
    const current = nextAllowed.get(host) ?? 0;
    let next = current;
    if (remaining === 0 && resetAt != null) {
      next = Math.max(next, resetAt);
    }
    if (retryAfterMs != null && retryAfterMs > 0) {
      next = Math.max(next, Date.now() + retryAfterMs);
    }
    nextAllowed.set(host, next);
  }

  async function request(url: string, init?: HttpRequestInit): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await throttle(url, init?.minIntervalMs);
      const timeoutMs = init?.timeoutMs ?? defaultTimeoutMs;
      const headers = new Headers(init?.headers);
      if (!headers.has("user-agent")) {
        headers.set("user-agent", userAgent);
      }
      if (!headers.has("accept")) {
        headers.set("accept", "application/json");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (init?.signal) {
        init.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      try {
        const response = await fetchImpl(url, {
          ...init,
          headers,
          signal: controller.signal,
        });
        const body = await response.text();
        const rate = parseRateLimitHeaders(response.headers);
        const retryAfterMs =
          parseRetryAfterMs(response.headers.get("retry-after")) ?? retryAfterFromBody(body);
        const cloudflare = isCloudflareBlock(response.status, body, response.headers);
        noteRateLimit(url, response.headers, retryAfterMs);
        if (response.ok) {
          return body;
        }
        const rateLimited = isRateLimited(response.status, body, response.headers);
        if ((isRetryableHttpStatus(response.status) || rateLimited || cloudflare) && attempt < maxRetries) {
          const waitMs = retryWaitMs({
            attempt,
            retryAfterMs,
            rateLimited,
            cloudflare,
          });
          await sleepFn(waitMs);
          continue;
        }
        throw new HttpError(url, response.status, body.slice(0, 2000), {
          retryAfterMs,
          remaining: rate.remaining,
          resetAt: rate.resetAt,
          cloudflare,
        });
      } catch (error) {
        lastError = error;
        if (error instanceof HttpError) {
          throw error;
        }
        if (attempt < maxRetries) {
          await sleepFn(Math.min(16_000, 500 * 2 ** attempt));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    async fetchText(url: string, init?: HttpRequestInit) {
      return request(url, init);
    },
    async fetchJson<T>(url: string, init?: HttpRequestInit): Promise<T> {
      const text = await request(url, init);
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new Error(`Invalid JSON from ${url}: ${(error as Error).message}`);
      }
    },
  };
}

/** Test helper: any accidental live fetch fails immediately. */
export function denyNetworkFetch(): FetchImpl {
  return async (input) => {
    throw new Error(`Network is disabled in tests (attempted ${String(input)})`);
  };
}
