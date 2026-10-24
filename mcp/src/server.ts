import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { runTool, type ToolName } from "../../src/aggregate/tools.ts";
import { loadAggregate } from "./load.ts";

const VERSION = "0.1.0";

/** Free-tier MCP limit: default 5, hard max 10. */
export const PublicLimitSchema = z.number().int().min(1).max(10).optional();

function textTool(name: ToolName, args: Record<string, unknown>) {
  return runTool(loadAggregate(), name, args);
}

export function createRadarServer(): McpServer {
  const server = new McpServer({
    name: "agentstore-radar",
    version: VERSION,
    title: "AgentStore Radar",
  });

  server.registerTool(
    "search_apps",
    {
      description: "Search public app summaries by name, id, or description. Never returns raw snapshot files.",
      inputSchema: z.object({
        query: z.string().describe("Free-text query"),
        category: z.string().optional().describe("Optional category slug"),
        limit: PublicLimitSchema,
      }),
    },
    async ({ query, category, limit }) => textTool("search_apps", { query, category, limit }),
  );

  server.registerTool(
    "app_details",
    {
      description: "Latest summary plus compact metric history for one app_id.",
      inputSchema: z.object({
        app_id: z.string().describe("Stable app id, e.g. github:owner/repo"),
      }),
    },
    async ({ app_id }) => textTool("app_details", { app_id }),
  );

  server.registerTool(
    "rank_history",
    {
      description: "Rank and value over snapshot dates for one app and metric.",
      inputSchema: z.object({
        app_id: z.string(),
        metric: z.enum(["stars", "npm_weekly_downloads", "pypi_last_week_downloads", "gemini_stars"]).optional(),
      }),
    },
    async ({ app_id, metric }) => textTool("rank_history", { app_id, metric }),
  );

  server.registerTool(
    "top_charts",
    {
      description: "Leaderboard for npm, github, or gemini.",
      inputSchema: z.object({
        chart: z.enum(["npm", "github", "gemini"]).optional(),
        limit: PublicLimitSchema,
      }),
    },
    async ({ chart, limit }) => textTool("top_charts", { chart, limit }),
  );

  server.registerTool(
    "movers",
    {
      description: "Largest absolute metric changes over 1 day or ~7 days.",
      inputSchema: z.object({
        window: z.enum(["1d", "7d"]).optional(),
        metric: z.enum(["stars", "npm_weekly_downloads", "pypi_last_week_downloads", "gemini_stars"]).optional(),
        limit: PublicLimitSchema,
      }),
    },
    async ({ window, metric, limit }) => textTool("movers", { window, metric, limit }),
  );

  server.registerTool(
    "competitors",
    {
      description: "Similar apps by category and description-token overlap (no embeddings).",
      inputSchema: z.object({
        app_id: z.string(),
        limit: PublicLimitSchema,
      }),
    },
    async ({ app_id, limit }) => textTool("competitors", { app_id, limit }),
  );

  server.registerTool(
    "category_trends",
    {
      description: "Category totals over time, or one category plus its top apps.",
      inputSchema: z.object({
        category: z.string().optional(),
      }),
    },
    async ({ category }) => textTool("category_trends", { category }),
  );

  server.registerTool(
    "multi_store",
    {
      description: "Apps listed on 2+ stores, or set new_arrivals to list first-seen-this-snapshot apps.",
      inputSchema: z.object({
        new_arrivals: z.boolean().optional(),
        limit: PublicLimitSchema,
      }),
    },
    async ({ new_arrivals, limit }) => textTool("multi_store", { new_arrivals, limit }),
  );

  server.registerTool(
    "answer_share",
    {
      description:
        "Latest weekly assistant-recommendation shares (overall or one provider). Empty when no probe snapshot is in the aggregate.",
      inputSchema: z.object({
        provider: z.enum(["openai", "anthropic", "gemini", "xai"]).optional(),
        limit: PublicLimitSchema,
      }),
    },
    async ({ provider, limit }) => textTool("answer_share", { provider, limit }),
  );

  return server;
}
