import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collect } from "../src/commands/collect.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { dataPaths } from "../src/lib/io.ts";
import { createLogger } from "../src/lib/logger.ts";
import { fixtureFetch } from "./helpers.ts";

const DATE = "2026-11-02";
const LINKER_ERROR = "owner decision failed";
const linker = { fail: false };

vi.mock("../src/lib/matching.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/matching.ts")>();
  return {
    ...actual,
    linkCrossStore: (...args: Parameters<typeof actual.linkCrossStore>) => {
      if (linker.fail) {
        throw new Error(LINKER_ERROR);
      }
      return actual.linkCrossStore(...args);
    },
  };
});

const silent = createLogger({
  log() {},
  warn() {},
  error() {},
});

afterEach(() => {
  linker.fail = false;
});

describe("owner decision manifest fallback", () => {
  it("writes manifest.json with the existing fields and without owner keys when linkCrossStore throws", async () => {
    linker.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
      log: silent,
    });

    expect(outcome.wrote).toBe(true);
    expect(warn).toHaveBeenCalledWith(LINKER_ERROR);

    const written = JSON.parse(readFileSync(dataPaths(dataDir).manifestPath(DATE), "utf8")) as Record<string, unknown>;
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
    expect(written).not.toHaveProperty("owner_decided_by");
    expect(written).not.toHaveProperty("ownerDecisionCounts");
    expect(written).not.toHaveProperty("tieDecidedPackageOwners");
  });
});
