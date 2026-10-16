import { describe, expect, it } from "vitest";
import { extractMentionNames, mentionsFromResponse } from "../src/answer-share/extract.ts";

describe("extractMentionNames", () => {
  it("reads a JSON mentions payload", () => {
    const mentions = extractMentionNames(
      '{"mentions":[{"name":"GitHub","reason":"PRs"},{"name":"filesystem MCP"}]}',
    );
    expect(mentions.map((item) => item.name)).toEqual(["GitHub", "filesystem MCP"]);
    expect(mentions[0]?.reason).toBe("PRs");
  });

  it("unwraps markdown fences and dedupes", () => {
    const mentions = extractMentionNames(`\`\`\`json
{"mentions":[{"name":"Slack"},{"name":"slack"},{"name":"Notion"}]}
\`\`\``);
    expect(mentions.map((item) => item.name)).toEqual(["Slack", "Notion"]);
  });

  it("falls back to numbered lists", () => {
    const mentions = extractMentionNames(`1. GitHub — review PRs
2. Playwright: browser checks
- Linear - tickets`);
    expect(mentions.map((item) => item.name)).toEqual(["GitHub", "Playwright", "Linear"]);
  });

  it("returns nothing for empty text", () => {
    expect(extractMentionNames("")).toEqual([]);
  });
});

describe("mentionsFromResponse", () => {
  it("assigns ranks in answer order", () => {
    const mentions = mentionsFromResponse(
      {
        prompt_id: "coding-001",
        provider: "openai",
        run: 2,
        text: '{"mentions":[{"name":"GitHub"},{"name":"Slack"}]}',
      },
      "coding",
    );
    expect(mentions).toEqual([
      { prompt_id: "coding-001", category: "coding", provider: "openai", run: 2, name: "GitHub", rank: 1, reason: undefined },
      { prompt_id: "coding-001", category: "coding", provider: "openai", run: 2, name: "Slack", rank: 2, reason: undefined },
    ]);
  });
});
