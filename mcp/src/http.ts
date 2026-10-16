import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Request, Response } from "express";
import { createRadarServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

const handler = createMcpHandler(() => createRadarServer(), { responseMode: "json" });
const app = createMcpExpressApp({ host });
const node = toNodeHandler(handler);

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true, name: "agentstore-radar" });
});
app.all("/mcp", (req: Request, res: Response) => {
  void node(req, res, req.body);
});

app.listen(port, host, () => {
  console.error(`agentstore-radar MCP Streamable HTTP on http://${host}:${port}/mcp`);
});
