import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { writeDemoSnapshots } from "../src/aggregate/demo.ts";
import {
  assertPrivateAggregate,
  FIXTURE_APP_CEILING,
  resolveDataGithubToken,
  resolveSnapshotRoot,
  shouldAllowFixture,
} from "../src/aggregate/load.ts";
import { buildPublicAggregate } from "../scripts/build-aggregate.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "DATA_GITHUB_TOKEN",
    "GH_STATS_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "DATA_DIR",
    "DATA_REPO",
    "ALLOW_FIXTURE",
    "VERCEL",
    "CI",
  ]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

describe("resolveDataGithubToken", () => {
  it("prefers DATA_GITHUB_TOKEN over collector and Actions tokens", () => {
    expect(
      resolveDataGithubToken({
        DATA_GITHUB_TOKEN: " data-pat ",
        GH_STATS_TOKEN: "stats",
        GITHUB_TOKEN: "actions",
        GH_TOKEN: "gh",
      }),
    ).toEqual({ name: "DATA_GITHUB_TOKEN", value: "data-pat" });
  });

  it("walks GH_STATS_TOKEN, then GITHUB_TOKEN, then GH_TOKEN", () => {
    expect(resolveDataGithubToken({ GH_STATS_TOKEN: "stats", GITHUB_TOKEN: "actions" })).toEqual({
      name: "GH_STATS_TOKEN",
      value: "stats",
    });
    expect(resolveDataGithubToken({ GITHUB_TOKEN: "actions", GH_TOKEN: "gh" })).toEqual({
      name: "GITHUB_TOKEN",
      value: "actions",
    });
    expect(resolveDataGithubToken({ GH_TOKEN: "gh" })).toEqual({ name: "GH_TOKEN", value: "gh" });
    expect(resolveDataGithubToken({})).toBeUndefined();
  });

  it("ignores the default Actions GITHUB_TOKEN so CI does not clone with it", () => {
    expect(
      resolveDataGithubToken({
        GITHUB_ACTIONS: "true",
        GITHUB_TOKEN: "ghs_actions",
        GH_TOKEN: "gh",
      }),
    ).toEqual({ name: "GH_TOKEN", value: "gh" });
    expect(
      resolveDataGithubToken({
        GITHUB_ACTIONS: "true",
        DATA_GITHUB_TOKEN: "data-pat",
        GITHUB_TOKEN: "ghs_actions",
      }),
    ).toEqual({ name: "DATA_GITHUB_TOKEN", value: "data-pat" });
    expect(resolveDataGithubToken({ GITHUB_ACTIONS: "true", GITHUB_TOKEN: "ghs_actions" })).toBeUndefined();
  });
});

describe("shouldAllowFixture", () => {
  it("denies fixtures when --require-private, VERCEL, or CI is set", () => {
    expect(shouldAllowFixture({ argv: ["--require-private"], env: {} })).toBe(false);
    expect(shouldAllowFixture({ argv: ["--allow-fixture", "--require-private"], env: {} })).toBe(false);
    expect(shouldAllowFixture({ env: { VERCEL: "1" } })).toBe(false);
    expect(shouldAllowFixture({ env: { CI: "true" } })).toBe(false);
  });

  it("allows fixtures via explicit opt-in even in CI", () => {
    expect(shouldAllowFixture({ argv: ["--allow-fixture"], env: { CI: "true" } })).toBe(true);
    expect(shouldAllowFixture({ env: { CI: "true", ALLOW_FIXTURE: "1" } })).toBe(true);
  });

  it("allows fixtures by default for local (non-CI, non-Vercel) builds", () => {
    expect(shouldAllowFixture({ argv: [], env: {} })).toBe(true);
  });
});

describe("buildPublicAggregate", () => {
  it("fails without a token when --require-private is set", async () => {
    const out = mkdtempSync(join(tmpdir(), "radar-priv-"));
    await expect(
      buildPublicAggregate(["--require-private", "--out", out], cleanEnv()),
    ).rejects.toThrow(/Private snapshot data is required|DATA_GITHUB_TOKEN/);
  });

  it("fails in Vercel/CI without a token even without the flag", async () => {
    const out = mkdtempSync(join(tmpdir(), "radar-ci-"));
    await expect(buildPublicAggregate(["--out", out], cleanEnv({ CI: "true" }))).rejects.toThrow(
      /Private snapshot data is required/,
    );
    await expect(buildPublicAggregate(["--out", out], cleanEnv({ VERCEL: "1" }))).rejects.toThrow(
      /Private snapshot data is required/,
    );
  });

  it("builds fixtures with meta.source=fixture when explicitly opted in", async () => {
    const out = mkdtempSync(join(tmpdir(), "radar-fix-"));
    await buildPublicAggregate(["--allow-fixture", "--out", out], cleanEnv({ CI: "true" }));
    const radar = JSON.parse(readFileSync(join(out, "radar.json"), "utf8")) as {
      meta: { source: string; origin: string };
      stats: { appCount: number };
    };
    const sidecar = JSON.parse(readFileSync(join(out, "meta.json"), "utf8")) as { source: string };
    expect(radar.meta.source).toBe("fixture");
    expect(radar.meta.origin).toBe("fixture");
    expect(sidecar.source).toBe("fixture");
    expect(radar.stats.appCount).toBe(FIXTURE_APP_CEILING);
  });

  it("builds fixtures with no flag outside CI/Vercel", async () => {
    const out = mkdtempSync(join(tmpdir(), "radar-local-"));
    await buildPublicAggregate(["--out", out], cleanEnv());
    const radar = JSON.parse(readFileSync(join(out, "radar.json"), "utf8")) as {
      meta: { source: string };
    };
    expect(radar.meta.source).toBe("fixture");
  });

  it("refuses fixture-sized DATA_DIR under --require-private", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-data-"));
    writeDemoSnapshots(dataDir);
    const out = mkdtempSync(join(tmpdir(), "radar-refuse-"));
    await expect(
      buildPublicAggregate(["--require-private", "--data", dataDir, "--out", out], cleanEnv()),
    ).rejects.toThrow(/non-private aggregate|fixture-sized|source is fixture/);
  });

  it("exits non-zero from the CLI without a token and --require-private", () => {
    const out = mkdtempSync(join(tmpdir(), "radar-cli-"));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/build-aggregate.ts", "--require-private", "--out", out],
      {
        cwd: repoRoot,
        env: cleanEnv({ CI: "true" }),
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/Private snapshot data is required|DATA_GITHUB_TOKEN/);
  });
});

describe("resolveSnapshotRoot", () => {
  it("does not fall back to fixtures when allowFixture is false", async () => {
    await expect(resolveSnapshotRoot({ env: cleanEnv(), allowFixture: false })).rejects.toThrow(
      /Private snapshot data is required/,
    );
  });
});

describe("assertPrivateAggregate", () => {
  it("rejects fixture origin even if app count is high", () => {
    expect(() =>
      assertPrivateAggregate({
        meta: { source: "fixture", origin: "fixture" } as never,
        stats: { appCount: 500 } as never,
      }),
    ).toThrow(/source is fixture/);
  });
});
