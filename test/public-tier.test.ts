import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate/build.ts";
import { writeDemoSnapshots } from "../src/aggregate/demo.ts";
import {
  HISTORY_CAP_DAYS,
  PUBLIC_MAX_LIMIT,
  PUBLIC_TOP_N,
  growthBucket,
  historyCutoffDate,
  round2sf,
} from "../src/aggregate/public.ts";
import { clampLimit, findApp, movers, publicAppIds, rankHistory, searchApps, topChart } from "../src/aggregate/query.ts";
import { runTool } from "../src/aggregate/tools.ts";
import { addUtcDays } from "../src/lib/dates.ts";
import { writeNormalized } from "../src/lib/io.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { emptySourceRow, type SnapshotManifest } from "../src/lib/schema.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

function writeDay(
  dataDir: string,
  date: string,
  rows: Array<{ id: string; name?: string; useCount?: number; stars?: number }>,
  partial = false,
): void {
  const sourceRows = rows.flatMap((row) => {
    const out = [];
    if (row.useCount != null) {
      out.push(
        emptySourceRow({
          snapshot_date: date,
          app_id: row.id,
          source: "smithery",
          source_id: row.id,
          name: row.name ?? row.id,
          display_name: row.name ?? row.id,
          use_count: row.useCount,
        }),
      );
    }
    if (row.stars != null) {
      out.push(
        emptySourceRow({
          snapshot_date: date,
          app_id: row.id,
          source: "github",
          source_id: row.id.replace(/^github:/, ""),
          name: row.name ?? row.id,
          display_name: row.name ?? row.id,
          stars: row.stars,
        }),
      );
    }
    return out;
  });
  const apps = mergeApps(date, sourceRows);
  const manifest: SnapshotManifest = {
    snapshotDate: date,
    collectedAt: `${date}T12:00:00.000Z`,
    appCount: apps.length,
    sourceRowCount: sourceRows.length,
    sources: [],
    ...(partial ? { partial: true } : {}),
  };
  writeNormalized(date, sourceRows, apps, manifest, dataDir);
}

describe("free-tier rounding", () => {
  it("round2sf(12345) = 12000 and 987 = 990", () => {
    expect(round2sf(12345)).toBe(12000);
    expect(round2sf(987)).toBe(990);
    expect(round2sf(72000)).toBe(72000);
    expect(round2sf(0)).toBe(0);
  });

  it("growth buckets work at their edges", () => {
    expect(growthBucket(0.009)).toBe("<1%");
    expect(growthBucket(0.01)).toBe("1–5%");
    expect(growthBucket(0.049)).toBe("1–5%");
    expect(growthBucket(0.05)).toBe("5–10%");
    expect(growthBucket(0.1)).toBe("10–25%");
    expect(growthBucket(0.25)).toBe("25–50%");
    expect(growthBucket(0.5)).toBe("50–100%");
    expect(growthBucket(0.99)).toBe("50–100%");
    expect(growthBucket(1)).toBe(">100%");
    expect(growthBucket(-0.05)).toBe("−5–10%");
    expect(growthBucket(-1.2)).toBe("−>100%");
    expect(growthBucket(null)).toBeNull();
  });
});

describe("history window", () => {
  it("keeps only the last 14 calendar days", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-hist-"));
    const latest = "2026-10-15";
    const cutoff = historyCutoffDate(latest);
    expect(cutoff).toBe("2026-10-02");
    for (let offset = 20; offset >= 0; offset -= 1) {
      const date = addUtcDays(latest, -offset);
      writeDay(dataDir, date, [{ id: "github:example/a", useCount: 100 + offset }]);
    }
    const agg = buildAggregate(dataDir, "fixture");
    expect(agg.meta.snapshotDates.length).toBeLessThanOrEqual(HISTORY_CAP_DAYS);
    expect(agg.meta.snapshotDates.every((date) => date >= cutoff)).toBe(true);
    expect(agg.meta.snapshotDates).not.toContain("2026-10-01");
    expect(JSON.stringify(agg)).not.toContain("2026-09-25");
    const history = rankHistory(agg, agg.apps[0]!.id, "use_count");
    expect(history.length).toBeLessThanOrEqual(HISTORY_CAP_DAYS);
  });
});

