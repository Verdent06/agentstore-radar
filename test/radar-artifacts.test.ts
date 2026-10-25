import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN = [
  "web/data/radar.json",
  "web/data/radar.sqlite",
  "mcp/data/radar.json",
  "mcp/data/radar.sqlite",
] as const;

function gitLines(args: string[]): string[] {
  return execFileSync("git", args, { encoding: "utf8", cwd: repoRoot })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function listOriginMain(): string[] {
  try {
    return gitLines(["ls-tree", "-r", "--name-only", "origin/main"]);
  } catch {
    execFileSync("git", ["fetch", "--depth", "1", "origin", "main"], { cwd: repoRoot });
    return gitLines(["ls-tree", "-r", "--name-only", "origin/main"]);
  }
}

describe("generated radar aggregates stay unpublished", () => {
  it("neither git ls-files nor origin/main tracks radar.json or radar.sqlite", () => {
    const tracked = gitLines(["ls-files"]);
    for (const path of FORBIDDEN) {
      expect(tracked).not.toContain(path);
    }
    expect(tracked.filter((path) => /(?:^|\/)radar\.(json|sqlite)$/.test(path))).toEqual([]);

    const mainFiles = listOriginMain();
    for (const path of FORBIDDEN) {
      expect(mainFiles).not.toContain(path);
    }
    expect(mainFiles.filter((path) => /(?:^|\/)radar\.(json|sqlite)$/.test(path))).toEqual([]);
  });

  it("mcp package publish contents exclude data/radar.*", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "mcp/package.json"), "utf8")) as { files?: string[] };
    expect(pkg.files).toEqual(["src", "Dockerfile", "tsconfig.json"]);
    expect(pkg.files?.some((entry) => /(^|\/)data(\/|$)/.test(entry) || /radar\.(json|sqlite)/.test(entry))).toBe(false);

    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], {
        encoding: "utf8",
        cwd: join(repoRoot, "mcp"),
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const paths = packed[0]?.files.map((file) => file.path) ?? [];
    expect(paths.filter((path) => path.startsWith("data/") || /radar\.(json|sqlite)$/.test(path))).toEqual([]);
  });
});
