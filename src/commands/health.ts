import { COLLECTOR_ISSUE_REPO_DEFAULT, HEALTH_DROP_THRESHOLD, LOW_COVERAGE_THRESHOLD, REPO_URL } from "../lib/config.ts";
import { formatCoveragePct, isLowCoverage } from "../lib/coverage.ts";
import { utcDateString } from "../lib/dates.ts";
import { createGitHubIssueClient } from "../lib/github-issue.ts";
import { listSnapshotDates, previousSnapshotDate, readManifest, resolveDataDir } from "../lib/io.ts";
import { createLogger, type Logger } from "../lib/logger.ts";
import { sourceFreshWithin7dCount, type SourceManifest, type SourceName } from "../lib/schema.ts";

export type HealthFinding = {
  source: SourceName;
  previousDate: string;
  currentDate: string;
  previousCount: number;
  currentCount: number;
  dropRatio: number;
};

export type CoverageFinding = {
  source: SourceName;
  currentDate: string;
  coverage: number;
  eligibleCount: number;
  freshTodayCount: number;
  freshWithin7dCount: number;
  threshold: number;
};

export type HealthReport = {
  ok: boolean;
  currentDate: string;
  previousDate?: string;
  findings: HealthFinding[];
  coverageFindings: CoverageFinding[];
};

export type IssueOpener = (input: {
  title: string;
  body: string;
  labels: string[];
}) => Promise<{ created: boolean; url?: string; reason?: string }>;

export type HealthOptions = {
  date?: string;
  dataDir?: string;
  threshold?: number;
  log?: Logger;
  now?: Date;
  openIssue?: IssueOpener;
};

function sourceMap(sources: SourceManifest[]): Map<SourceName, SourceManifest> {
  return new Map(sources.map((source) => [source.source, source]));
}

export function compareSourceHealth(
  current: SourceManifest,
  previous: SourceManifest,
  currentDate: string,
  previousDate: string,
  threshold = HEALTH_DROP_THRESHOLD,
): HealthFinding | null {
  if (current.skipped || previous.skipped) {
    return null;
  }
  if (previous.rowCount === 0) {
    return null;
  }
  const dropRatio = (previous.rowCount - current.rowCount) / previous.rowCount;
  if (dropRatio <= threshold) {
    return null;
  }
  return {
    source: current.source,
    previousDate,
    currentDate,
    previousCount: previous.rowCount,
    currentCount: current.rowCount,
    dropRatio,
  };
}

export function evaluateHealth(options: HealthOptions = {}): HealthReport {
  const now = options.now ?? new Date();
  const dataDir = resolveDataDir(options.dataDir);
  const dates = listSnapshotDates(dataDir);
  const currentDate = options.date ?? dates.at(-1);
  if (!currentDate) {
    return { ok: true, currentDate: utcDateString(now), findings: [], coverageFindings: [] };
  }
  const previousDate = previousSnapshotDate(currentDate, dataDir);
  const current = readManifest(currentDate, dataDir);
  const coverageThreshold = LOW_COVERAGE_THRESHOLD;
  const coverageFindings = collectCoverageFindings(current.sources, currentDate, coverageThreshold);
  if (!previousDate) {
    return {
      ok: coverageFindings.length === 0,
      currentDate,
      findings: [],
      coverageFindings,
    };
  }
  const previous = readManifest(previousDate, dataDir);
  const previousSources = sourceMap(previous.sources);
  const threshold = options.threshold ?? HEALTH_DROP_THRESHOLD;
  const findings: HealthFinding[] = [];
  for (const source of current.sources) {
    const prior = previousSources.get(source.source);
    if (!prior) {
      continue;
    }
    const finding = compareSourceHealth(source, prior, currentDate, previousDate, threshold);
    if (finding) {
      findings.push(finding);
    }
  }
  return {
    ok: findings.length === 0 && coverageFindings.length === 0,
    currentDate,
    previousDate,
    findings,
    coverageFindings,
  };
}

