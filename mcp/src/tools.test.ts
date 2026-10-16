import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildAggregate } from "../../src/aggregate/build.ts";
import { writeDemoSnapshots } from "../../src/aggregate/demo.ts";
import { runTool } from "../../src/aggregate/tools.ts";

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
  });
});
