import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate/build.ts";
import { writeDemoSnapshots } from "../src/aggregate/demo.ts";
import {
  categories,
  competitors,
  homeLeaders,
  movers,
  multiStoreApps,
  newArrivals,
  rankHistory,
  searchApps,
  topChart,
} from "../src/aggregate/query.ts";
import { runTool } from "../src/aggregate/tools.ts";

function demoAggregate() {
  const dataDir = mkdtempSync(join(tmpdir(), "radar-q-"));
  writeDemoSnapshots(dataDir);
  return buildAggregate(dataDir, "fixture");
}

describe("public aggregate queries", () => {
  const agg = demoAggregate();

  it("ranks Smithery / npm / GitHub / Gemini charts", () => {
    expect(topChart(agg, "smithery", 3)[0]?.app.id).toBe("github:brave/brave-search-mcp");
    expect(topChart(agg, "npm", 1)[0]?.app.id).toBe("github:example/github-mcp");
    expect(topChart(agg, "github", 1)[0]?.app.id).toBe("github:obra/superpowers");
    expect(topChart(agg, "gemini", 1)[0]?.app.id).toBe("github:obra/superpowers");
    expect(topChart(agg, "smithery", 5)[0]?.previousRank).toBe(1);
  });

  it("uses day-over-day movers on the home list when 2+ days exist", () => {
    const leaders = homeLeaders(agg, 5);
    expect(leaders[0]?.delta).not.toBeNull();
    const slack = movers(agg, { window: "7d", metric: "use_count" }).find((row) => row.id === "github:example/slack-mcp");
    expect(slack?.delta).toBeLessThan(0);
    const weekly = movers(agg, { window: "7d", metric: "use_count" });
    const braveMove = weekly.find((row) => row.id === "github:brave/brave-search-mcp");
    expect(braveMove?.delta).toBe(16000);
    expect(braveMove?.growth).toBe("10–25%");
  });

  it("searches, lists multi-store, new arrivals, and categories", () => {
    expect(searchApps(agg, "brave")[0]?.id).toBe("github:brave/brave-search-mcp");
    expect(searchApps(agg, "search", { category: "search" }).every((app) => app.category === "search")).toBe(true);
    expect(multiStoreApps(agg).some((app) => app.id === "github:example/weather")).toBe(true);
    expect(newArrivals(agg).length).toBeLessThanOrEqual(10);
    expect(categories(agg).some((row) => row.slug === "search" && row.appCount >= 1)).toBe(true);
  });

  it("returns rank history and description-based competitors", () => {
    const ranks = rankHistory(agg, "github:brave/brave-search-mcp", "use_count");
    expect(ranks.at(-1)?.rank).toBe(1);
    const similar = competitors(agg, "github:brave/brave-search-mcp");
    expect(similar.some((app) => app.id === "github:example/universal-search")).toBe(true);
  });

  it("exposes answer-share aggregates and a graceful empty payload", () => {
    const present = JSON.parse(runTool(agg, "answer_share", { limit: 3 }).content[0]!.text);
    expect(present.available).toBe(true);
    expect(present.rows[0].appId).toBe("github:brave/brave-search-mcp");
    const openai = JSON.parse(runTool(agg, "answer_share", { provider: "openai" }).content[0]!.text);
    expect(openai.rows.length).toBeGreaterThan(0);
    const emptyDir = mkdtempSync(join(tmpdir(), "radar-empty-share-"));
    writeDemoSnapshots(emptyDir, ["2026-10-15"]);
    const empty = JSON.parse(runTool(buildAggregate(emptyDir, "fixture"), "answer_share", {}).content[0]!.text);
    expect(empty).toEqual({ available: false });
  });

  it("caps tool payloads and never dumps raw history files", () => {
    const result = runTool(agg, "search_apps", { query: "mcp", limit: 500 });
    const payload = JSON.parse(result.content[0]!.text) as { apps: unknown[] };
    expect(payload.apps.length).toBeLessThanOrEqual(10);
    expect(result.content[0]!.text).not.toContain("source_rows.ndjson");
    const charts = runTool(agg, "top_charts", { chart: "smithery", limit: 3 });
    expect(charts.content[0]!.text).toContain("Brave Search");
  });
});
