import { describe, expect, it } from "vitest";
import {
  createHttpClient,
  denyNetworkFetch,
  fetchJsonWithRateLimitWait,
  HttpError,
  isCloudflareBlock,
  parseRateLimitHeaders,
  parseRetryAfterMs,
  retryWaitMs,
} from "../src/lib/http.ts";

describe("http client", () => {
  it("retries 403 secondary rate limits", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), {
          status: 403,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const http = createHttpClient({ fetchImpl, maxRetries: 2, sleep: async () => {} });
    await expect(http.fetchJson<{ ok: boolean }>("https://api.github.com/graphql")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("retries HTTP 500s with backoff then returns JSON", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 3) {
        return new Response(JSON.stringify({ title: "Internal Server Error", detail: "Failed to get registry list" }), {
          status: 500,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const http = createHttpClient({ fetchImpl, maxRetries: 4, sleep: async () => {} });
    await expect(http.fetchJson<{ ok: boolean }>("https://registry.modelcontextprotocol.io/v0.1/servers")).resolves.toEqual({
      ok: true,
    });
    expect(calls).toBe(3);
  });

  it("retries 429s and then returns JSON", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const http = createHttpClient({ fetchImpl, maxRetries: 2, sleep: async () => {} });
    await expect(http.fetchJson<{ ok: boolean }>("https://example.com/x")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("surfaces non-retryable HTTP errors", async () => {
    const http = createHttpClient({
      fetchImpl: async () => new Response("nope", { status: 404 }),
      maxRetries: 0,
    });
    await expect(http.fetchJson("https://example.com/missing")).rejects.toBeInstanceOf(HttpError);
  });

  it("denyNetworkFetch blocks live calls in tests", async () => {
    await expect(denyNetworkFetch()("https://example.com")).rejects.toThrow(/Network is disabled/);
  });

  it("parses Retry-After seconds and HTTP-dates", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("0")).toBe(0);
    const when = new Date(Date.now() + 5000).toUTCString();
    const wait = parseRetryAfterMs(when) ?? 0;
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(5000);
  });

  it("detects Cloudflare 1015 and GitHub rate-limit headers", () => {
    const headers = new Headers({
      "cf-mitigated": "challenge",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1700000000",
    });
    expect(isCloudflareBlock(429, "error code: 1015", headers)).toBe(true);
    expect(parseRateLimitHeaders(headers)).toEqual({ remaining: 0, resetAt: 1_700_000_000_000 });
  });

  it("retries Cloudflare 1015 then returns JSON", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("error code: 1015", {
          status: 429,
          headers: { "retry-after": "0", "cf-mitigated": "challenge" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const http = createHttpClient({ fetchImpl, maxRetries: 2, sleep: async () => {} });
    await expect(http.fetchJson<{ ok: boolean }>("https://api.npmjs.org/downloads/point/last-week/left-pad")).resolves.toEqual({
      ok: true,
    });
    expect(calls).toBe(2);
  });

  it("surfaces exhausted rate limits with retry metadata", async () => {
    const http = createHttpClient({
      fetchImpl: async () =>
        new Response("You have exceeded a secondary rate limit", {
          status: 403,
          headers: { "retry-after": "12", "x-ratelimit-remaining": "0" },
        }),
      maxRetries: 0,
    });
    await expect(http.fetchJson("https://api.github.com/graphql")).rejects.toMatchObject({
      status: 403,
      retryAfterMs: 12_000,
      remaining: 0,
    });
  });

  it("ignores Retry-After 0 for Cloudflare 429s and waits at least 15s", () => {
    expect(
      retryWaitMs({
        attempt: 0,
        retryAfterMs: 0,
        rateLimited: true,
        cloudflare: true,
      }),
    ).toBeGreaterThanOrEqual(15_000);
    expect(
      retryWaitMs({
        attempt: 0,
        retryAfterMs: 0,
        rateLimited: true,
        cloudflare: false,
      }),
    ).toBeGreaterThanOrEqual(15_000);
  });

  it("keeps retrying a 429 until the wait budget is spent, then throws", async () => {
    let calls = 0;
    const http = createHttpClient({
      fetchImpl: async () => {
        calls += 1;
        return new Response("error code: 1015", {
          status: 429,
          headers: { "retry-after": "0", "cf-mitigated": "challenge" },
        });
      },
      maxRetries: 0,
      sleep: async () => {},
    });
    await expect(
      fetchJsonWithRateLimitWait(http, "https://api.npmjs.org/downloads/point/last-week/@scope%2Fpkg", {
        sleep: async () => {},
        maxWaitMs: 45_000,
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(calls).toBeGreaterThan(1);
  });
});
