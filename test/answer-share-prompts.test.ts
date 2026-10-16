import { describe, expect, it } from "vitest";
import { PROMPT_SET_V1, loadPromptSet } from "../src/answer-share/prompts.ts";
import { PROMPT_CATEGORIES } from "../src/answer-share/schema.ts";

describe("answer-share prompt set v1", () => {
  it("has about 100 unique realistic tasks across every category", () => {
    expect(PROMPT_SET_V1.version).toBe("v1");
    expect(PROMPT_SET_V1.prompts.length).toBeGreaterThanOrEqual(100);
    const ids = PROMPT_SET_V1.prompts.map((prompt) => prompt.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of PROMPT_CATEGORIES) {
      const inCategory = PROMPT_SET_V1.prompts.filter((prompt) => prompt.category === category);
      expect(inCategory.length).toBeGreaterThanOrEqual(8);
    }
    for (const prompt of PROMPT_SET_V1.prompts) {
      expect(prompt.text.length).toBeGreaterThan(40);
      expect(prompt.id.startsWith(`${prompt.category}-`)).toBe(true);
    }
  });

  it("rejects unknown versions", () => {
    expect(loadPromptSet("v1").prompts).toHaveLength(PROMPT_SET_V1.prompts.length);
    expect(() => loadPromptSet("v9")).toThrow(/Unknown answer-share prompt version/);
  });
});