export function collectCoverageFindings(
  sources: SourceManifest[],
  currentDate: string,
  threshold = LOW_COVERAGE_THRESHOLD,
): CoverageFinding[] {
  const findings: CoverageFinding[] = [];
  for (const source of sources) {
    if (source.skipped) {
      continue;
    }
    const eligible = source.eligibleCount ?? 0;
    if (!isLowCoverage(source.coverage, eligible, threshold)) {
      continue;
    }
    findings.push({
      source: source.source,
      currentDate,
      coverage: source.coverage ?? 0,
      eligibleCount: eligible,
      freshTodayCount: source.freshTodayCount ?? sourceFreshWithin7dCount(source) ?? 0,
      freshWithin7dCount: sourceFreshWithin7dCount(source) ?? 0,
      threshold,
    });
  }
  return findings;
}

export function resolveHealthIssueRepo(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.HEALTH_ISSUE_REPO?.trim() ||
    env.COLLECTOR_ISSUE_REPO?.trim() ||
    env.GITHUB_REPOSITORY?.trim() ||
    COLLECTOR_ISSUE_REPO_DEFAULT
  );
}

export async function githubIssueOpener(env: NodeJS.ProcessEnv = process.env): Promise<IssueOpener> {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN ?? env.HEALTH_ISSUE_TOKEN;
  const repo = resolveHealthIssueRepo(env);
  return async ({ title, body, labels }) => {
    if (!token) {
      return { created: false, reason: "no GITHUB_TOKEN available to open a health issue" };
    }
    const opener = createGitHubIssueClient({
      repo,
      token,
      userAgent: "agentstore-radar-health",
    });
    return opener({ title, body, labels, commentOnExisting: false });
  };
}

export async function runHealth(options: HealthOptions = {}): Promise<HealthReport> {
  const log = options.log ?? createLogger();
  const report = evaluateHealth(options);
  if (report.ok) {
    log.info("health check passed", { date: report.currentDate, previousDate: report.previousDate });
    return report;
  }
  const opener = options.openIssue ?? (await githubIssueOpener());
  for (const finding of report.findings) {
    const pct = Math.round(finding.dropRatio * 100);
    const title = `[health] ${finding.source} row count dropped >30%`;
    const body = [
      `Source \`${finding.source}\` row count dropped more than 30%`,
      `for ${finding.currentDate} vs ${finding.previousDate} (${pct}% drop).`,
      "",
      "Details stay in the private data repo. This alert is operational only.",
      `Collector: ${REPO_URL}`,
    ].join("\n");
    log.error(title, { source: finding.source, percent: pct });
    const issue = await opener({ title, body, labels: ["source-health"] });
    if (issue.created) {
      log.info("opened health issue", { url: issue.url });
    } else {
      log.warn("did not open health issue", { reason: issue.reason, url: issue.url });
    }
  }
  for (const finding of report.coverageFindings) {
    const title = `[health] ${finding.source} coverage below ${Math.round(finding.threshold * 100)}%`;
    const body = [
      `Source \`${finding.source}\` coverage is ${formatCoveragePct(finding.coverage)}`,
      `(${finding.freshTodayCount}/${finding.eligibleCount} fresh today) on ${finding.currentDate}.`,
      `Target is at least ${Math.round(finding.threshold * 100)}% fetched on this UTC snapshot date.`,
      "",
      "Details stay in the private data repo. This alert is operational only.",
      `Collector: ${REPO_URL}`,
    ].join("\n");
    log.error(title, {
      source: finding.source,
      coverage: formatCoveragePct(finding.coverage),
      eligible: finding.eligibleCount,
      freshToday: finding.freshTodayCount,
      freshWithin7d: finding.freshWithin7dCount,
    });
    const issue = await opener({ title, body, labels: ["source-health"] });
    if (issue.created) {
      log.info("opened health issue", { url: issue.url });
    } else {
      log.warn("did not open health issue", { reason: issue.reason, url: issue.url });
    }
  }
  return report;
}
