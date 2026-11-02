import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collect } from "../src/commands/collect.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { dataPaths } from "../src/lib/io.ts";
import type { Logger } from "../src/lib/logger.ts";
import { fixtureFetch } from "./helpers.ts";

const DATE = "2026-11-02";

type FailFn = "linkCrossStore" | "ownerDecisionCounts" | "tieDecidedPackageOwners";

const linker: { fail: FailFn | null } = { fail: null };

vi.mock("../src/lib/matching.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/matching.ts")>();
  return {
    ...actual,
    linkCrossStore: (...args: Parameters<typeof actual.linkCrossStore>) => {
      if (linker.fail === "linkCrossStore") {
        throw new Error("linkCrossStore failed");
      }
      return actual.linkCrossStore(...args);
    },
    ownerDecisionCounts: (...args: Parameters<typeof actual.ownerDecisionCounts>) => {
      if (linker.fail === "ownerDecisionCounts") {
        throw new Error("ownerDecisionCounts failed");
      }
      return actual.ownerDecisionCounts(...args);
    },
    tieDecidedPackageOwners: (...args: Parameters<typeof actual.tieDecidedPackageOwners>) => {
      if (linker.fail === "tieDecidedPackageOwners") {
        throw new Error("tieDecidedPackageOwners failed");
      }
      return actual.tieDecidedPackageOwners(...args);
    },
  };
});

afterEach(() => {
  linker.fail = null;
});

const OWNER_KEYS = ["owner_decided_by", "ownerDecisionCounts", "tieDecidedPackageOwners"] as const;

async function collectWithFailure(fail: FailFn, message: string): Promise<void> {
  linker.fail = fail;
  const warnings: string[] = [];
  const log: Logger = {
    info() {},
    warn(warning) {
      warnings.push(warning);
    },
    error() {},
  };
  const dataDir = mkdtempSync(join(tmpdir(), "radar-owner-fallback-"));
  const fetchImpl = fixtureFetch([
    {
      match: /registry.modelcontextprotocol.io/,
      body: {
        servers: [
          {
            server: {
              name: "io.github.example/weather",
              description: "Weather",
              version: "1.0.0",
              repository: { url: "https://github.com/example/weather", source: "github" },
              packages: [{ registryType: "npm", identifier: "@example/weather-mcp" }],
            },
            _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
          },
        ],
        metadata: { count: 1 },
      },
    },
  ]);

  const outcome = await collect({
    date: DATE,
    dataDir,
    sources: ["mcp-registry"],
    now: new Date(`${DATE}T12:00:00Z`),
    env: {},
    http: createHttpClient({ fetchImpl, maxRetries: 0 }),
    log,
  });

  expect(outcome.wrote).toBe(true);
  expect(warnings).toEqual([message]);

  const paths = dataPaths(dataDir);
  const sourceRowsText = readFileSync(paths.sourceRowsPath(DATE), "utf8");
  const appsText = readFileSync(paths.appsPath(DATE), "utf8");
  expect(sourceRowsText).toContain("github:example/weather");
  expect(appsText).toContain("@example/weather-mcp");
  for (const key of OWNER_KEYS) {
    expect(sourceRowsText).not.toContain(`"${key}"`);
    expect(appsText).not.toContain(`"${key}"`);
  }

  const written = JSON.parse(readFileSync(paths.manifestPath(DATE), "utf8")) as Record<string, unknown>;
  expect(Object.keys(written)).toEqual([
    "snapshotDate",
    "collectedAt",
    "sources",
    "appCount",
    "sourceRowCount",
    "partial",
    "completedSources",
    "failedSourceCount",
  ]);
  expect(written.snapshotDate).toBe(DATE);
  expect(written.collectedAt).toBe(`${DATE}T12:00:00.000Z`);
  expect(written.partial).toBe(false);
  expect(written.completedSources).toEqual(["mcp-registry"]);
  expect(written.failedSourceCount).toBe(0);
  expect(written.appCount).toBe(1);
  expect(written.sourceRowCount).toBe(1);
  const sources = written.sources as Array<{ source: string; rowCount: number }>;
  expect(sources).toEqual([expect.objectContaining({ source: "mcp-registry", rowCount: 1 })]);
  for (const key of OWNER_KEYS) {
    expect(written).not.toHaveProperty(key);
  }
}

describe("owner decision manifest fallback", () => {
  it("writes the snapshot and manifest with no owner keys when linkCrossStore throws", async () => {
    await collectWithFailure("linkCrossStore", "linkCrossStore failed");
  });

  it("writes the snapshot and manifest with no owner keys when ownerDecisionCounts throws", async () => {
    await collectWithFailure("ownerDecisionCounts", "ownerDecisionCounts failed");
  });

  it("writes the snapshot and manifest with no owner keys when tieDecidedPackageOwners throws", async () => {
    await collectWithFailure("tieDecidedPackageOwners", "tieDecidedPackageOwners failed");
  });
});
