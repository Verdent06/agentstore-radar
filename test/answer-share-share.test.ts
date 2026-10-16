import { describe, expect, it } from "vitest";
import { computeAnswerShareSnapshot, jaccard, meanPairwiseJaccard } from "../src/answer-share/share.ts";
import type { NormalizedMention, RawResponseRecord } from "../src/answer-share/schema.ts";

function mention(partial: Partial<NormalizedMention> & Pick<NormalizedMention, "name" | "provider" | "run">): NormalizedMention {
  return {
    prompt_id: "coding-001",
    category: "coding",
    rank: 1,
    matched_app_id: null,
    match_method: null,
    match_score: null,
    ...partial,
  };
}

function record(partial: Partial<RawResponseRecord> & Pick<RawResponseRecord, "provider" | "run">): RawResponseRecord {
  return {
    prompt_id: "coding-001",
    category: "coding",
    model: "test",
    settings: {},
    timestamp: "2026-10-16T00:00:00.000Z",
    text: "{}",
    raw: {},
    ...partial,
  };
}

describe("answer share", () => {
  it("computes per-app share per provider and category", () => {
    const mentions: NormalizedMention[] = [
      mention({ name: "GitHub", provider: "openai", run: 1, matched_app_id: "github:github/github-mcp-server" }),
      mention({ name: "GitHub", provider: "openai", run: 2, matched_app_id: "github:github/github-mcp-server", rank: 1 }),
      mention({ name: "Slack", provider: "openai", run: 2, rank: 2 }),
      mention({ name: "GitHub", provider: "gemini", run: 1, matched_app_id: "github:github/github-mcp-server", category: "devops", prompt_id: "devops-001" }),
    ];
    const records = [
      record({ provider: "openai", run: 1 }),
      record({ provider: "openai", run: 2 }),
      record({ provider: "gemini", run: 1, prompt_id: "devops-001", category: "devops" }),
    ];
    const snapshot = computeAnswerShareSnapshot("2026-10-16", "v1", mentions, records);
    const openaiAll = snapshot.shares.find(
      (row) => row.provider === "openai" && row.category == null && row.matched_app_id === "github:github/github-mcp-server",
    );
    expect(openaiAll?.mention_count).toBe(2);
    expect(openaiAll?.answer_share).toBeCloseTo(2 / 3);
    expect(openaiAll?.run_count).toBe(2);
    expect(openaiAll?.eligible_runs).toBe(2);
    const geminiDevops = snapshot.shares.find((row) => row.provider === "gemini" && row.category === "devops");
    expect(geminiDevops?.answer_share).toBe(1);
  });

  it("measures variance with pairwise Jaccard", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(meanPairwiseJaccard([new Set(["a"]), new Set(["a"]), new Set(["b"])])).toBeCloseTo((1 + 0 + 0) / 3);
  });
});
