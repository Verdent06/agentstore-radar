import { describe, expect, it } from "vitest";
import { computeLeaders, computeMovers, formatReport } from "../src/commands/report.ts";
import { emptySourceRow } from "../src/lib/schema.ts";
import { mergeApps } from "../src/lib/merge.ts";

describe("report", () => {
  it("ranks day-over-day movers and current leaders", () => {
    const previous = mergeApps("2026-10-14", [
      emptySourceRow({
        snapshot_date: "2026-10-14",
        app_id: "github:example/weather",
        source: "github",
        source_id: "example/weather",
        name: "weather",
        stars: 40,
        use_count: 10,
      }),
    ]);
    const current = mergeApps("2026-10-15", [
      emptySourceRow({
        snapshot_date: "2026-10-15",
        app_id: "github:example/weather",
        source: "github",
        source_id: "example/weather",
        name: "weather",
        stars: 50,
        use_count: 8,
      }),
    ]);
    const movers = computeMovers(previous, current);
    expect(movers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "stars", delta: 10 }),
        expect.objectContaining({ metric: "use_count", delta: -2 }),
      ]),
    );
    const leaders = computeLeaders(current, 5);
    expect(leaders.find((group) => group.metric === "stars")?.rows[0]?.app_id).toBe("github:example/weather");
    const text = formatReport({
      from: "2026-10-14",
      to: "2026-10-15",
      movers,
      leaders,
    });
    expect(text).toContain("Top movers");
    expect(text).toContain("+10");
    const withCoverage = formatReport({
      from: "2026-10-14",
      to: "2026-10-15",
      movers,
      leaders,
      coverage: [
        {
          source: "github",
          coverage: 0.86,
          eligibleCount: 30746,
          freshWithin7dCount: 26558,
          fetchedThisRunCount: 992,
          skipped: false,
        },
      ],
    });
    expect(withCoverage).toContain("26558/30746 fresh within 7d");
    expect(withCoverage).toContain("992 this run");
    expect(withCoverage).not.toMatch(/26558\/30746 eligible/);
  });
});
