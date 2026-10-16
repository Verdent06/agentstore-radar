import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRadarServer } from "./server.ts";

console.error("agentstore-radar MCP listening on stdio");
serveStdio(() => createRadarServer());
