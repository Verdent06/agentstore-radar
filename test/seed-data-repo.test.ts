import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "seed-data-repo.sh");

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: "pipe" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "config user.email test@example.com");
  git(dir, "config user.name test");
}

describe("seed-data-repo.sh", () => {
  it("copies missing snapshot files and does not overwrite existing ones", () => {
    const root = mkdtempSync(join(tmpdir(), "radar-seed-"));
    const publicRepo = join(root, "public");
    const dataRepo = join(root, "data-repo");
    initRepo(publicRepo);
    initRepo(dataRepo);

    mkdirSync(join(publicRepo, "data/normalized/2026-10-15"), { recursive: true });
    mkdirSync(join(publicRepo, "data/raw/mcp-registry"), { recursive: true });
    writeFileSync(join(publicRepo, "data/normalized/2026-10-15/manifest.json"), '{"ok":true}\n');
    writeFileSync(join(publicRepo, "data/raw/mcp-registry/2026-10-15.json"), '{"n":1}\n');
    git(publicRepo, "add data");
    git(publicRepo, "commit -m seed");

    writeFileSync(join(dataRepo, "README.md"), "private data\n");
    git(dataRepo, "add README.md");
    git(dataRepo, "commit -m readme");

    execFileSync("bash", [script, publicRepo, dataRepo], { stdio: "pipe" });
    expect(existsSync(join(dataRepo, "data/normalized/2026-10-15/manifest.json"))).toBe(true);
    expect(existsSync(join(dataRepo, "data/raw/mcp-registry/2026-10-15.json"))).toBe(true);

    writeFileSync(join(dataRepo, "data/normalized/2026-10-15/manifest.json"), '{"kept":true}\n');
    mkdirSync(join(publicRepo, "data/raw/github"), { recursive: true });
    writeFileSync(join(publicRepo, "data/raw/github/2026-10-15.json"), '{"stars":1}\n');
    writeFileSync(join(publicRepo, "data/normalized/2026-10-15/manifest.json"), '{"replaced":true}\n');
    git(publicRepo, "add data");
    git(publicRepo, "commit -m more");

    execFileSync("bash", [script, publicRepo, dataRepo], { stdio: "pipe" });
    expect(existsSync(join(dataRepo, "data/raw/github/2026-10-15.json"))).toBe(true);
    expect(readFileSync(join(dataRepo, "data/normalized/2026-10-15/manifest.json"), "utf8")).toContain("kept");
  });
});
