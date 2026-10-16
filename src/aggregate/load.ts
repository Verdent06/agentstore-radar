import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { listSnapshotDates } from "../lib/io.ts";
import { USER_AGENT } from "../lib/config.ts";
import { writeDemoSnapshots } from "./demo.ts";
import type { DataOrigin } from "./types.ts";

export const DEFAULT_DATA_REPO = "Verdent06/agentstore-radar-data";

export type ResolveResult = {
  dataDir: string;
  origin: DataOrigin;
  cleanup?: () => void;
};

function envValue(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function hasSnapshots(dataDir: string): boolean {
  return listSnapshotDates(dataDir).length > 0;
}

function cloneDataRepo(repo: string, token: string, dest: string): void {
  const url = `https://x-access-token:${token}@github.com/${repo}.git`;
  const clone = spawnSync(
    "git",
    ["clone", "--depth", "1", "--filter=blob:none", "--sparse", url, dest],
    { encoding: "utf8" },
  );
  if (clone.status !== 0) {
    throw new Error(`git clone failed for ${repo}: ${clone.stderr || clone.stdout}`);
  }
  const sparse = spawnSync("git", ["sparse-checkout", "set", "data/normalized"], {
    cwd: dest,
    encoding: "utf8",
  });
  if (sparse.status !== 0) {
    throw new Error(`git sparse-checkout failed: ${sparse.stderr || sparse.stdout}`);
  }
}

async function downloadViaApi(repo: string, token: string, destNormalized: string): Promise<void> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const listUrl = `https://api.github.com/repos/${repo}/contents/data/normalized`;
  const listRes = await fetch(listUrl, { headers });
  if (!listRes.ok) {
    throw new Error(`GitHub API ${listRes.status} listing ${repo} data/normalized`);
  }
  const entries = (await listRes.json()) as Array<{ name: string; type: string; url: string }>;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  for (const entry of entries.filter((item) => item.type === "dir" && /^\d{4}-\d{2}-\d{2}$/.test(item.name))) {
    const dirRes = await fetch(entry.url, { headers });
    if (!dirRes.ok) {
      throw new Error(`GitHub API ${dirRes.status} listing ${entry.name}`);
    }
    const files = (await dirRes.json()) as Array<{ name: string; download_url: string | null }>;
    const destDir = join(destNormalized, entry.name);
    mkdirSync(destDir, { recursive: true });
    for (const file of files) {
      if (!file.download_url) {
        continue;
      }
      if (!/^(apps\.ndjson(?:\.gz)?|source_rows\.ndjson(?:\.gz)?|manifest\.json)$/.test(file.name)) {
        continue;
      }
      const fileRes = await fetch(file.download_url, { headers: { "User-Agent": USER_AGENT, Authorization: `Bearer ${token}` } });
      if (!fileRes.ok) {
        throw new Error(`Failed to download ${entry.name}/${file.name}: ${fileRes.status}`);
      }
      writeFileSync(join(destDir, file.name), Buffer.from(await fileRes.arrayBuffer()));
    }
  }
}

export async function resolveSnapshotRoot(
  options?: { dataDir?: string; env?: NodeJS.ProcessEnv; allowFixture?: boolean },
): Promise<ResolveResult> {
  const env = options?.env ?? process.env;
  const explicit = options?.dataDir?.trim() || env.DATA_DIR?.trim();
  if (explicit && existsSync(explicit) && hasSnapshots(explicit)) {
    return { dataDir: explicit, origin: "data_dir" };
  }

  const token = envValue(env, "DATA_GITHUB_TOKEN", "GH_STATS_TOKEN", "GITHUB_TOKEN", "GH_TOKEN");
  const repo = envValue(env, "DATA_REPO") ?? DEFAULT_DATA_REPO;
  if (token) {
    const dest = mkdtempSync(join(tmpdir(), "radar-data-"));
    const cleanup = () => {
      rmSync(dest, { recursive: true, force: true });
    };
    try {
      cloneDataRepo(repo, token, dest);
      const dataDir = join(dest, "data");
      if (hasSnapshots(dataDir)) {
        return { dataDir, origin: "github", cleanup };
      }
      await downloadViaApi(repo, token, join(dest, "data", "normalized"));
      if (hasSnapshots(dataDir)) {
        return { dataDir, origin: "github", cleanup };
      }
      cleanup();
    } catch (error) {
      cleanup();
      if (options?.allowFixture === false) {
        throw error;
      }
      console.warn(`[aggregate] private data unavailable (${error instanceof Error ? error.message : error}); using fixture snapshots`);
    }
  }

  if (options?.allowFixture === false) {
    throw new Error("No snapshots found. Set DATA_DIR or DATA_GITHUB_TOKEN / GITHUB_TOKEN.");
  }
  const dest = mkdtempSync(join(tmpdir(), "radar-fixture-"));
  writeDemoSnapshots(dest);
  return {
    dataDir: dest,
    origin: "fixture",
    cleanup: () => rmSync(dest, { recursive: true, force: true }),
  };
}
