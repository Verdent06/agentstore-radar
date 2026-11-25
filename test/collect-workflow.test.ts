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
  it("runs every schedule as one if-incomplete recover-npm collect", () => {
    const crons = [...workflow.matchAll(/cron: "([^"]+)"/g)].map((match) => match[1]);
    expect(crons).toEqual(["20 0 * * *", "41 5 * * *", "47 8 * * *", "23 19 * * *"]);
    const minutes = crons.map((cron) => cron.split(" ")[0]);
    for (const minute of minutes) {
      expect(["0", "15", "30"]).not.toContain(minute);
    }
    expect(workflow).toMatch(/group: collect-snapshots/);
    expect(workflow).toMatch(/cancel-in-progress: false/);
    expect(workflow).toMatch(/actions: write/);
    expect(workflow).not.toMatch(/^\s*strategy:/m);
    expect(workflow).not.toMatch(/matrix:/);
    expect(workflow).not.toMatch(/\n {2}npm:/);

    const collect = jobBlock("collect");
    expect(collect).toContain("NON_NPM_SOURCES");
    expect(collect).toContain('"$part" != "npm"');
    expect(collect).toContain("npm lane must not run in the main collect source list");
    expect(collect).toContain("npm is recovered after the other sources; it cannot be the only source");
    expect(collect).toContain("--recover-npm");
    expect(collect).toContain("--if-incomplete");
    expect(collect).toContain("RADAR_COLLECT_STEP_DEADLINE_MS");
    expect(collect).toContain("RADAR_COLLECT_CHAIN");
    expect(collect).toContain("timeout-minutes: 340");
    expect(collect).toContain('steps.collect.outputs.wrote != \'false\'');
    expect(collect).toContain("chain_dispatch == 'true'");
    expect(collect).toContain("gh workflow run collect.yml");
    expect(collect).toContain("-f if_incomplete=true");
    expect(collect).not.toContain("--sources npm");
    expect(workflow.match(/--recover-npm/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
