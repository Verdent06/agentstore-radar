/**
 * Times the production npm bulk, npm scoped, and PyPI paths.
 * Prints one NPM_LANE_TIMING JSON line. Does not write a data repo.
 * CI runs this on a GitHub-hosted runner; it is not a collect.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmAdapter } from "../src/adapters/npm.ts";
import { pypiAdapter } from "../src/adapters/pypi.ts";
import { createDiscoveredRefs } from "../src/adapters/types.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { createLogger } from "../src/lib/logger.ts";
import type { SourceLane } from "../src/lib/schema.ts";

const CATALOG_UNSCOPED = 6495;
const CATALOG_SCOPED = 8089;
const CATALOG_PYPI = 4915;
const BULK_SAMPLE = 128;
const SCOPED_SAMPLE = 32;
const PYPI_SAMPLE = 40;

const pypiPackages = [
  "mcp",
  "fastmcp",
  "requests",
  "urllib3",
  "certifi",
  "charset-normalizer",
  "idna",
  "pip",
  "setuptools",
  "wheel",
  "numpy",
  "pandas",
  "flask",
  "django",
  "fastapi",
  "uvicorn",
  "pydantic",
  "httpx",
  "aiohttp",
  "boto3",
  "cryptography",
  "pyyaml",
  "click",
  "rich",
  "typer",
  "sqlalchemy",
  "alembic",
  "pytest",
  "black",
  "ruff",
  "mypy",
  "virtualenv",
  "packaging",
  "six",
  "python-dateutil",
  "tqdm",
  "pillow",
  "scipy",
  "starlette",
  "anyio",
];

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

function pypiExtrapolatedMs(lane: { durationMs: number } | undefined, sample: number): number | null {
  if (!lane || sample <= 0 || lane.durationMs <= 0) {
    return null;
  }
  return Math.round((lane.durationMs / sample) * CATALOG_PYPI);
}

type PypiLane = {
  lane: "pypi";
  path: "single";
  requests: number;
  fetched: number;
  notFound: number;
  rateLimits: number;
  durationMs: number;
  fetchedThisRun: number;
  truncated: boolean;
  error: string | null;
};

async function timePypi(names: string[]): Promise<PypiLane> {
  let requests = 0;
  let rateLimits = 0;
  let notFound = 0;
  const http = createHttpClient({
    fetchImpl: async (input, init) => {
      requests += 1;
      const response = await fetch(input, init);
      if (response.status === 429) {
        rateLimits += 1;
      }
      if (response.status === 404) {
        notFound += 1;
      }
      return response;
    },
  });
  const dataDir = mkdtempSync(join(tmpdir(), "radar-pypi-lanes-"));
  const discovered = createDiscoveredRefs();
  for (const name of names) {
    discovered.pypiPackages.add(name);
  }
  const now = new Date();
  const started = Date.now();
  const result = await pypiAdapter.collect({
    snapshotDate: now.toISOString().slice(0, 10),
    collectedAt: now.toISOString(),
    now,
    dataDir,
    env: { RADAR_PYPI_BUDGET_MS: String(8 * 60 * 1000) },
    http,
    log: createLogger(),
    discovered,
  });
  return {
    lane: "pypi",
    path: "single",
    requests,
    fetched: result.fetchedThisRunCount ?? 0,
    notFound,
    rateLimits,
    durationMs: Date.now() - started,
    fetchedThisRun: result.fetchedThisRunCount ?? 0,
    truncated: result.truncated === true,
    error: result.error ?? null,
  };
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
  const pypi = await timePypi(pypiPackages.slice(0, PYPI_SAMPLE));
  const report = {
    measuredOn: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "other",
    elapsedMs: Date.now() - started,
    sample: { unscoped: unscoped.length, scoped: scoped.length, pypi: pypiPackages.slice(0, PYPI_SAMPLE).length },
    lanes,
    pypi,
    fetchedThisRun: result.fetchedThisRunCount ?? 0,
    truncated: result.truncated === true,
    error: result.error ?? null,
    extrapolatedFullCatalogMs: {
      catalogUnscoped: CATALOG_UNSCOPED,
      catalogScoped: CATALOG_SCOPED,
      catalogPypi: CATALOG_PYPI,
      bulkMs: bulkExtrapolatedMs(bulk, unscoped.length),
      scopedMs: scopedExtrapolatedMs(scopedLane, scoped.length),
      pypiMs: pypiExtrapolatedMs(pypi, pypiPackages.slice(0, PYPI_SAMPLE).length),
      npmParallelMs: Math.max(bulkExtrapolatedMs(bulk, unscoped.length) ?? 0, scopedExtrapolatedMs(scopedLane, scoped.length) ?? 0),
    },
  };
  console.log(`NPM_LANE_TIMING ${JSON.stringify(report)}`);
}

main().catch((error: unknown) => {
  console.log(`NPM_LANE_TIMING ${JSON.stringify({ measuredOn: "error", error: String(error) })}`);
});
