import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../.github/workflows/collect.yml"),
  "utf8",
);

function jobBlock(name: string): string {
  const marker = `\n  ${name}:`;
  const start = workflow.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n {2}[a-z0-9-]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("collect workflow", () => {
  it("runs npm in its own early job and keeps a single concurrency group", () => {
    const minutes = [...workflow.matchAll(/cron: "(\d+) \d+/g)].map((match) => match[1]);
    expect(minutes).toContain("20");
    expect(minutes).toEqual(["20", "41", "47", "23"]);
    for (const minute of minutes) {
      expect(["0", "15", "30"]).not.toContain(minute);
    }
    expect(workflow).toMatch(/group: collect-snapshots/);
    expect(workflow).toMatch(/cancel-in-progress: false/);
    expect(workflow).not.toMatch(/^\s*strategy:/m);
    expect(workflow).not.toMatch(/matrix:/);

    const collect = jobBlock("collect");
    const npm = jobBlock("npm");
    expect(collect).toContain("NON_NPM_SOURCES");
    expect(collect).toContain('"$part" != "npm"');
    expect(collect).toContain("npm lane must not run in the main collect source list");
    expect(collect).toContain("--recover-npm");
    expect(collect).toContain("RADAR_COLLECT_STEP_DEADLINE_MS");
    expect(collect).toContain("timeout-minutes: 340");
    expect(collect).not.toContain("--sources npm");
    expect(npm).toContain("needs: [collect]");
    expect(npm).toContain("timeout-minutes: 355");
    expect(npm).toContain("timeout-minutes: 345");
    expect(npm).toContain("--sources npm");
    expect(npm).toContain("github.event.schedule == '20 0 * * *'");
    expect(npm).not.toContain("47 8");
    expect(npm).not.toContain("23 19");
    expect(workflow.match(/--sources npm/g)).toHaveLength(1);
  });
});
