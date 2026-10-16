import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAnswerShareReport, collectAnswerShare } from "../src/commands/answer-share.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { createLogger } from "../src/lib/logger.ts";
import { emptySourceRow } from "../src/lib/schema.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { loadFixture } from "./helpers.ts";
import type { Prompt } from "../src/answer-share/schema.ts";

const silent = createLogger({
  log() {},
  warn() {},
  error() {},
});

describe("answer-share report", () => {
  it("prints per-provider shares and skipped keys", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "answer-share-report-"));
    const apps = mergeApps("2026-10-15", [
      emptySourceRow({
        snapshot_date: "2026-10-15",
        app_id: "github:github/github-mcp-server",
        source: "mcp-registry",
        source_id: "github",
        name: "github-mcp-server",
        display_name: "GitHub MCP",
        repo_url: "https://github.com/github/github-mcp-server",
      }),
    ]);
    const prompts: Prompt[] = [
      { id: "coding-001", category: "coding", text: "Which tools should I use to review GitHub pull requests?" },
    ];
    await collectAnswerShare({
      date: "2026-10-16",
      dataDir,
      now: new Date("2026-10-16T12:00:00Z"),
      n: 2,
      prompts,
      apps,
      env: { OPENAI_API_KEY: "sk" },
      http: createHttpClient({
        fetchImpl: async () =>
          new Response(JSON.stringify(loadFixture("answer-share/openai-response.json")), { status: 200 }),
        maxRetries: 0,
      }),
      log: silent,
    });
    const text = buildAnswerShareReport({ date: "2026-10-16", dataDir, limit: 5 });
    expect(text).toContain("Answer share 2026-10-16");
    expect(text).toContain("Providers ran: openai");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toContain("openai / coding");
    expect(text).toContain("GitHub");
  });

  it("explains an empty data dir", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "answer-share-empty-"));
    expect(buildAnswerShareReport({ dataDir })).toMatch(/No answer-share probes/);
  });
});
