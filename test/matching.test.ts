import { describe, expect, it } from "vitest";
import {
  appIdFromIdentity,
  githubRepoFromMcpName,
  normalizePackageName,
  parseGithubRepo,
  relinkPackageAppIds,
} from "../src/lib/matching.ts";

describe("parseGithubRepo", () => {
  it("normalizes web, git, and ssh URLs", () => {
    expect(parseGithubRepo("https://github.com/Example/Weather.git")).toEqual({
      owner: "example",
      repo: "weather",
    });
    expect(parseGithubRepo("git@github.com:Example/Weather.git")).toEqual({
      owner: "example",
      repo: "weather",
    });
    expect(parseGithubRepo("https://www.github.com/Example/Weather/tree/main")).toEqual({
      owner: "example",
      repo: "weather",
    });
  });

  it("rejects non-github values", () => {
    expect(parseGithubRepo("https://gitlab.com/example/weather")).toBeNull();
    expect(parseGithubRepo("https://mygithub.com/acme/widget")).toBeNull();
    expect(parseGithubRepo("https://example.com/docs?ref=github.com/unrelated/other")).toBeNull();
    expect(parseGithubRepo(undefined)).toBeNull();
  });
});

describe("appIdFromIdentity", () => {
  it("prefers github, then package, then source id", () => {
    expect(
      appIdFromIdentity({
        repoUrl: "https://github.com/Example/Weather",
        npmPackage: "@example/weather-mcp",
        source: "mcp-registry",
        sourceId: "io.github.example/weather",
      }),
    ).toBe("github:example/weather");
    expect(
      appIdFromIdentity({
        npmPackage: "@Example/Weather-MCP",
        source: "mcp-registry",
        sourceId: "com.example/weather",
      }),
    ).toBe("npm:@example/weather-mcp");
    expect(
      appIdFromIdentity({
        pypiPackage: "Example_Files",
        source: "mcp-registry",
        sourceId: "com.example/files",
      }),
    ).toBe("pypi:example-files");
    expect(
      appIdFromIdentity({
        source: "smithery",
        sourceId: "brave",
      }),
    ).toBe("smithery:brave");
  });
});

describe("githubRepoFromMcpName", () => {
  it("maps io.github.* registry names", () => {
    expect(githubRepoFromMcpName("io.github.example/weather")).toEqual({
      owner: "example",
      repo: "weather",
    });
  });
});

describe("normalizePackageName", () => {
  it("lowercases and canonicalizes pypi names", () => {
    expect(normalizePackageName("Example_Files", "pypi")).toBe("example-files");
    expect(normalizePackageName("@Example/Pkg", "npm")).toBe("@example/pkg");
  });
});

describe("relinkPackageAppIds", () => {
  it("attaches npm/pypi enrichment to the github app_id from the catalog", () => {
    const rows = relinkPackageAppIds([
      {
        source: "mcp-registry",
        app_id: "github:example/weather",
        npm_package: "@example/weather-mcp",
      },
      {
        source: "npm",
        app_id: "npm:@example/weather-mcp",
        npm_package: "@example/weather-mcp",
      },
    ]);
    expect(rows[1]?.app_id).toBe("github:example/weather");
  });
});
