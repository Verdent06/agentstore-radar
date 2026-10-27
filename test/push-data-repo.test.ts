import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "push-data-repo.sh");

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "config user.email test@example.com");
  git(dir, "config user.name test");
}

describe("push-data-repo.sh", () => {
  it("rebases onto a remote commit and retries the push", () => {
    const root = mkdtempSync(join(tmpdir(), "radar-push-"));
    const origin = join(root, "origin.git");
    execSync(`git init --bare "${origin}"`, { encoding: "utf8" });

    const first = join(root, "first");
    initRepo(first);
    writeFileSync(join(first, "README.md"), "data\n");
    git(first, "add README.md");
    git(first, "commit -m init");
    git(first, `remote add origin "${origin}"`);
    git(first, "branch -M main");
    git(first, "push -u origin main");
    execSync(`git -C "${origin}" symbolic-ref HEAD refs/heads/main`);

    const second = join(root, "second");
    execSync(`git clone "${origin}" "${second}"`, { encoding: "utf8" });
    git(second, "config user.email test@example.com");
    git(second, "config user.name test");
    mkdirSync(join(second, "data/normalized/2026-10-24"), { recursive: true });
    writeFileSync(join(second, "data/normalized/2026-10-24/manifest.json"), '{"snapshotDate":"2026-10-24"}\n');
    writeFileSync(join(second, "data/normalized/2026-10-24/apps.ndjson"), "\n");
    writeFileSync(join(second, "data/normalized/2026-10-24/source_rows.ndjson"), "\n");

    writeFileSync(join(first, "other.txt"), "remote wins first\n");
    git(first, "add other.txt");
    git(first, "commit -m remote");
    git(first, "push origin main");

    execFileSync("bash", [script, second, "2026-10-24"], {
      stdio: "pipe",
      env: { ...process.env, GIT_PUSH_ATTEMPTS: "3", GIT_PUSH_SLEEP_SECONDS: "0" },
    });
    const log = git(second, "log --oneline origin/main");
    expect(log).toMatch(/snapshot 2026-10-24/);
    expect(log).toMatch(/remote/);
  });

  it("refuses to push to data main from a collector branch ref", () => {
    const root = mkdtempSync(join(tmpdir(), "radar-push-block-"));
    const origin = join(root, "origin.git");
    execSync(`git init --bare "${origin}"`, { encoding: "utf8" });
    const checkout = join(root, "checkout");
    initRepo(checkout);
    writeFileSync(join(checkout, "README.md"), "data\n");
    git(checkout, "add README.md");
    git(checkout, "commit -m init");
    git(checkout, `remote add origin "${origin}"`);
    git(checkout, "branch -M main");
    git(checkout, "push -u origin main");
    execSync(`git -C "${origin}" symbolic-ref HEAD refs/heads/main`);

    mkdirSync(join(checkout, "data/normalized/2026-10-27"), { recursive: true });
    writeFileSync(join(checkout, "data/normalized/2026-10-27/manifest.json"), '{"snapshotDate":"2026-10-27"}\n');
    writeFileSync(join(checkout, "data/normalized/2026-10-27/apps.ndjson"), "{}\n");
    writeFileSync(join(checkout, "data/normalized/2026-10-27/source_rows.ndjson"), "{}\n");

    expect(() =>
      execFileSync("bash", [script, checkout, "2026-10-27"], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REF: "refs/heads/cursor/daily-metric-freshness-d9ee",
          GIT_PUSH_ATTEMPTS: "1",
          GIT_PUSH_SLEEP_SECONDS: "0",
        },
      }),
    ).toThrow(/refusing to push to data main/);
    expect(git(checkout, "log --oneline origin/main")).not.toMatch(/snapshot 2026-10-27/);
  });

  it("drops a zero-size snapshot file instead of committing it", () => {
    const root = mkdtempSync(join(tmpdir(), "radar-push-empty-"));
    const origin = join(root, "origin.git");
    execSync(`git init --bare "${origin}"`, { encoding: "utf8" });
    const checkout = join(root, "checkout");
    initRepo(checkout);
    writeFileSync(join(checkout, "README.md"), "data\n");
    git(checkout, "add README.md");
    git(checkout, "commit -m init");
    git(checkout, `remote add origin "${origin}"`);
    git(checkout, "branch -M main");
    git(checkout, "push -u origin main");
    execSync(`git -C "${origin}" symbolic-ref HEAD refs/heads/main`);

    mkdirSync(join(checkout, "data/normalized"), { recursive: true });
    writeFileSync(join(checkout, "data/normalized/2026-10-19"), "");
    const output = execFileSync("bash", [script, checkout, "2026-10-19"], { encoding: "utf8" });
    expect(output).toMatch(/No snapshot changes|removing broken snapshot file/);
    expect(git(checkout, "log --oneline")).not.toMatch(/2026-10-19/);
  });
});
