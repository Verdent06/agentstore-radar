/**
 * Times the production npm bulk and scoped paths against api.npmjs.org.
 * Prints one NPM_LANE_TIMING JSON line. Does not write a data repo.
 * CI runs this on a GitHub-hosted runner; it is not a collect.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmAdapter } from "../src/adapters/npm.ts";
import { createDiscoveredRefs } from "../src/adapters/types.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { createLogger } from "../src/lib/logger.ts";
import type { SourceLane } from "../src/lib/schema.ts";

const CATALOG_UNSCOPED = 6495;
const CATALOG_SCOPED = 8089;
const BULK_SAMPLE = 128;
const SCOPED_SAMPLE = 32;

const fallbackUnscoped = ["lodash", "express", "react", "vue", "next", "typescript", "zod", "vitest"];
const fallbackScoped = ["@types/node", "@modelcontextprotocol/sdk"];

async function searchNames(text: string, size: number): Promise<string[]> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    return [];
  }
  const body = (await response.json()) as { objects?: Array<{ package?: { name?: string } }> };
  return (body.objects ?? [])
    .map((row) => row.package?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

function bulkExtrapolatedMs(lane: SourceLane | undefined, sample: number): number | null {
  if (!lane || lane.requests <= 0 || sample <= 0 || lane.durationMs <= 0) {
    return null;
  }
  const namesPerRequest = Math.max(1, Math.round(sample / lane.requests));
  const catalogRequests = Math.ceil(CATALOG_UNSCOPED / namesPerRequest);
  return Math.round((lane.durationMs / lane.requests) * catalogRequests);
}

function scopedExtrapolatedMs(lane: SourceLane | undefined, sample: number): number | null {
  if (!lane || sample <= 0 || lane.durationMs <= 0) {
    return null;
  }
  return Math.round((lane.durationMs / sample) * CATALOG_SCOPED);
}

async function main(): Promise<void> {
  const started = Date.now();
  let unscoped: string[] = [];
  let scoped: string[] = [];
  try {
    const [mcp, scopedA, scopedB] = await Promise.all([
      searchNames("mcp", 250),
      searchNames("@modelcontextprotocol", 20),
      searchNames("@anthropic-ai", 20),
    ]);
    unscoped = unique(mcp.filter((name) => !name.startsWith("@"))).slice(0, BULK_SAMPLE);
    scoped = unique([...scopedA, ...scopedB].filter((name) => name.startsWith("@"))).slice(0, SCOPED_SAMPLE);
  } catch (error) {
    console.error(String(error));
  }
  if (unscoped.length === 0) {
    unscoped = fallbackUnscoped;
  }
  if (scoped.length === 0) {
    scoped = fallbackScoped;
  }

  const dataDir = mkdtempSync(join(tmpdir(), "radar-npm-lanes-"));
  const discovered = createDiscoveredRefs();
  for (const name of [...unscoped, ...scoped]) {
    discovered.npmPackages.add(name);
  }
  const now = new Date();
  const result = await npmAdapter.collect({
    snapshotDate: now.toISOString().slice(0, 10),
    collectedAt: now.toISOString(),
    now,
    dataDir,
    env: { RADAR_NPM_BUDGET_MS: String(8 * 60 * 1000) },
    http: createHttpClient(),
    log: createLogger(),
    discovered,
  });
  const lanes = result.lanes ?? [];
  const bulk = lanes.find((lane) => lane.lane === "bulk");
  const scopedLane = lanes.find((lane) => lane.lane === "scoped");
  const report = {
    measuredOn: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "other",
    elapsedMs: Date.now() - started,
    sample: { unscoped: unscoped.length, scoped: scoped.length },
    lanes,
    fetchedThisRun: result.fetchedThisRunCount ?? 0,
    truncated: result.truncated === true,
    error: result.error ?? null,
    extrapolatedFullCatalogMs: {
      catalogUnscoped: CATALOG_UNSCOPED,
      catalogScoped: CATALOG_SCOPED,
      bulkMs: bulkExtrapolatedMs(bulk, unscoped.length),
      scopedMs: scopedExtrapolatedMs(scopedLane, scoped.length),
    },
  };
  console.log(`NPM_LANE_TIMING ${JSON.stringify(report)}`);
}

main().catch((error: unknown) => {
  console.log(`NPM_LANE_TIMING ${JSON.stringify({ measuredOn: "error", error: String(error) })}`);
});
