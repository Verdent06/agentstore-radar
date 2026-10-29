import { describe, expect, it } from "vitest";
import { formatKpis } from "./kpis";

describe("formatKpis", () => {
  it("shows latestCompleteDate in npm and stars hints", () => {
    const items = formatKpis({
      appCount: 44,
      storeCount: 5,
      totalNpmWeekly: 12_000,
      totalStars: 8_800,
      snapshotCount: 14,
      latestDate: "2026-10-25",
      latestCompleteDate: "2026-10-24",
    });
    const npm = items.find((item) => item.label === "npm / week");
    const stars = items.find((item) => item.label === "GitHub stars");
    expect(npm?.hint).toBe("fresh on 2026-10-24");
    expect(stars?.hint).toBe("fresh on 2026-10-24");
    expect(items.map((item) => item.hint).join(" ")).not.toContain("fresh today");
    expect(npm?.hint).not.toContain("2026-10-25");
    expect(stars?.hint).not.toContain("2026-10-25");
  });
});
