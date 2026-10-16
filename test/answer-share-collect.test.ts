import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectAnswerShare } from "../src/commands/answer-share.ts";
import {
  answerSharePaths,
  assertNotOverwritingPastAnswerShare,
  readAnswerShareExtracted,
  readAnswerShareMentions,
  readAnswerShareResponses,
} from "../src/answer-share/io.ts";
import { createHttpClient, denyNetworkFetch } from "../src/lib/http.ts";
import { createLogger } from "../src/lib/logger.ts";
import { emptySourceRow } from "../src/lib/schema.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { writeJsonSnapshot, writeNormalized } from "../src/lib/io.ts";
import { loadFixture } from "./helpers.ts";
import type { Prompt } from "../src/answer-share/schema.ts";

const silent = createLogger({
  log() {},
  warn() {},
  error() {},
});

const prompts: Prompt[] = [
  { id: "coding-001", category: "coding", text: "Which tools should I use to review GitHub pull requests?" },
  { id: "devops-001", category: "devops", text: "Which tools should I use when a deploy fails?" },
];

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

function providerFetch(): (input: string | URL) => Promise<Response> {
  return async (input) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      return new Response(JSON.stringify(loadFixture("answer-share/openai-response.json")), { status: 200 });
    }
    if (url.includes("api.anthropic.com")) {
      return new Response(JSON.stringify(loadFixture("answer-share/anthropic-response.json")), { status: 200 });
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(JSON.stringify(loadFixture("answer-share/gemini-response.json")), { status: 200 });
    }
    if (url.includes("api.x.ai")) {
      return new Response(JSON.stringify(loadFixture("answer-share/xai-response.json")), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
}

describe("collectAnswerShare", () => {
  it("skips missing providers, runs N times, and writes raw + normalized files", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "answer-share-"));
    let calls = 0;
    const fetchImpl = async (input: string | URL) => {
      calls += 1;
      return providerFetch()(input);
    };
    const manifest = await collectAnswerShare({
      date: "2026-10-16",
      dataDir,
      now: new Date("2026-10-16T12:00:00Z"),
      n: 3,
      prompts,
      apps,
      env: { OPENAI_API_KEY: "sk-test" },
      http: createHttpClient({ fetchImpl, maxRetries: 0 }),
      log: silent,
    });
    expect(manifest.ran).toEqual(["openai"]);
    expect(manifest.skipped).toEqual(expect.arrayContaining(["anthropic", "gemini", "xai"]));
    expect(manifest.providers.find((row) => row.provider === "anthropic")?.skipReason).toMatch(/ANTHROPIC_API_KEY/);
    expect(manifest.callsMade).toBe(6);
    expect(calls).toBe(6);
    expect(manifest.n).toBe(3);
    const responses = readAnswerShareResponses("2026-10-16", dataDir);
    expect(responses).toHaveLength(6);
    expect(responses.every((row) => row.provider === "openai")).toBe(true);
    expect(responses.every((row) => row.model === "gpt-4.1-mini")).toBe(true);
    expect(new Set(responses.map((row) => row.run))).toEqual(new Set([1, 2, 3]));
    const extracted = readAnswerShareExtracted("2026-10-16", dataDir);
    expect(extracted.some((row) => row.name === "GitHub")).toBe(true);
    const mentions = readAnswerShareMentions("2026-10-16", dataDir);
    expect(mentions.some((row) => row.matched_app_id === "github:github/github-mcp-server")).toBe(true);
    const paths = answerSharePaths("2026-10-16", dataDir);
    expect(existsSync(paths.manifestPath)).toBe(true);
    expect(existsSync(paths.sharesPath)).toBe(true);
  });

  it("honors MAX_CALLS as a hard cap", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "answer-share-cap-"));
    let calls = 0;
    const fetchImpl = async (input: string | URL) => {
      calls += 1;
      return providerFetch()(input);
    };
    const manifest = await collectAnswerShare({
      date: "2026-10-16",
      dataDir,
      now: new Date("2026-10-16T12:00:00Z"),
      n: 3,
      maxCalls: 2,
      prompts,
      apps,
      env: { OPENAI_API_KEY: "sk", GEMINI_API_KEY: "gem" },
      http: createHttpClient({ fetchImpl, maxRetries: 0 }),
      log: silent,
    });
    expect(manifest.callsMade).toBe(2);
    expect(calls).toBe(2);
    expect(manifest.truncated).toBe(true);
    expect(manifest.ran).toEqual(expect.arrayContaining(["openai", "gemini"]));
  });

  it("writes a skipped-only manifest when no keys are present and never hits the network", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "answer-share-none-"));
    const manifest = await collectAnswerShare({
      date: "2026-10-16",
      dataDir,
      now: new Date("2026-10-16T12:00:00Z"),
      prompts,
      apps,
      env: {},
      http: createHttpClient({ fetchImpl: denyNetworkFetch(), maxRetries: 0 }),
      log: silent,
    });
    expect(manifest.ran).toEqual([]);
    expect(manifest.skipped).toHaveLength(4);
    expect(manifest.callsMade).toBe(0);
    expect(readAnswerShareResponses("2026-10-16", dataDir)).toEqual([]);
  });

  it("refuses to overwrite a past day's probe", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "answer-share-past-"));
    await collectAnswerShare({
      date: "2026-10-14",
      dataDir,
      now: new Date("2026-10-14T12:00:00Z"),
      prompts,
      apps,
      env: {},
      http: createHttpClient({ fetchImpl: denyNetworkFetch(), maxRetries: 0 }),
      log: silent,
    });
    expect(() => assertNotOverwritingPastAnswerShare("2026-10-14", "2026-10-16", dataDir)).toThrow(/past answer-share/);
  });

  it("can match against apps.ndjson from the latest catalog snapshot", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "answer-share-apps-"));
    await writeJsonSnapshot("mcp-registry", "2026-10-15", "2026-10-15", { ok: true }, dataDir);
    writeNormalized(
      "2026-10-15",
      [],
      apps,
      {
        snapshotDate: "2026-10-15",
        collectedAt: "2026-10-15T12:00:00.000Z",
        sources: [],
        appCount: apps.length,
        sourceRowCount: 0,
      },
      dataDir,
    );
    const manifest = await collectAnswerShare({
      date: "2026-10-16",
      dataDir,
      now: new Date("2026-10-16T12:00:00Z"),
      n: 1,
      prompts: [prompts[0]!],
      env: { OPENAI_API_KEY: "sk" },
      http: createHttpClient({ fetchImpl: providerFetch(), maxRetries: 0 }),
      log: silent,
    });
    expect(manifest.matchedMentionCount).toBeGreaterThan(0);
  });
});
