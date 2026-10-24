import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { listSnapshotDates } from "../lib/io.ts";
import { USER_AGENT } from "../lib/config.ts";
import { writeDemoSnapshots } from "./demo.ts";
import type { Aggregate, DataOrigin } from "./types.ts";

export const DEFAULT_DATA_REPO = "Verdent06/agentstore-radar-data";
/** Unique apps in `writeDemoSnapshots`. Private builds must exceed this. */
export const FIXTURE_APP_CEILING = 21;
export const DATA_TOKEN_ENV_KEYS = ["DATA_GITHUB_TOKEN", "GH_STATS_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] as const;

export type ResolveResult = {
  dataDir: string;
  origin: DataOrigin;
  tokenEnvName?: string;
  cleanup?: () => void;
};

export type DataToken = { name: (typeof DATA_TOKEN_ENV_KEYS)[number]; value: string };

function envValue(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function isEnvFlagSet(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function resolveDataGithubToken(env: NodeJS.ProcessEnv = process.env): DataToken | undefined {
  for (const name of DATA_TOKEN_ENV_KEYS) {
    // The default Actions token is for this public repo and cannot read the private data repo.
    if (name === "GITHUB_TOKEN" && isEnvFlagSet(env.GITHUB_ACTIONS)) {
      continue;
    }
    const value = env[name]?.trim();
    if (value) {
      return { name, value };
    }
  }
  return undefined;
}

export function shouldAllowFixture(options?: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  allowFixture?: boolean;
}): boolean {
  const argv = options?.argv ?? [];
  const env = options?.env ?? process.env;
  if (options?.allowFixture === false || argv.includes("--require-private")) {
    return false;
  }
  if (options?.allowFixture === true || argv.includes("--allow-fixture")) {
    return true;
  }
  if (isEnvFlagSet(env.ALLOW_FIXTURE)) {
    return true;
  }
  // Production/preview deploys and CI must not silently ship demo data.
  if (isEnvFlagSet(env.VERCEL) || isEnvFlagSet(env.CI)) {
    return false;
  }
  return true;
}

export function assertPrivateAggregate(agg: Pick<Aggregate, "meta" | "stats">): void {
  const reasons: string[] = [];
  if (agg.meta.source === "fixture" || agg.meta.origin === "fixture") {
    reasons.push("source is fixture/demo data");
  }
  if (agg.stats.appCount <= FIXTURE_APP_CEILING) {
    reasons.push(`app count ${agg.stats.appCount} ≤ ${FIXTURE_APP_CEILING} (fixture-sized)`);
  }
  if (reasons.length === 0) {
    return;
  }
  throw new Error(
    `Refusing to publish a non-private aggregate (${reasons.join("; ")}). ` +
      "Set DATA_GITHUB_TOKEN or DATA_DIR to the private data repo, or pass --allow-fixture for local/CI.",
  );
}

function redactSecret(text: string, secret: string): string {
  return secret && text.includes(secret) ? text.split(secret).join("***") : text;
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
    const detail = redactSecret(`${clone.stderr || clone.stdout}`, token);
    throw new Error(`git clone failed for ${repo}: ${detail}`);
  }
  const sparse = spawnSync("git", ["sparse-checkout", "set", "data/normalized"], {
    cwd: dest,
    encoding: "utf8",
  });
  if (sparse.status !== 0) {
    throw new Error(`git sparse-checkout failed: ${redactSecret(`${sparse.stderr || sparse.stdout}`, token)}`);
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
  const answerShare = entries.find((item) => item.type === "dir" && item.name === "answer-share");
  if (answerShare) {
    const shareList = await fetch(answerShare.url, { headers });
    if (shareList.ok) {
      const dates = (await shareList.json()) as Array<{ name: string; type: string; url: string }>;
      for (const dateDir of dates.filter((item) => item.type === "dir" && /^\d{4}-\d{2}-\d{2}$/.test(item.name))) {
        const filesRes = await fetch(dateDir.url, { headers });
        if (!filesRes.ok) {
          continue;
        }
        const files = (await filesRes.json()) as Array<{ name: string; download_url: string | null }>;
        const destDir = join(destNormalized, "answer-share", dateDir.name);
        mkdirSync(destDir, { recursive: true });
        for (const file of files.filter((item) => item.name === "shares.json" && item.download_url)) {
          const fileRes = await fetch(file.download_url!, {
            headers: { "User-Agent": USER_AGENT, Authorization: `Bearer ${token}` },
          });
          if (fileRes.ok) {
            writeFileSync(join(destDir, file.name), Buffer.from(await fileRes.arrayBuffer()));
          }
        }
      }
    }
  }
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
  options?: { dataDir?: string; env?: NodeJS.ProcessEnv; allowFixture?: boolean; argv?: string[] },
): Promise<ResolveResult> {
  const env = options?.env ?? process.env;
  const allowFixture = shouldAllowFixture(options);
  const explicit = options?.dataDir?.trim() || env.DATA_DIR?.trim();
  if (explicit && existsSync(explicit) && hasSnapshots(explicit)) {
    return { dataDir: explicit, origin: "data_dir" };
  }

  const token = resolveDataGithubToken(env);
  const repo = envValue(env, "DATA_REPO") ?? DEFAULT_DATA_REPO;
  if (token) {
    console.log(`[aggregate] token from ${token.name}`);
    const dest = mkdtempSync(join(tmpdir(), "radar-data-"));
    const cleanup = () => {
      rmSync(dest, { recursive: true, force: true });
    };
    try {
      cloneDataRepo(repo, token.value, dest);
      const dataDir = join(dest, "data");
      if (hasSnapshots(dataDir)) {
        return { dataDir, origin: "github", tokenEnvName: token.name, cleanup };
      }
      await downloadViaApi(repo, token.value, join(dest, "data", "normalized"));
      if (hasSnapshots(dataDir)) {
        return { dataDir, origin: "github", tokenEnvName: token.name, cleanup };
      }
      cleanup();
    } catch (error) {
      cleanup();
      const message = redactSecret(error instanceof Error ? error.message : String(error), token.value);
      if (!allowFixture) {
        throw new Error(
          `Failed to load private snapshot data using ${token.name}: ${message}`,
        );
      }
      console.warn(`[aggregate] private data unavailable (${message}); using fixture snapshots`);
    }
  }

  if (!allowFixture) {
    throw new Error(
      "Private snapshot data is required. Set DATA_GITHUB_TOKEN (read access to Verdent06/agentstore-radar-data) or DATA_DIR, " +
        "or pass --allow-fixture / ALLOW_FIXTURE=1 for local and CI fixture builds.",
    );
  }
  const dest = mkdtempSync(join(tmpdir(), "radar-fixture-"));
  writeDemoSnapshots(dest);
  return {
    dataDir: dest,
    origin: "fixture",
    cleanup: () => rmSync(dest, { recursive: true, force: true }),
  };
}
