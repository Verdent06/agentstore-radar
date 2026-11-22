import { appendFileSync } from "node:fs";
import { inspectSnapshot, readManifest } from "./io.ts";
import { meetsRefetchedExistingCoverage, REFETCH_EXISTING_MIN_SHARE } from "./refetch-coverage.ts";
import type { SnapshotManifest, SourceManifest, SourceName } from "./schema.ts";

/**
 * Sources that decide whether a backup `--if-incomplete` run collects.
 * Smithery, gemini-cli, and pypi are outside this list on purpose.
 */
export const BACKUP_CORE_SOURCES = ["mcp-registry", "github", "npm"] as const satisfies readonly SourceName[];

export type BackupCoreSource = (typeof BACKUP_CORE_SOURCES)[number];

/** Core sources whose refetch share and mismatch A also gate a backup rerun. */
const BACKUP_REFETCH_SOURCES = ["github", "npm"] as const satisfies readonly BackupCoreSource[];

/** mcp-registry must be fully fetched. Same bar as `coreClean` in window-guard. */
const MCP_FULL_FETCH_SHARE = 1;

export type IfIncompleteDecision = {
  /** True when the backup should collect. */
  proceed: boolean;
  /** One line for the log, skip reason, and job summary. */
  reason: string;
  /** Markdown for `GITHUB_STEP_SUMMARY` when the backup skips. */
  summary?: string;
  manifest?: SnapshotManifest;
};

