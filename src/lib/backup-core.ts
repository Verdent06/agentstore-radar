import { appendFileSync } from "node:fs";
import { CORE_SOURCES, coreClean } from "./window-guard.ts";
import { inspectSnapshot, readManifest } from "./io.ts";
import type { SnapshotManifest, SourceManifest, SourceName } from "./schema.ts";

/**
 * Sources that decide whether a backup `--if-incomplete` run collects.
 * Same array `coreClean` reads. Smithery, gemini-cli, and pypi stay outside on purpose.
 */
export const BACKUP_CORE_SOURCES = CORE_SOURCES satisfies readonly SourceName[];

export type BackupCoreSource = (typeof BACKUP_CORE_SOURCES)[number];

const CORE_SOURCE_SET = new Set<string>(CORE_SOURCES);

/**
 * True when an `--if-incomplete` run still has to collect `source` for this
 * UTC date. Core sources follow `coreClean` reasons. Any other source is due
 * when it is missing, failed, truncated, or skipped. A core-clean source is
 * left alone. This does not change the `coreClean` rule.
 */
export function sourceDueOnIncompleteRun(
  manifest: SnapshotManifest | null | undefined,
  source: SourceName,
): boolean {
  if (!manifest || !Array.isArray(manifest.sources)) {
    return true;
  }
  if (CORE_SOURCE_SET.has(source)) {
    const reasons = coreClean(manifest).reasons;
    if (reasons.some((reason) => reason === "missing field sources")) {
      return true;
    }
    return reasons.some((reason) => reason.startsWith(`${source}:`));
  }
  const entry = manifest.sources.find((item) => item.source === source);
  if (!entry) {
    return true;
  }
  return entry.failed === true || entry.truncated === true || entry.skipped === true;
}

export type IfIncompleteDecision = {
  /** True when the backup should collect. */
  proceed: boolean;
  /** One line for the log, skip reason, and job summary. */
  reason: string;
  /** Markdown for `GITHUB_STEP_SUMMARY` when the backup skips. */
  summary?: string;
  manifest?: SnapshotManifest;
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatShare(share: number): string {
  return share.toFixed(3);
}

function sourceByName(manifest: SnapshotManifest, name: SourceName): SourceManifest | undefined {
  return manifest.sources.find((source) => source.source === name);
}

/** Log text only. The skip decision is `coreClean`. No previous rows scores 1. */
function loggedMcpShare(source: SourceManifest): number | null {
  if (typeof source.refetchedExisting === "number" && typeof source.existingRows === "number") {
    if (source.existingRows <= 0) {
      return 1;
    }
    return source.refetchedExisting / source.existingRows;
  }
  return typeof source.refetchedExistingShare === "number" ? source.refetchedExistingShare : null;
}

/**
 * Turn a `coreClean` reason into the backup log phrase.
 * The verdict itself is not decided here.
 */
function backupProblem(manifest: SnapshotManifest, reason: string): string {
  const match = /^([^:]+): (missing source|truncated|failed|skipped)$/.exec(reason);
  if (!match) {
    return reason;
  }
  const name = match[1] ?? reason;
  const kind = match[2];
  if (kind === "missing source") {
    return `${name} is missing`;
  }
  if (kind === "truncated") {
    return `${name} is truncated`;
  }
  if (kind === "skipped") {
    return `${name} did not complete`;
  }
  const source = manifest.sources.find((entry) => entry.source === name);
  const error = source?.error ? ` (${oneLine(source.error)})` : "";
  return `${name} failed${error}`;
}

function completionEvidence(manifest: SnapshotManifest): string {
  const evidence = BACKUP_CORE_SOURCES.map((name) => {
    const source = sourceByName(manifest, name);
    if (!source) {
      return `${name} completed`;
    }
    if (name === "mcp-registry") {
      const share = loggedMcpShare(source);
      const shareText = share == null ? "missing" : formatShare(share);
      return `${name} completed, refetchedExistingShare ${shareText}`;
    }
    const share = source.refetchedExistingShare;
    const shareText = share == null ? "missing" : formatShare(share);
    const mismatch = source.mismatchChangedNotFresh ?? 0;
    return `${name} completed, refetchedExistingShare ${shareText}, mismatchChangedNotFresh ${mismatch}`;
  });
  return `core sources complete (${evidence.join("; ")})`;
}

/**
 * Skip only when `coreClean` says the day is clean. Does not read `manifest.partial`.
 * A clean day keeps the previous job-summary wording.
 */
export function decideBackupCore(manifest: SnapshotManifest): IfIncompleteDecision {
  const verdict = coreClean(manifest);
  if (!verdict.clean) {
    const problems = verdict.reasons.map((reason) => backupProblem(manifest, reason));
    return {
      proceed: true,
      reason: `core sources are incomplete: ${problems.join("; ")}`,
      manifest,
    };
  }

  const reason = completionEvidence(manifest);
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
 * Missing, unreadable, or unparseable snapshots proceed. A readable manifest
 * is judged only by `decideBackupCore` (`coreClean`). Any read or parse
 * failure is not clean, so the backup collects, and the reason is returned
 * for the log. This function does not throw.
 */
export function decideIfIncompleteBackup(date: string, dataDir: string): IfIncompleteDecision {
  try {
    const inspection = inspectSnapshot(date, dataDir);
    if (!inspection.usable) {
      return {
        proceed: true,
        reason: inspection.reason ?? "missing",
      };
    }
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
