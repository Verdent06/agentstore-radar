import { describe, expect, it } from "vitest";
import { KPI_HELD_LOW_FRESH_COVERAGE, formatKpis } from "./kpis";

const baseStats = {
  appCount: 44,
  storeCount: 5,
  totalNpmWeekly: 12_000,
  totalStars: 8_800,
  snapshotCount: 14,
  latestDate: "2026-10-25",
  latestCompleteDate: "2026-10-24",
};

describe("formatKpis", () => {
  it("shows latestCompleteDate in npm and stars hints", () => {
    const items = formatKpis({
      ...baseStats,
      npmFreshCount: 4_535,
      starsFreshCount: 4_535,
    });
    const npm = items.find((item) => item.label === "npm / week");
    const stars = items.find((item) => item.label === "GitHub stars");
    expect(npm?.hint).toContain("fresh on 2026-10-24");
    expect(stars?.hint).toContain("fresh on 2026-10-24");
    expect(items.map((item) => item.hint).join(" ")).not.toContain("fresh today");
    expect(npm?.hint).not.toContain("2026-10-25");
    expect(stars?.hint).not.toContain("2026-10-25");
  });

  it("displays across n fresh packages with n rounded to 2 significant figures", () => {
    const items = formatKpis({
      ...baseStats,
      npmKpiHeld: false,
      starsKpiHeld: false,
      npmFreshCount: 4_535,
      starsFreshCount: 603,
    });
    const npm = items.find((item) => item.label === "npm / week");
    const stars = items.find((item) => item.label === "GitHub stars");
    expect(npm?.value).toBe("12K");
    expect(npm?.hint).toContain("across 4,500 fresh packages");
    expect(stars?.hint).toContain("across 600 fresh packages");
    expect(npm?.hint).toMatch(/across \d[\d,]* fresh packages/);
    expect(stars?.hint).toMatch(/across \d[\d,]* fresh packages/);
  });

  it("holds a KPI with a plain held: low fresh coverage state instead of a number", () => {
    const items = formatKpis({
      ...baseStats,
      totalNpmWeekly: 999_999,
      totalStars: 888_888,
      npmKpiHeld: true,
      starsKpiHeld: true,
      npmFreshCount: 603,
      starsFreshCount: 603,
    });
    const npm = items.find((item) => item.label === "npm / week");
    const stars = items.find((item) => item.label === "GitHub stars");
    expect(npm?.value).toBe(KPI_HELD_LOW_FRESH_COVERAGE);
    expect(stars?.value).toBe("held: low fresh coverage");
    expect(npm?.value).not.toMatch(/\d/);
    expect(stars?.value).not.toMatch(/\d/);
    expect(npm?.value).not.toBe("1000K");
    expect(stars?.value).not.toBe("889K");
    expect(npm?.hint).toBe("");
    expect(stars?.hint).toBe("");
  });

  it("does not surface Smithery use_count or Gemini stars KPIs", () => {
    const labels = formatKpis(baseStats).map((item) => item.label).join(" ");
    expect(labels).not.toMatch(/use_count|useCount|Smithery|Gemini/i);
  });
});
