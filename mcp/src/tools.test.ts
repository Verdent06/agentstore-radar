import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildAggregate } from "../../src/aggregate/build.ts";
import { writeDemoSnapshots } from "../../src/aggregate/demo.ts";
import { runTool } from "../../src/aggregate/tools.ts";
import { PublicLimitSchema } from "./server.ts";

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
    const movers = JSON.parse(runTool(agg, "movers", { window: "7d", metric: "use_count" }).content[0]!.text);
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

  it("rank_history without a metric ranks by npm; an unknown metric returns an error", () => {
    const missing = JSON.parse(runTool(agg, "rank_history", { app_id: "github:example/github-mcp" }).content[0]!.text);
    assert.equal(missing.metric, "npm_weekly_downloads");
    assert.notEqual(missing.metric, "use_count");
    assert.equal(JSON.stringify(missing).includes("use_count"), false);
    const unknown = JSON.parse(
      runTool(agg, "rank_history", { app_id: "github:example/github-mcp", metric: "not_a_metric" }).content[0]!.text,
    );
    assert.equal(unknown.error, "unknown metric: not_a_metric");
    assert.equal(unknown.points, undefined);
    assert.equal(JSON.stringify(unknown).includes("use_count"), false);
  });

  it("omits useCount from search, competitors, category_trends, and multi_store", () => {
    const search = JSON.parse(runTool(agg, "search_apps", { query: "postgres" }).content[0]!.text);
    assert.equal(JSON.stringify(search.apps).includes("useCount"), false);
    const comps = JSON.parse(runTool(agg, "competitors", { app_id: "github:brave/brave-search-mcp" }).content[0]!.text);
    assert.equal(JSON.stringify(comps.rows).includes("useCount"), false);
    const trends = JSON.parse(runTool(agg, "category_trends", { category: "search" }).content[0]!.text);
    assert.equal(JSON.stringify(trends).includes("useCount"), false);
    const multi = JSON.parse(runTool(agg, "multi_store", { limit: 5 }).content[0]!.text);
    assert.equal(JSON.stringify(multi.rows).includes("useCount"), false);
    const detail = JSON.parse(runTool(agg, "app_details", { app_id: "github:example/postgres-mcp" }).content[0]!.text);
    assert.equal(JSON.stringify(detail.history).includes("useCount"), false);
    assert.equal(JSON.stringify(detail.history).includes("use_count"), false);
  });

  it("rejects limit: 50 on the public tool schema", () => {
    assert.equal(PublicLimitSchema.safeParse(50).success, false);
    assert.equal(PublicLimitSchema.safeParse(10).success, true);
    assert.equal(PublicLimitSchema.safeParse(5).success, true);
    const capped = JSON.parse(runTool(agg, "top_charts", { chart: "smithery", limit: 50 }).content[0]!.text);
    assert.ok(capped.rows.length <= 10);
  });
});
