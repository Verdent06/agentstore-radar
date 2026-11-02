import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate/build.ts";
import { runTool, TOOL_NAMES } from "../src/aggregate/tools.ts";
import { writeAggregateFiles } from "../src/aggregate/write.ts";
import { collect } from "../src/commands/collect.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { dataPaths } from "../src/lib/io.ts";
import { createLogger } from "../src/lib/logger.ts";
import { fixtureFetch } from "./helpers.ts";

const DATE = "2026-11-02";
const PRIVATE_KEYS = ["owner_decided_by", "ownerDecisionCounts", "tieDecidedPackageOwners"] as const;

const silent = createLogger({
  log() {},
  warn() {},
  error() {},
});

function mcpServer(name: string, repoUrl: string, npmPackage: string) {
  return {
    server: {
      name,
      description: name,
      version: "1.0.0",
      repository: { url: repoUrl, source: "github" },
      packages: [{ registryType: "npm", identifier: npmPackage, transport: { type: "stdio" } }],
    },
    _meta: {
      "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true },
    },
  };
}

const REGISTRY = {
  servers: [
    mcpServer("io.github.smartergpt/lex", "https://github.com/smartergpt/lex", "@smartergpt/lex-mcp"),
    mcpServer("io.github.guffawaffle/lex", "https://github.com/guffawaffle/lex", "@smartergpt/lex-mcp"),
    mcpServer("com.guffawaffle/lex-extra", "https://github.com/guffawaffle/lex", "@SmarterGPT/lex-mcp"),
    mcpServer("io.github.bbb/repo", "https://github.com/bbb/repo", "plain-widget"),
    mcpServer("io.github.aaa/repo", "https://github.com/aaa/repo", "plain-widget"),
  ],
  metadata: { count: 5 },
};

const SCOPE_DECISION = {
  npm_package: "@smartergpt/lex-mcp",
  app_id: "github:smartergpt/lex",
  owner_decided_by: "scope_matches_github_org",
  claimants: ["github:guffawaffle/lex", "github:smartergpt/lex"],
};

const TIE_DECISION = {
  npm_package: "plain-widget",
  app_id: "github:aaa/repo",
  owner_decided_by: "smallest_id_fallback",
  claimants: ["github:aaa/repo", "github:bbb/repo"],
};

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...filesUnder(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

function jsonKeys(value: unknown, path = "$"): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...jsonKeys(item, `${path}[${index}]`));
    });
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      found.push(key);
      found.push(...jsonKeys(child, `${path}.${key}`));
    }
  }
  return found;
}

async function collectFixture(): Promise<string> {
  const dataDir = mkdtempSync(join(tmpdir(), "radar-owner-manifest-"));
  const fetchImpl = fixtureFetch([{ match: /registry.modelcontextprotocol.io/, body: REGISTRY }]);
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
  return dataDir;
}

describe("private snapshot manifest owner decisions", () => {
  it("writes owner_decided_by, ownerDecisionCounts, and tieDecidedPackageOwners for a contested and a tie-decided package", async () => {
    const dataDir = await collectFixture();
    const manifestPath = dataPaths(dataDir).manifestPath(DATE);
    const written = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

    expect(Object.keys(written)).toEqual([
      "snapshotDate",
      "collectedAt",
      "sources",
      "appCount",
      "sourceRowCount",
      "partial",
      "completedSources",
      "failedSourceCount",
      "owner_decided_by",
      "ownerDecisionCounts",
      "tieDecidedPackageOwners",
    ]);
    expect(written.owner_decided_by).toEqual([SCOPE_DECISION, TIE_DECISION]);
    expect(written.ownerDecisionCounts).toEqual({
      sole_claimant: 0,
      scope_matches_github_org: 1,
      most_supporting_rows: 0,
      non_fork: 0,
      repo_name_matches_package: 0,
      github_id_fallback: 0,
      smallest_id_fallback: 1,
    });
    expect(written.tieDecidedPackageOwners).toEqual([TIE_DECISION]);

    for (const file of filesUnder(dataDir)) {
      if (file === manifestPath) {
        continue;
      }
      const text = readFileSync(file);
      for (const key of PRIVATE_KEYS) {
        expect(text.includes(`"${key}"`), `${file} contains ${key}`).toBe(false);
      }
    }
  });

  it("keeps the three fields out of web and mcp outputs", async () => {
    const dataDir = await collectFixture();
    const agg = buildAggregate(dataDir, "fixture");
    const webOut = mkdtempSync(join(tmpdir(), "radar-web-"));
    const mcpOut = mkdtempSync(join(tmpdir(), "radar-mcp-"));
    const webFiles = writeAggregateFiles(agg, webOut);
    const mcpFiles = writeAggregateFiles(agg, mcpOut);

    const payloads: unknown[] = [agg];
    for (const written of [webFiles, mcpFiles]) {
      payloads.push(JSON.parse(readFileSync(written.json, "utf8")));
      if (written.sqlite) {
        payloads.push(readFileSync(written.sqlite).toString("utf8"));
      }
    }
    const appId = agg.apps[0]?.id;
    const toolArgs: Record<(typeof TOOL_NAMES)[number], Record<string, unknown>> = {
      search_apps: { query: "lex" },
      app_details: { app_id: appId ?? "github:smartergpt/lex" },
      rank_history: { app_id: appId ?? "github:smartergpt/lex", metric: "stars" },
      top_charts: { chart: "npm" },
      movers: { window: "1d" },
      competitors: { app_id: appId ?? "github:smartergpt/lex" },
      category_trends: { category: "other" },
      multi_store: {},
      answer_share: {},
    };
    for (const name of TOOL_NAMES) {
      payloads.push(JSON.parse(runTool(agg, name, toolArgs[name]).content[0]!.text));
    }

    for (const payload of payloads) {
      const keys = typeof payload === "string" ? [] : jsonKeys(payload);
      for (const key of PRIVATE_KEYS) {
        expect(keys).not.toContain(key);
        const text = typeof payload === "string" ? payload : JSON.stringify(payload);
        expect(text.includes(`"${key}"`)).toBe(false);
      }
    }
  });
});
