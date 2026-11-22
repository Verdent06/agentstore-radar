import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { githubAdapter } from "../src/adapters/github.ts";
import { npmAdapter } from "../src/adapters/npm.ts";
import type { SourceResult } from "../src/adapters/types.ts";
import { collect } from "../src/commands/collect.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { readManifest, writeNormalized } from "../src/lib/io.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { emptySourceRow, type SnapshotManifest, type SourceName, type SourceRow } from "../src/lib/schema.ts";

const pushScript = join(dirname(fileURLToPath(import.meta.url)), "../scripts/push-data-repo.sh");
const silent = { info() {}, warn() {}, error() {} };
const originalGithub = githubAdapter.collect;
const originalNpm = npmAdapter.collect;

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8" });
}

function initRepo(dir: string): void {
  execSync(`git init "${dir}"`, { encoding: "utf8" });
  git(dir, "config user.email test@example.com");
  git(dir, "config user.name test");
  git(dir, "config commit.gpgsign false");
  git(dir, "config core.fsmonitor false");
}

function rows(date: string, source: SourceName, count: number, fresh: number, at: string): SourceRow[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `${source}-${index}`;
    const isFresh = index < fresh;
    return emptySourceRow({
      snapshot_date: date,
      app_id: `${source}:${id}`,
      source,
      source_id: id,
      name: id,
      stars: source === "github" ? 10 + index : null,
      npm_package: source === "npm" ? id : null,
      npm_weekly_downloads: source === "npm" ? 10 + index : null,
      fetched_at: isFresh ? at : "2026-11-19T00:00:00.000Z",
      carried_forward: !isFresh,
      frozen: false,
    });
  });
}

function result(source: SourceName, records: SourceRow[], at: string): SourceResult {
  return {
    source,
    collectedAt: at,
    rowCount: records.length,
    skipped: false,
    records,
    raw: { rows: records.length },
    eligibleCount: records.length,
    freshTodayCount: records.filter((row) => row.carried_forward !== true).length,
    fetchedThisRunCount: records.filter((row) => row.carried_forward !== true).length,
  };
}

function push(repo: string, date: string): void {
  execFileSync("bash", [pushScript, repo, date], {
    stdio: "pipe",
    env: { ...process.env, GITHUB_REF: "refs/heads/main", GIT_PUSH_ATTEMPTS: "3", GIT_PUSH_SLEEP_SECONDS: "0" },
  });
}

afterEach(() => {
  githubAdapter.collect = originalGithub;
  npmAdapter.collect = originalNpm;
});

describe("snapshot writers", () => {
  it.each(["github", "npm"] as const)(
    "keeps the other source's refetch share when %s is pushed second",
    async (second) => {
      const root = mkdtempSync(join(tmpdir(), "radar-writers-"));
      const origin = join(root, "origin.git");
      execSync(`git init --bare "${origin}"`, { encoding: "utf8" });
      const firstRepo = join(root, "first");
      initRepo(firstRepo);
      writeFileSync(join(firstRepo, "README.md"), "data\n");
      git(firstRepo, "add README.md");
      git(firstRepo, "commit -m init");
      git(firstRepo, `remote add origin "${origin}"`);
      git(firstRepo, "branch -M main");
      git(firstRepo, "push -u origin main");
      execSync(`git -C "${origin}" symbolic-ref HEAD refs/heads/main`);

      const prev = "2026-11-20";
      const day = "2026-11-21";
      const at = `${day}T12:00:00.000Z`;
      const baseline = [...rows(prev, "github", 100, 100, `${prev}T12:00:00.000Z`), ...rows(prev, "npm", 100, 100, `${prev}T12:00:00.000Z`)];
      const manifest: SnapshotManifest = {
        snapshotDate: prev,
        collectedAt: `${prev}T12:00:00.000Z`,
        appCount: baseline.length,
        sourceRowCount: baseline.length,
        partial: false,
        sources: [
          { source: "github", rowCount: 100, skipped: false, collectedAt: `${prev}T12:00:00.000Z` },
          { source: "npm", rowCount: 100, skipped: false, collectedAt: `${prev}T12:00:00.000Z` },
        ],
      };
      const dataDir = join(firstRepo, "data");
      writeNormalized(prev, baseline, mergeApps(prev, baseline), manifest, dataDir);
      git(firstRepo, "add -A");
      git(firstRepo, `commit -m "data: snapshot ${prev}"`);
      git(firstRepo, "push origin main");

      const secondRepo = join(root, "second");
      execSync(`git clone "${origin}" "${secondRepo}"`, { encoding: "utf8" });
      git(secondRepo, "config user.email test@example.com");
      git(secondRepo, "config user.name test");
      git(secondRepo, "config commit.gpgsign false");

      const githubRows = rows(day, "github", 100, 98, at);
      const npmRows = rows(day, "npm", 100, 98, at);
      githubAdapter.collect = async () => result("github", githubRows, at);
      npmAdapter.collect = async () => result("npm", npmRows, at);

      const run = async (repo: string, source: "github" | "npm") => {
        git(repo, "pull --rebase origin main");
        const outcome = await collect({
          date: day,
          dataDir: join(repo, "data"),
          sources: [source],
          now: new Date(at),
          http: createHttpClient({
            fetchImpl: async () => {
              throw new Error("stubbed source must not fetch");
            },
            maxRetries: 0,
          }),
          log: silent,
          sourceAttempts: 1,
          sleep: async () => {},
        });
        expect(outcome.wrote).toBe(true);
        push(repo, day);
      };

      const firstSource = second === "github" ? "npm" : "github";
      await run(firstRepo, firstSource);
      await run(secondRepo, second);
      git(firstRepo, "pull --rebase origin main");

      const written = readManifest(day, join(firstRepo, "data"));
      expect(written.sources.map((source) => source.source).sort()).toEqual(["github", "npm"]);
      expect(written.sources.find((source) => source.source === "github")?.refetchedExistingShare).toBeCloseTo(0.98, 5);
      expect(written.sources.find((source) => source.source === "npm")?.refetchedExistingShare).toBeCloseTo(0.98, 5);
      const commits = git(firstRepo, "log --oneline origin/main");
      expect(commits).toMatch(new RegExp(`snapshot ${day}`));
    },
  );
});
