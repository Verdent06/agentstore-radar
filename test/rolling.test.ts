import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  countFresh,
  isCarriedForward,
  loadCheckpoint,
  loadLastFetched,
  mergeLastFetched,
  persistCheckpoint,
  persistLastFetched,
  resumeDueKeys,
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
