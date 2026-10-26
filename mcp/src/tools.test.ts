import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildAggregate } from "../../src/aggregate/build.ts";
import { writeDemoSnapshots } from "../../src/aggregate/demo.ts";
import { runTool, TOOL_NAMES } from "../../src/aggregate/tools.ts";
import { PublicLimitSchema } from "./server.ts";

const FORBIDDEN_KEYS = new Set(["useCount", "use_count", "u"]);

function collectForbiddenKeys(value: unknown, path = "$"): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...collectForbiddenKeys(item, `${path}[${index}]`));
    });
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) {
        found.push(`${path}.${key}`);
      }
      found.push(...collectForbiddenKeys(child, `${path}.${key}`));
    }
  }
  return found;
}

const dataDir = mkdtempSync(join(tmpdir(), "radar-mcp-"));
writeDemoSnapshots(dataDir);
const agg = buildAggregate(dataDir, "fixture");

describe("MCP tool payloads", () => {
  it("search_apps and app_details stay on the public summary surface", () => {
    const search = JSON.parse(runTool(agg, "search_apps", { query: "postgres" }).content[0]!.text);
    assert.equal(search.apps[0].id, "github:example/postgres-mcp");
    const detail = JSON.parse(runTool(agg, "app_details", { app_id: "github:example/postgres-mcp" }).content[0]!.text);
    assert.ok(detail.app);
    assert.ok(Array.isArray(detail.history));
    assert.ok(!JSON.stringify(detail).includes("source_rows.ndjson"));
  });

  it("covers charts, movers, competitors, trends, multi-store", () => {
    const charts = JSON.parse(runTool(agg, "top_charts", { chart: "gemini", limit: 2 }).content[0]!.text);
    assert.equal(charts.rows[0].id, "github:obra/superpowers");
    const movers = JSON.parse(runTool(agg, "movers", { window: "7d", metric: "npm_weekly_downloads" }).content[0]!.text);
    assert.ok(movers.rows.length > 0);
    const comps = JSON.parse(runTool(agg, "competitors", { app_id: "github:brave/brave-search-mcp" }).content[0]!.text);
    assert.ok(comps.rows.some((row: { id: string }) => row.id === "github:example/universal-search"));
    const trends = JSON.parse(runTool(agg, "category_trends", { category: "search" }).content[0]!.text);
    assert.equal(trends.category, "search");
    const multi = JSON.parse(runTool(agg, "multi_store", { limit: 10 }).content[0]!.text);
    assert.equal(multi.kind, "multi_store");
    const fresh = JSON.parse(runTool(agg, "multi_store", { new_arrivals: true }).content[0]!.text);
    assert.equal(fresh.kind, "new_arrivals");
    const share = JSON.parse(runTool(agg, "answer_share", { limit: 3 }).content[0]!.text);
    assert.equal(share.available, true);
    assert.ok(share.rows.length > 0);
  });

  it("rank_history with no metric uses npm", () => {
    const missing = JSON.parse(runTool(agg, "rank_history", { app_id: "github:example/github-mcp" }).content[0]!.text);
    assert.equal(missing.metric, "npm_weekly_downloads");
    assert.notEqual(missing.metric, "use_count");
    assert.equal(JSON.stringify(missing).includes("use_count"), false);
  });

  it("rank_history with an unknown metric errors", () => {
    const unknown = JSON.parse(
      runTool(agg, "rank_history", { app_id: "github:example/github-mcp", metric: "not_a_metric" }).content[0]!.text,
    );
    assert.equal(unknown.error, "unknown metric: not_a_metric");
    assert.equal(unknown.points, undefined);
    assert.equal(JSON.stringify(unknown).includes("use_count"), false);
  });

  it("rejects metric=use_count on rank_history and movers", () => {
    const history = JSON.parse(
      runTool(agg, "rank_history", { app_id: "github:example/github-mcp", metric: "use_count" }).content[0]!.text,
    );
    assert.deepEqual(history, { error: "unknown metric: use_count" });
    assert.equal(history.points, undefined);
    const moversRejected = JSON.parse(runTool(agg, "movers", { metric: "use_count" }).content[0]!.text);
    assert.deepEqual(moversRejected, { error: "unknown metric: use_count" });
    assert.equal(moversRejected.rows, undefined);
  });

  it("omits useCount from search, competitors, category_trends, multi_store, and app_details", () => {
    const search = JSON.parse(runTool(agg, "search_apps", { query: "postgres" }).content[0]!.text);
    assert.equal(JSON.stringify(search.apps).includes("useCount"), false);
    const comps = JSON.parse(runTool(agg, "competitors", { app_id: "github:brave/brave-search-mcp" }).content[0]!.text);
    assert.equal(JSON.stringify(comps.rows).includes("useCount"), false);
    const trends = JSON.parse(runTool(agg, "category_trends", { category: "search" }).content[0]!.text);
    assert.equal(JSON.stringify(trends).includes("useCount"), false);
    const multi = JSON.parse(runTool(agg, "multi_store", { limit: 5 }).content[0]!.text);
    assert.equal(JSON.stringify(multi.rows).includes("useCount"), false);
    const detail = JSON.parse(runTool(agg, "app_details", { app_id: "github:example/postgres-mcp" }).content[0]!.text);
    assert.equal(JSON.stringify(detail).includes("useCount"), false);
    assert.equal(JSON.stringify(detail).includes("use_count"), false);
  });

  it("recursively scans every MCP tool payload for useCount, use_count, and u keys", () => {
    const brave = "github:brave/brave-search-mcp";
    const toolArgs: Record<(typeof TOOL_NAMES)[number], Record<string, unknown>> = {
      search_apps: { query: "mcp" },
      app_details: { app_id: brave },
      rank_history: { app_id: brave },
      top_charts: {},
      movers: { window: "1d" },
      competitors: { app_id: brave },
      category_trends: {},
      multi_store: {},
      answer_share: {},
    };
    for (const name of TOOL_NAMES) {
      const payload = JSON.parse(runTool(agg, name, toolArgs[name]).content[0]!.text);
      assert.deepEqual(collectForbiddenKeys(payload), [], name);
    }
    const extras = [
      runTool(agg, "rank_history", { app_id: brave, metric: "stars" }),
      runTool(agg, "movers", { window: "7d" }),
      runTool(agg, "top_charts", { chart: "github" }),
      runTool(agg, "search_apps", { query: "brave" }),
      runTool(agg, "app_details", { app_id: "github:example/postgres-mcp" }),
    ];
    for (const result of extras) {
      assert.deepEqual(collectForbiddenKeys(JSON.parse(result.content[0]!.text)), []);
    }
  });

  it("rejects limit: 50 on the public tool schema", () => {
    assert.equal(PublicLimitSchema.safeParse(50).success, false);
    assert.equal(PublicLimitSchema.safeParse(10).success, true);
    assert.equal(PublicLimitSchema.safeParse(5).success, true);
    const capped = JSON.parse(runTool(agg, "top_charts", { chart: "npm", limit: 50 }).content[0]!.text);
    assert.ok(capped.rows.length <= 10);
  });
});
