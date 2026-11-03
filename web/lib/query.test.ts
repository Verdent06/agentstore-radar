import { describe, expect, it } from "vitest";
import { topChart } from "./query";
import type { Aggregate, AppSummary } from "./types";

function starChartAggregate(): Aggregate {
  const app = (id: string, stars: number, starsScope: "host_repo" | "own_repo"): AppSummary => ({
    id,
    name: id,
    displayName: id,
    description: null,
    homepage: null,
    repoUrl: null,
    npmPackage: null,
    pypiPackage: null,
    sources: ["github", "claude-plugins"],
    stores: [],
    category: "other",
    firstSeen: "2026-11-01",
    lastSeen: "2026-11-02",
    stars,
    forks: null,
    openIssues: null,
    pushedAt: null,
    npmWeeklyDownloads: null,
    pypiLastWeekDownloads: null,
    geminiStars: null,
    verified: null,
    starsScope,
  });
  return {
    meta: {
      builtAt: "2026-11-02T00:00:00Z",
      origin: "fixture",
      source: "fixture",
      snapshotDates: ["2026-11-01", "2026-11-02"],
      latestDate: "2026-11-02",
      previousDate: "2026-11-01",
      weekAgoDate: null,
      partialDates: [],
      latestCompleteDate: "2026-11-02",
      previousCompleteDate: "2026-11-01",
      coverage: [],
    },
    stats: {
      appCount: 2,
      storeCount: 0,
      snapshotCount: 2,
      latestDate: "2026-11-02",
      previousDate: "2026-11-01",
      weekAgoDate: null,
      totalStars: 0,
      totalNpmWeekly: 0,
      multiStoreCount: 0,
      newArrivalCount: 0,
      categoryCount: 1,
    },
    apps: [
      app("github:adobe/skills", 8000, "host_repo"),
      app("github:example/only-plugin", 40, "own_repo"),
    ],
    series: {
      "github:adobe/skills": { s: [1000, 8000] },
      "github:example/only-plugin": { s: [10, 40] },
    },
    answerShare: null,
  };
}

describe("web topChart stars", () => {
  it("nulls previousValue and delta for a host_repo app", () => {
    const rows = topChart(starChartAggregate(), "github", 10);
    expect(rows.find((row) => row.app.id === "github:adobe/skills")).toMatchObject({
      value: 8000,
      previousValue: null,
      delta: null,
    });
    expect(rows.find((row) => row.app.id === "github:example/only-plugin")).toMatchObject({
      previousValue: 10,
      delta: 30,
    });
  });
});
