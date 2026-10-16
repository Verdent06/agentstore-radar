import { describe, expect, it } from "vitest";
import { buildAppIndex, matchMentionName, normalizeMentions, normalizeToolName } from "../src/answer-share/match.ts";
import { emptySourceRow } from "../src/lib/schema.ts";
import { mergeApps } from "../src/lib/merge.ts";

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
  emptySourceRow({
    snapshot_date: "2026-10-15",
    app_id: "github:modelcontextprotocol/servers",
    source: "mcp-registry",
    source_id: "filesystem",
    name: "filesystem",
    display_name: "Filesystem MCP",
    repo_url: "https://github.com/modelcontextprotocol/servers",
  }),
  emptySourceRow({
    snapshot_date: "2026-10-15",
    app_id: "github:brave/brave-search-mcp",
    source: "smithery",
    source_id: "brave",
    name: "brave-search-mcp",
    display_name: "Brave Search",
    homepage: "https://github.com/brave/brave-search-mcp",
  }),
]);

describe("normalizeToolName", () => {
  it("strips mcp/server suffixes and punctuation", () => {
    expect(normalizeToolName("GitHub MCP Server")).toBe("github");
    expect(normalizeToolName("filesystem-mcp")).toBe("filesystem");
  });
});

describe("matchMentionName", () => {
  const catalog = buildAppIndex(apps);

  it("matches display names exactly", () => {
    const match = matchMentionName("GitHub MCP", catalog);
    expect(match.matched_app_id).toBe("github:github/github-mcp-server");
    expect(match.match_method).toBe("exact");
  });

  it("matches aliases like gh → GitHub", () => {
    const match = matchMentionName("gh", catalog);
    expect(match.matched_app_id).toBe("github:github/github-mcp-server");
    expect(match.match_method).toBe("alias");
  });

  it("fuzzy-matches close spellings", () => {
    const match = matchMentionName("Brave Serch", catalog);
    expect(match.matched_app_id).toBe("github:brave/brave-search-mcp");
    expect(match.match_method).toBe("fuzzy");
  });

  it("leaves unknown tools unmatched", () => {
    expect(matchMentionName("Definitely Not A Real App XYZ", catalog).matched_app_id).toBeNull();
  });
});

describe("normalizeMentions", () => {
  it("attaches matched_app_id and rank is preserved", () => {
    const [row] = normalizeMentions(
      [
        {
          prompt_id: "coding-001",
          category: "coding",
          provider: "openai",
          run: 1,
          name: "filesystem MCP",
          rank: 1,
        },
      ],
      apps,
    );
    expect(row?.matched_app_id).toBe("github:modelcontextprotocol/servers");
    expect(row?.rank).toBe(1);
  });
});
