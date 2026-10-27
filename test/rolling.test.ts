import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  countFresh,
  countFreshToday,
  isCarriedForward,
  loadCheckpoint,
  loadLastFetched,
  mergeLastFetched,
  persistCheckpoint,
  persistLastFetched,
  prioritizeKeys,
  prioritizeStalestFirst,
  resumeDailyDueKeys,
  selectRunBatch,
  takeRunBatch,
  resumeDueKeys,
  selectDailyDueKeys,
  selectDueKeys,
} from "../src/lib/rolling.ts";

describe("rolling last_fetched", () => {
  const now = new Date("2026-10-15T12:00:00Z");

  it("selects never-fetched and stale keys, keeps fresh ones", () => {
    const lastFetched = {
      "a/fresh": "2026-10-14T00:00:00Z",
      "b/stale": "2026-10-01T00:00:00Z",
    };
    expect(selectDueKeys(["a/fresh", "b/stale", "c/new"], lastFetched, now)).toEqual(["b/stale", "c/new"]);
    expect(countFresh(["a/fresh", "b/stale", "c/new"], lastFetched, now)).toBe(1);
  });

  it("merges newly fetched timestamps", () => {
    const merged = mergeLastFetched({ "a/fresh": "2026-10-14T00:00:00Z" }, ["c/new"], "2026-10-15T12:00:00Z");
    expect(merged["c/new"]).toBe("2026-10-15T12:00:00Z");
    expect(merged["a/fresh"]).toBe("2026-10-14T00:00:00Z");
  });

  it("resumes a same-day checkpoint and skips keys that became fresh", () => {
    const lastFetched = {
      "a/one": "2026-10-15T11:00:00Z",
      "b/two": "2026-10-01T00:00:00Z",
    };
    const { dueKeys, resumed } = resumeDueKeys(
      ["a/one", "b/two", "c/three"],
      lastFetched,
      now,
      "2026-10-15",
      {
        snapshotDate: "2026-10-15",
        dueKeys: ["a/one", "b/two", "c/three"],
        nextIndex: 1,
        startedAt: "2026-10-15T11:00:00Z",
      },
    );
    expect(resumed).toBe(true);
    expect(dueKeys).toEqual(["b/two", "c/three"]);
  });

  it("selects every key not fetched on this UTC snapshot date", () => {
    const lastFetched = {
      "a/today": "2026-10-15T06:00:00Z",
      "b/yesterday": "2026-10-14T12:00:00Z",
    };
    expect(selectDailyDueKeys(["a/today", "b/yesterday", "c/new"], lastFetched, "2026-10-15")).toEqual([
      "b/yesterday",
      "c/new",
    ]);
    expect(countFreshToday(["a/today", "b/yesterday", "c/new"], lastFetched, "2026-10-15")).toBe(1);
  });

  it("resumes a daily checkpoint without re-fetching keys that landed today", () => {
    const { dueKeys, resumed } = resumeDailyDueKeys(
      ["a/one", "b/two", "c/three"],
      { "a/one": "2026-10-15T11:00:00Z" },
      "2026-10-15",
      {
        snapshotDate: "2026-10-15",
        dueKeys: ["a/one", "b/two", "c/three"],
        nextIndex: 1,
        startedAt: "2026-10-15T11:00:00Z",
      },
    );
    expect(resumed).toBe(true);
    expect(dueKeys).toEqual(["b/two", "c/three"]);
  });

  it("orders keys by score without scrambling ties", () => {
    expect(prioritizeKeys(["low", "high", "also-low"], (key) => (key === "high" ? 10 : 1))).toEqual([
      "high",
      "low",
      "also-low",
    ]);
  });

  it("rotates the stalest keys first and caps the run batch", () => {
    const lastFetched = {
      fresh: "2026-10-26T12:00:00Z",
      mid: "2026-10-20T12:00:00Z",
      older: "2026-10-10T12:00:00Z",
    };
    expect(prioritizeStalestFirst(["fresh", "missing", "mid", "older"], lastFetched)).toEqual([
      "missing",
      "older",
      "mid",
      "fresh",
    ]);
    expect(takeRunBatch(["a", "b", "c", "d"], 2)).toEqual(["a", "b"]);
    expect(
      selectRunBatch(["fresh", "mid", "older", "missing"], lastFetched, 2, (key) => (key === "older" ? 9 : 1)),
    ).toEqual(["missing", "older"]);
  });

  it("treats same-day last_fetched as live, not carried_forward", () => {
    expect(isCarriedForward("2026-10-24T11:07:24.740Z", "2026-10-24", "2026-10-24T19:48:02.231Z")).toBe(false);
    expect(isCarriedForward("2026-10-24T19:48:02.231Z", "2026-10-24", "2026-10-24T19:48:02.231Z")).toBe(false);
    expect(isCarriedForward("2026-10-18T12:00:00.000Z", "2026-10-24")).toBe(true);
    expect(isCarriedForward(undefined, "2026-10-24")).toBe(true);
  });

  it("persists last_fetched and checkpoints under data/state", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-roll-"));
    persistLastFetched(dataDir, "github", { "example/weather": "2026-10-15T00:00:00Z" });
    persistCheckpoint(dataDir, "github", {
      snapshotDate: "2026-10-15",
      dueKeys: ["example/weather"],
      nextIndex: 0,
      startedAt: "2026-10-15T00:00:00Z",
    });
    expect(loadLastFetched(dataDir, "github")["example/weather"]).toBe("2026-10-15T00:00:00Z");
    expect(loadCheckpoint(dataDir, "github")?.dueKeys).toEqual(["example/weather"]);
  });
});
