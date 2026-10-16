import { describe, expect, it } from "vitest";
import {
  anthropicRequestBody,
  extractResponseText,
  geminiRequestBody,
  openaiRequestBody,
  PROVIDERS,
  usageFromPayload,
  xaiRequestBody,
} from "../src/answer-share/providers.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { loadFixture } from "./helpers.ts";
import type { Prompt } from "../src/answer-share/schema.ts";

const prompt: Prompt = {
  id: "coding-001",
  category: "coding",
  text: "Which MCP servers should I use to review GitHub PRs?",
};

describe("provider request bodies", () => {
  it("enable official web-search tool modes", () => {
    expect(openaiRequestBody(prompt, { model: "gpt-4.1-mini", temperature: 0.8, webSearch: true, tool: "web_search" })).toEqual(
      expect.objectContaining({
        model: "gpt-4.1-mini",
        tools: [expect.objectContaining({ type: "web_search" })],
      }),
    );
    expect(anthropicRequestBody(prompt, { model: "claude-haiku-4-5", temperature: 0.8, webSearch: true, tool: "web_search_20250305" })).toEqual(
      expect.objectContaining({
        tools: [expect.objectContaining({ type: "web_search_20250305", name: "web_search" })],
      }),
    );
    expect(geminiRequestBody(prompt, { model: "gemini-2.5-flash", temperature: 0.8, webSearch: true, tool: "google_search" })).toEqual(
      expect.objectContaining({
        tools: [{ google_search: {} }],
      }),
    );
    expect(xaiRequestBody(prompt, { model: "grok-4-fast-non-reasoning", temperature: 0.8, webSearch: true, tool: "web_search" })).toEqual(
      expect.objectContaining({
        tools: [{ type: "web_search" }],
      }),
    );
  });
});

describe("provider response parsing", () => {
  it("reads OpenAI, Anthropic, Gemini, and xAI fixtures", () => {
    const openai = loadFixture("answer-share/openai-response.json");
    const anthropic = loadFixture("answer-share/anthropic-response.json");
    const gemini = loadFixture("answer-share/gemini-response.json");
    const xai = loadFixture("answer-share/xai-response.json");
    expect(extractResponseText(openai)).toContain("GitHub");
    expect(extractResponseText(anthropic)).toContain("Slack");
    expect(extractResponseText(gemini)).toContain("Playwright");
    expect(extractResponseText(xai)).toContain("GitHub");
    expect(usageFromPayload(openai, 0).input_tokens).toBe(520);
    expect(usageFromPayload(anthropic, 0).web_search_calls).toBe(1);
    expect(usageFromPayload(gemini, 0).output_tokens).toBe(88);
    expect(usageFromPayload(xai, 0).web_search_calls).toBe(1);
  });
});

describe("provider adapters", () => {
  it("POST to official endpoints and record model + timestamp", async () => {
    const seen: string[] = [];
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(input)}`);
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
      throw new Error(`unexpected ${url}`);
    };
    const http = createHttpClient({ fetchImpl, maxRetries: 0 });
    const timestamp = "2026-10-16T12:00:00.000Z";
    const openai = await PROVIDERS.openai.complete({
      prompt,
      run: 1,
      timestamp,
      env: { OPENAI_API_KEY: "sk-test" },
      http,
    });
    const anthropic = await PROVIDERS.anthropic.complete({
      prompt,
      run: 1,
      timestamp,
      env: { ANTHROPIC_API_KEY: "sk-ant" },
      http,
    });
    const gemini = await PROVIDERS.gemini.complete({
      prompt,
      run: 1,
      timestamp,
      env: { GEMINI_API_KEY: "gem" },
      http,
    });
    const xai = await PROVIDERS.xai.complete({
      prompt,
      run: 1,
      timestamp,
      env: { XAI_API_KEY: "xai" },
      http,
    });
    expect(seen.some((row) => row.includes("POST https://api.openai.com/v1/responses"))).toBe(true);
    expect(seen.some((row) => row.includes("POST https://api.anthropic.com/v1/messages"))).toBe(true);
    expect(seen.some((row) => row.includes("generateContent"))).toBe(true);
    expect(seen.some((row) => row.includes("POST https://api.x.ai/v1/responses"))).toBe(true);
    expect(openai.model).toBe("gpt-4.1-mini");
    expect(openai.timestamp).toBe(timestamp);
    expect(openai.settings).toEqual(expect.objectContaining({ webSearch: true, tool: "web_search" }));
    expect(openai.text).toContain("filesystem");
    expect(anthropic.text).toContain("GitHub");
    expect(gemini.text).toContain("Playwright");
    expect(xai.text).toContain("Slack");
  });
});
