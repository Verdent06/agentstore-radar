import { HOST_MIN_INTERVAL_MS, USER_AGENT } from "./config.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(url: string, status: number, body: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.url = url;
    this.status = status;
    this.body = body;
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

const RETRYABLE = new Set([429, 502, 503, 504]);

function isRateLimited(status: number, body: string): boolean {
  if (status === 429) {
    return true;
  }
  return status === 403 && /rate limit/i.test(body);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHttpClient(options?: {
  fetchImpl?: FetchImpl;
  userAgent?: string;
  maxRetries?: number;
  defaultTimeoutMs?: number;
}): HttpClient {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const userAgent = options?.userAgent ?? USER_AGENT;
  const maxRetries = options?.maxRetries ?? 5;
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? 30_000;
  const nextAllowed = new Map<string, number>();

  async function throttle(url: string, overrideMs?: number): Promise<void> {
    const host = new URL(url).host;
    const interval = overrideMs ?? HOST_MIN_INTERVAL_MS[host] ?? 100;
    const now = Date.now();
    const allowed = nextAllowed.get(host) ?? 0;
    if (now < allowed) {
      await sleep(allowed - now);
    }
    nextAllowed.set(host, Date.now() + interval);
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
        if (response.ok) {
          return body;
        }
        if ((RETRYABLE.has(response.status) || isRateLimited(response.status, body)) && attempt < maxRetries) {
          const retryAfterHeader = Number(response.headers.get("retry-after"));
          let retryAfterBody = Number.NaN;
          try {
            const parsed = JSON.parse(body) as { retry_after?: number };
            if (typeof parsed.retry_after === "number") {
              retryAfterBody = parsed.retry_after;
            }
          } catch {
            // not JSON
          }
          const retryAfter = Number.isFinite(retryAfterHeader) ? retryAfterHeader : retryAfterBody;
          const waitMs = Number.isFinite(retryAfter)
            ? retryAfter * 1000
            : isRateLimited(response.status, body)
              ? Math.min(180_000, 30_000 * 2 ** attempt)
              : Math.min(16_000, 500 * 2 ** attempt);
          await sleep(waitMs);
          continue;
        }
        throw new HttpError(url, response.status, body.slice(0, 2000));
      } catch (error) {
        lastError = error;
        if (error instanceof HttpError) {
          throw error;
        }
        if (attempt < maxRetries) {
          await sleep(Math.min(16_000, 500 * 2 ** attempt));
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
