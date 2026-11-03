import { execFileSync, execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  git(dir, "config commit.gpgsign false");
  git(dir, "config core.fsmonitor false");
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
      env: {
        ...process.env,
        GITHUB_REF: "refs/heads/main",
        GIT_PUSH_ATTEMPTS: "3",
        GIT_PUSH_SLEEP_SECONDS: "0",
      },
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
    const output = execFileSync("bash", [script, checkout, "2026-10-19"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REF: "refs/heads/main" },
    });
    expect(output).toMatch(/No snapshot changes|removing broken snapshot file/);
    expect(git(checkout, "log --oneline")).not.toMatch(/2026-10-19/);
  });

  it("labels a checkpoint-only commit separately from a manifest snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "radar-push-checkpoint-"));
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

    mkdirSync(join(checkout, "data/state/pypi"), { recursive: true });
    writeFileSync(
      join(checkout, "data/state/pypi/checkpoint.json"),
      '{"snapshotDate":"2026-11-03","dueKeys":["left"],"nextIndex":10}\n',
    );
    execFileSync("bash", [script, checkout, "2026-11-03"], {
      stdio: "pipe",
      env: { ...process.env, GITHUB_REF: "refs/heads/main", GIT_PUSH_ATTEMPTS: "2", GIT_PUSH_SLEEP_SECONDS: "0" },
    });
    const log = git(checkout, "log --format=%s origin/main");
    expect(log).toMatch(/data: checkpoint 2026-11-03/);
    expect(log).not.toMatch(/data: snapshot 2026-11-03/);
  });

  it("commits unstaged checkpoint writes before the next pull --rebase retry", () => {
    const root = mkdtempSync(join(tmpdir(), "radar-push-retry-"));
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
    const checkpoint = join(second, "data/state/pypi/checkpoint.json");
    mkdirSync(join(second, "data/state/pypi"), { recursive: true });
    writeFileSync(checkpoint, '{"snapshotDate":"2026-11-03","nextIndex":0}\n');

    writeFileSync(join(first, "other.txt"), "remote moved\n");
    git(first, "add other.txt");
    git(first, "commit -m remote");
    git(first, "push origin main");

    const bin = join(root, "bin");
    mkdirSync(bin);
    const countFile = join(root, "pull-count");
    const wrapper = join(bin, "git");
    writeFileSync(
      wrapper,
      `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "pull" ]]; then
  n=0
  if [[ -f "${countFile}" ]]; then n=$(cat "${countFile}"); fi
  n=$((n + 1))
  echo "$n" > "${countFile}"
  if [[ "$n" == 1 ]]; then
    echo "resumed" >> "${checkpoint}"
  fi
fi
exec /usr/bin/git "$@"
`,
    );
    chmodSync(wrapper, 0o755);

    const output = execFileSync("bash", [script, second, "2026-11-03"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GITHUB_REF: "refs/heads/main",
        GIT_PUSH_ATTEMPTS: "4",
        GIT_PUSH_SLEEP_SECONDS: "0",
      },
    });
    expect(output).toMatch(/attempt 1 failed/);
    expect(output).toMatch(/succeeded on attempt/);
    const log = git(second, "log --format=%s origin/main");
    expect(log).toMatch(/data: checkpoint 2026-11-03/);
    expect(log).toMatch(/remote/);
    const published = git(second, "show origin/main:data/state/pypi/checkpoint.json");
    expect(published).toMatch(/resumed/);
    expect(published).toMatch(/2026-11-03/);
  });
});
