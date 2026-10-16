import { describe, expect, it } from "vitest";
import {
  estimateProviderCostUsd,
  formatCostEstimate,
  parseMaxCalls,
  plannedCalls,
  usdFromUsage,
} from "../src/answer-share/cost.ts";

describe("answer-share cost", () => {
  it("estimates a full 300-call OpenAI week near $4", () => {
    const usd = estimateProviderCostUsd("openai", 300);
    expect(usd).toBeGreaterThan(3.5);
    expect(usd).toBeLessThan(5);
  });

  it("uses actual token usage when present", () => {
    expect(
      usdFromUsage("xai", { input_tokens: 1_000_000, output_tokens: 1_000_000, web_search_calls: 0 }),
    ).toBeCloseTo(0.7);
  });

  it("parses MAX_CALLS and applies the hard cap to planned calls", () => {
    expect(parseMaxCalls({ MAX_CALLS: "50" })).toBe(50);
    expect(parseMaxCalls({}, 12)).toBe(12);
    expect(parseMaxCalls({})).toBeNull();
    expect(plannedCalls({ promptCount: 100, n: 3, providerCount: 4, maxCalls: 10 })).toBe(10);
    expect(plannedCalls({ promptCount: 2, n: 3, providerCount: 1, maxCalls: null })).toBe(6);
    expect(() => parseMaxCalls({ MAX_CALLS: "nope" })).toThrow(/Invalid MAX_CALLS/);
  });

  it("prints a per-provider estimate table", () => {
    const text = formatCostEstimate([
      { provider: "openai", calls: 300, estimateUsd: 4.22 },
      { provider: "gemini", calls: 0, estimateUsd: 0 },
    ]);
    expect(text).toContain("openai");
    expect(text).toContain("$4.22");
    expect(text).toContain("total");
  });
});
