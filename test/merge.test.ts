import { describe, expect, it } from "vitest";
import { mergeApps } from "../src/lib/merge.ts";
import { emptySourceRow } from "../src/lib/schema.ts";

describe("mergeApps", () => {
  it("joins catalog and enrichment rows on app_id", () => {
    const apps = mergeApps("2026-10-15", [
      emptySourceRow({
        snapshot_date: "2026-10-15",
        app_id: "github:example/weather",
        source: "mcp-registry",
        source_id: "io.github.example/weather",
        name: "io.github.example/weather",
        display_name: "Weather",
        npm_package: "@example/weather-mcp",
      }),
      emptySourceRow({
        snapshot_date: "2026-10-15",
        app_id: "github:example/weather",
        source: "github",
        source_id: "example/weather",
        name: "example/weather",
        stars: 42,
        forks: 7,
      }),
      emptySourceRow({
        snapshot_date: "2026-10-15",
        app_id: "github:example/weather",
        source: "npm",
        source_id: "@example/weather-mcp",
        name: "@example/weather-mcp",
        npm_package: "@example/weather-mcp",
        npm_weekly_downloads: 1234,
      }),
    ]);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      app_id: "github:example/weather",
      stars: 42,
      npm_weekly_downloads: 1234,
      display_name: "Weather",
    });
    expect(apps[0]?.sources.split("|")).toEqual(["github", "mcp-registry", "npm"]);
  });
});