function isRefetchSource(source: string): source is (typeof BACKUP_REFETCH_SOURCES)[number] {
  return (BACKUP_REFETCH_SOURCES as readonly string[]).includes(source);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatShare(share: number): string {
  return share.toFixed(3);
}

function sourceByName(manifest: SnapshotManifest, name: SourceName): SourceManifest | undefined {
  return manifest.sources.find((source) => source.source === name);
}

/** Same rule as the collector and `coreClean`: no previous rows scores 1. */
function computedRefetchShare(refetchedExisting: number, existingRows: number): number {
  if (existingRows <= 0) {
    return 1;
  }
  return refetchedExisting / existingRows;
}

/**
 * mcp-registry refetch share, from `refetchedExisting / existingRows` when those
 * counts are present. Recorded `refetchedExistingShare` is the fallback.
 */
function mcpRefetchShare(source: SourceManifest): number | null {
  if (typeof source.refetchedExisting === "number" && typeof source.existingRows === "number") {
    return computedRefetchShare(source.refetchedExisting, source.existingRows);
  }
  return typeof source.refetchedExistingShare === "number" ? source.refetchedExistingShare : null;
}

function mcpRefetchShareProblem(source: SourceManifest): string | undefined {
  const refetched = source.refetchedExisting;
  const existing = source.existingRows;
  if (typeof refetched === "number" && typeof existing === "number") {
    const share = computedRefetchShare(refetched, existing);
    const recorded = source.refetchedExistingShare;
    if (typeof recorded === "number" && Math.abs(recorded - share) > 1e-9) {
      return `mcp-registry refetchedExistingShare ${formatShare(recorded)} does not match refetchedExisting/existingRows ${formatShare(share)}`;
    }
  }
  const share = mcpRefetchShare(source);
  if (share == null) {
    return "mcp-registry refetchedExistingShare is missing";
  }
  if (share < MCP_FULL_FETCH_SHARE) {
    return `mcp-registry refetchedExistingShare ${formatShare(share)} is below ${MCP_FULL_FETCH_SHARE}`;
  }
  return undefined;
}

/**
 * Core-complete means each of mcp-registry, github, and npm finished and is
 * not truncated, mcp-registry refetch share is exactly 1, and github and npm
 * have `refetchedExistingShare` >= 0.9 with `mismatchChangedNotFresh` not above 0.
 * Does not read `manifest.partial`.
 */
export function decideBackupCore(manifest: SnapshotManifest): IfIncompleteDecision {
  const problems: string[] = [];
  for (const name of BACKUP_CORE_SOURCES) {
    const source = sourceByName(manifest, name);
    if (!source) {
      problems.push(`${name} is missing`);
      continue;
    }
    if (source.failed === true) {
      const error = source.error ? ` (${oneLine(source.error)})` : "";
      problems.push(`${name} failed${error}`);
    } else if (source.truncated === true) {
      problems.push(`${name} is truncated`);
    } else if (source.skipped === true) {
      problems.push(`${name} did not complete`);
    }
    if (name === "mcp-registry") {
      const problem = mcpRefetchShareProblem(source);
      if (problem) {
        problems.push(problem);
      }
      continue;
    }
    if (!isRefetchSource(name)) {
      continue;
    }
    const share = source.refetchedExistingShare;
    if (share == null || !meetsRefetchedExistingCoverage(share)) {
      problems.push(
        share == null
          ? `${name} refetchedExistingShare is missing`
          : `${name} refetchedExistingShare ${formatShare(share)} is below ${REFETCH_EXISTING_MIN_SHARE}`,
      );
    }
    const mismatch = source.mismatchChangedNotFresh ?? 0;
    if (mismatch > 0) {
      problems.push(`${name} mismatchChangedNotFresh is ${mismatch}`);
    }
  }

  if (problems.length > 0) {
    return {
      proceed: true,
      reason: `core sources are incomplete: ${problems.join("; ")}`,
      manifest,
    };
  }

  const evidence = BACKUP_CORE_SOURCES.map((name) => {
    const source = sourceByName(manifest, name);
    if (!source) {
      return `${name} completed`;
    }
    if (name === "mcp-registry") {
      const share = mcpRefetchShare(source);
      const shareText = share == null ? "missing" : formatShare(share);
      return `${name} completed, refetchedExistingShare ${shareText}`;
    }
    if (!isRefetchSource(name)) {
      return `${name} completed`;
    }
    const share = source.refetchedExistingShare;
    const shareText = share == null ? "missing" : formatShare(share);
    const mismatch = source.mismatchChangedNotFresh ?? 0;
    return `${name} completed, refetchedExistingShare ${shareText}, mismatchChangedNotFresh ${mismatch}`;
  });
  const reason = `core sources complete (${evidence.join("; ")})`;
  return {
    proceed: false,
    reason,
    summary: formatBackupSkipSummary(manifest.snapshotDate, reason, manifest),
    manifest,
  };
}

function formatBackupSkipSummary(date: string, reason: string, manifest: SnapshotManifest): string {
  const ignored = manifest.sources
    .filter((source) => !(BACKUP_CORE_SOURCES as readonly string[]).includes(source.source))
    .filter((source) => source.failed === true || source.truncated === true)
    .map((source) => {
      const state = source.failed === true ? "failed" : "truncated";
      const error = source.error ? `: ${oneLine(source.error)}` : "";
      return `- ${source.source} ${state}${error}`;
    });
  const lines = [
    `### Backup skipped ${date}`,
    "",
    "`--if-incomplete` left this snapshot in place. Core sources (mcp-registry, github, npm) are complete, so this backup did not collect.",
    "",
    reason,
    "",
    "Smithery, gemini-cli, and pypi do not trigger a backup rerun by themselves.",
  ];
  if (ignored.length > 0) {
    lines.push("", ...ignored);
  }
  lines.push("", "The manifest `partial` flag was not changed.", "");
  return lines.join("\n");
}

/**
 * Missing or unreadable snapshots proceed. A usable manifest is judged only
 * by `decideBackupCore`.
 */
export function decideIfIncompleteBackup(date: string, dataDir: string): IfIncompleteDecision {
  const inspection = inspectSnapshot(date, dataDir);
  if (!inspection.usable) {
    return {
      proceed: true,
      reason: inspection.reason ?? "missing",
    };
  }
  try {
    return decideBackupCore(readManifest(date, dataDir));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      proceed: true,
      reason: `unreadable manifest: ${oneLine(message)}`,
    };
  }
}

/** Workflow gate. Writes `skip=true|false` and the job summary when skipping. */
export function publishIfIncompleteGate(
  date: string,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): IfIncompleteDecision {
  const decision = decideIfIncompleteBackup(date, dataDir);
  const output = env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `skip=${decision.proceed ? "false" : "true"}\n`);
  }
  if (!decision.proceed && decision.summary) {
    const summary = env.GITHUB_STEP_SUMMARY;
    if (summary) {
      appendFileSync(summary, decision.summary.endsWith("\n") ? decision.summary : `${decision.summary}\n`);
    }
  }
  return decision;
}
