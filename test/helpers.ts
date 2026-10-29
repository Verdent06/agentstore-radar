import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchImpl } from "../src/lib/http.ts";

/** Keys that must never appear on public radar.json or MCP tool payloads. */
export const PUBLIC_USE_COUNT_KEYS = new Set(["useCount", "use_count", "u"]);

/** Recursively collect paths whose JSON key is useCount, use_count, or u. */
export function collectForbiddenPublicKeys(value: unknown, path = "$"): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...collectForbiddenPublicKeys(item, `${path}[${index}]`));
    });
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (PUBLIC_USE_COUNT_KEYS.has(key)) {
        found.push(`${path}.${key}`);
      }
      found.push(...collectForbiddenPublicKeys(child, `${path}.${key}`));
    }
  }
  return found;
}

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
