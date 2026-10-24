import { describe, expect, it } from "vitest";
import { resolveHealthIssueRepo } from "../src/commands/health.ts";
import { resolveDataDir } from "../src/lib/io.ts";

describe("resolveDataDir", () => {
  it("prefers --data, then DATA_DIR, then ./data", () => {
    expect(resolveDataDir("/tmp/radar", { DATA_DIR: "/env/data" })).toBe("/tmp/radar");
    expect(resolveDataDir(undefined, { DATA_DIR: "/env/data" })).toBe("/env/data");
    expect(resolveDataDir("  ", {})).toBe("data");
    expect(resolveDataDir(undefined, {})).toBe("data");
  });
});

describe("resolveHealthIssueRepo", () => {
  it("uses this repo via GITHUB_REPOSITORY and does not require HEALTH_ISSUE_TOKEN", () => {
    expect(
      resolveHealthIssueRepo({
        GITHUB_REPOSITORY: "Verdent06/agentstore-radar",
      }),
    ).toBe("Verdent06/agentstore-radar");
    expect(
      resolveHealthIssueRepo({
        HEALTH_ISSUE_REPO: "Verdent06/agentstore-radar-data",
        GITHUB_REPOSITORY: "Verdent06/agentstore-radar",
      }),
    ).toBe("Verdent06/agentstore-radar-data");
  });
});