describe("list caps and public app pages", () => {
  it("caps every list at 10 and 404s apps outside the public top-10 union", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-cap-"));
    const ids = Array.from({ length: 20 }, (_, index) => ({
      id: `github:example/app-${String(index + 1).padStart(2, "0")}`,
      name: `App ${index + 1}`,
      useCount: (index + 1) * 1000,
    }));
    writeDay(
      dataDir,
      "2026-10-14",
      ids.map((row, index) => ({ ...row, useCount: row.useCount - (index + 1) * 100 })),
    );
    writeDay(dataDir, "2026-10-15", ids);
    const agg = buildAggregate(dataDir, "fixture");

    expect(topChart(agg, "smithery", 50).length).toBeLessThanOrEqual(PUBLIC_TOP_N);
    expect(searchApps(agg, "", { limit: 50 }).length).toBeLessThanOrEqual(PUBLIC_TOP_N);
    expect(movers(agg, { window: "1d", metric: "use_count", limit: 50 }).length).toBeLessThanOrEqual(PUBLIC_TOP_N * 2);
    expect(clampLimit(50)).toBe(PUBLIC_MAX_LIMIT);
    expect(agg.apps.length).toBeLessThanOrEqual(ids.length);
    expect(findApp(agg, "github:example/app-01")).toBeUndefined();
    expect(publicAppIds(agg).has("github:example/app-01")).toBe(false);

    const page = readFileSync(join(repoRoot, "web/app/apps/[id]/page.tsx"), "utf8");
    expect(page).toContain("dynamicParams = false");
    expect(page).toContain("generateStaticParams");
  });

  it("does not ship the full aggregate to a client component", () => {
    const webRoot = join(repoRoot, "web");
    const clientFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(tsx|ts)$/.test(entry.name)) continue;
        const text = readFileSync(path, "utf8");
        if (text.includes('"use client"') || text.includes("'use client'")) {
          clientFiles.push(path);
          expect(text).not.toMatch(/loadAggregate/);
          expect(text).not.toMatch(/radar\.json/);
        }
      }
    };
    walk(join(webRoot, "app"));
    walk(join(webRoot, "components"));
    expect(clientFiles.length).toBeGreaterThan(0);
  });
});

describe("partial snapshot exclusion", () => {
  it("skips a partial day in the middle of a growth window", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-partial-mid-"));
    writeDay(dataDir, "2026-10-13", [{ id: "github:example/a", name: "A", stars: 100 }]);
    writeDay(dataDir, "2026-10-14", [{ id: "github:example/a", name: "A", stars: 10_000 }], true);
    writeDay(dataDir, "2026-10-15", [{ id: "github:example/a", name: "A", stars: 130 }]);
    const agg = buildAggregate(dataDir, "fixture");
    expect(agg.meta.partialDates).toEqual(["2026-10-14"]);
    const rows = movers(agg, { window: "1d", metric: "stars" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.previous).toBe(100);
    expect(rows[0]?.current).toBe(130);
    expect(rows[0]?.delta).toBe(30);
  });

  it("uses the latest complete day when the newest snapshot is partial", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-partial-latest-"));
    writeDay(dataDir, "2026-10-13", [{ id: "github:example/a", name: "A", stars: 100 }]);
    writeDay(dataDir, "2026-10-14", [{ id: "github:example/a", name: "A", stars: 130 }]);
    writeDay(dataDir, "2026-10-15", [{ id: "github:example/a", name: "A", stars: 10_000 }], true);
    const agg = buildAggregate(dataDir, "fixture");
    expect(agg.meta.latestCompleteDate).toBe("2026-10-14");
    expect(agg.meta.previousCompleteDate).toBe("2026-10-13");
    const rows = movers(agg, { window: "1d", metric: "stars" });
    expect(rows[0]).toMatchObject({ previous: 100, current: 130, delta: 30 });
    const payload = JSON.parse(runTool(agg, "movers", { window: "1d", metric: "stars" }).content[0]!.text);
    expect(payload.from).toBe("2026-10-13");
    expect(payload.to).toBe("2026-10-14");
    expect(payload.partialDates).toEqual(["2026-10-15"]);
  });
});

describe("built radar.json never holds exact fixture counts", () => {
  it("rounds demo counts and buckets growth", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-round-"));
    writeDemoSnapshots(dataDir);
    const agg = buildAggregate(dataDir, "fixture");
    const json = JSON.stringify(agg);
    expect(json).not.toContain("87579");
    expect(json).not.toContain("299294");
    const brave = agg.apps.find((app) => app.id === "github:brave/brave-search-mcp");
    expect(brave?.useCount).toBe(round2sf(87579));
    const weekly = movers(agg, { window: "7d", metric: "use_count" }).find((row) => row.id === "github:brave/brave-search-mcp");
    expect(weekly?.growth).toMatch(/%$/);
    expect(weekly).not.toHaveProperty("pct");
  });
});
