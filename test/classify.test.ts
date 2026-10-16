import { describe, expect, it } from "vitest";
import { classifyCategory, jaccardTokens, tokenize } from "../src/aggregate/classify.ts";

describe("classifyCategory", () => {
  it("picks RAG over generic search when both terms appear", () => {
    expect(classifyCategory("Chroma", "Vector database for RAG embeddings and retrieval")).toBe("rag");
  });

  it("classifies well-known store descriptions", () => {
    expect(classifyCategory("Brave Search", "Search the web with Brave")).toBe("search");
    expect(classifyCategory("Playwright", "Headless browser automation with Playwright")).toBe("browser");
    expect(classifyCategory("Postgres", "Query PostgreSQL databases")).toBe("database");
    expect(classifyCategory("Files", "Read and write local files and directories")).toBe("filesystem");
    expect(classifyCategory("GitHub", "Repos, issues, pull requests")).toBe("git");
    expect(classifyCategory("Slack", "Post messages in a Slack workspace")).toBe("communication");
    expect(classifyCategory("Memory Bank", "Persistent long-term memory bank")).toBe("memory");
    expect(classifyCategory("AWS", "Inspect AWS cloud infrastructure")).toBe("cloud");
    expect(classifyCategory("Stripe", "Create payments and invoices")).toBe("finance");
    expect(classifyCategory("Figma", "Read Figma design files")).toBe("design");
    expect(classifyCategory("Weather", "Weather forecasts for any location")).toBe("maps");
    expect(classifyCategory("Calendar", "Create calendar events and reminders")).toBe("calendar");
    expect(classifyCategory("Vault", "Read secrets from HashiCorp Vault with security policy")).toBe("security");
    expect(classifyCategory("Notion", "Search Notion documents")).toBe("docs");
    expect(classifyCategory("ESLint", "Lint JavaScript with ESLint")).toBe("devtools");
  });

  it("falls back to other", () => {
    expect(classifyCategory("xyzzy", "a unique widget")).toBe("other");
  });

  it("computes jaccard on tokens", () => {
    expect(jaccardTokens(tokenize("brave web search"), tokenize("search the web brave"))).toBeGreaterThan(0.4);
    expect(jaccardTokens(["alpha"], ["beta"])).toBe(0);
  });
});
