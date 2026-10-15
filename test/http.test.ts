import { describe, expect, it } from "vitest";
import { createHttpClient, denyNetworkFetch, HttpError } from "../src/lib/http.ts";

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
    const http = createHttpClient({ fetchImpl, maxRetries: 2 });
    await expect(http.fetchJson<{ ok: boolean }>("https://api.github.com/graphql")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
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
    const http = createHttpClient({ fetchImpl, maxRetries: 2 });
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
});
