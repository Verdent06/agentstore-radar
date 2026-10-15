import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchImpl } from "../src/lib/http.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as T;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function fixtureFetch(routes: Array<{ match: RegExp | string; body: unknown; status?: number }>): FetchImpl {
  return async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;
    for (const route of routes) {
      const hit = typeof route.match === "string" ? url.includes(route.match) : route.match.test(`${method} ${url}`) || route.match.test(url);
      if (hit) {
        return jsonResponse(route.body, route.status ?? 200);
      }
    }
    throw new Error(`Unexpected fetch in test: ${key}`);
  };
}
