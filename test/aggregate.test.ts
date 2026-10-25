import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate/build.ts";
import { writeDemoSnapshots } from "../src/aggregate/demo.ts";
import { writeAggregateFiles } from "../src/aggregate/write.ts";
import { readFileSync } from "node:fs";

describe("buildAggregate", () => {
  it("builds compact public summaries from dated snapshots", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-agg-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "fixture");

    expect(agg.meta.origin).toBe("fixture");
    expect(agg.meta.source).toBe("fixture");
    expect(agg.meta.snapshotDates).toEqual(["2026-10-08", "2026-10-14", "2026-10-15"]);
    expect(agg.meta.latestDate).toBe("2026-10-15");
    expect(agg.meta.previousDate).toBe("2026-10-14");
    expect(agg.meta.weekAgoDate).toBe("2026-10-08");
    expect(agg.meta.partialDates).toEqual([]);
    expect(agg.stats.appCount).toBeGreaterThan(10);
    expect(agg.stats.multiStoreCount).toBeGreaterThan(0);

    const brave = agg.apps.find((app) => app.id === "github:brave/brave-search-mcp");
    expect(brave?.useCount).toBe(88000);
    expect(brave?.category).toBe("search");
    expect(agg.series[brave!.id]?.u).toEqual([72000, 85000, 88000]);

    const linear = agg.apps.find((app) => app.id === "github:example/linear-mcp");
    if (linear) {
      expect(linear.firstSeen).toBe("2026-10-15");
    }

    const gemini = agg.apps.find((app) => app.id === "github:obra/superpowers");
    expect(gemini?.geminiStars).toBe(300000);

    const weather = agg.apps.find((app) => app.id === "github:example/weather");
    expect(weather?.stores).toEqual(expect.arrayContaining(["mcp-registry", "smithery", "npm"]));

    const out = mkdtempSync(join(tmpdir(), "radar-out-"));
    const written = writeAggregateFiles(agg, out);
    const parsed = JSON.parse(readFileSync(written.json, "utf8"));
    expect(parsed.apps).toHaveLength(agg.apps.length);
    expect(JSON.stringify(parsed)).not.toMatch(/source_rows/);
    expect(agg.answerShare?.probeDate).toBe("2026-10-13");
    expect(agg.answerShare?.overall[0]?.appId).toBe("github:brave/brave-search-mcp");
  });

  it("records meta.source=private when origin is a live data dir", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-priv-src-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "data_dir");
    expect(agg.meta.origin).toBe("data_dir");
    expect(agg.meta.source).toBe("private");
  });

  it("does not treat a single snapshot as having movers windows", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-one-"));
    writeDemoSnapshots(dataDir, ["2026-10-15"]);
    const agg = buildAggregate(dataDir, "fixture");
    expect(agg.meta.previousDate).toBeNull();
    expect(agg.meta.partialDates).toEqual([]);
    expect(agg.stats.snapshotCount).toBe(1);
    expect(agg.answerShare).toBeNull();
  });
});
