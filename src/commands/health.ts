import { HEALTH_DROP_THRESHOLD, REPO_URL } from "../lib/config.ts";
import { utcDateString } from "../lib/dates.ts";
import { listSnapshotDates, previousSnapshotDate, readManifest } from "../lib/io.ts";
import { createLogger, type Logger } from "../lib/logger.ts";
import type { SourceManifest, SourceName } from "../lib/schema.ts";

export type HealthFinding = {
  source: SourceName;
  previousDate: string;
  currentDate: string;
  previousCount: number;
  currentCount: number;
  dropRatio: number;
};

export type HealthReport = {
  ok: boolean;
  currentDate: string;
  previousDate?: string;
  findings: HealthFinding[];
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
  const dataDir = options.dataDir ?? "data";
  const currentDate = options.date ?? listSnapshotDates(dataDir).at(-1) ?? utcDateString(now);
  const previousDate = previousSnapshotDate(currentDate, dataDir);
  if (!previousDate) {
    return { ok: true, currentDate, findings: [] };
  }
  const current = readManifest(currentDate, dataDir);
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
    ok: findings.length === 0,
    currentDate,
    previousDate,
    findings,
  };
}

export async function githubIssueOpener(env: NodeJS.ProcessEnv = process.env): Promise<IssueOpener> {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  return async ({ title, body, labels }) => {
    if (!token || !repo) {
      return { created: false, reason: "GITHUB_TOKEN or GITHUB_REPOSITORY missing" };
    }
    const query = new URL("https://api.github.com/search/issues");
    query.searchParams.set("q", `repo:${repo} is:issue is:open label:${labels[0] ?? "source-health"} in:title ${title}`);
    const search = await fetch(query, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "agentstore-radar-health",
      },
    });
    if (search.ok) {
      const payload = (await search.json()) as { items?: Array<{ html_url?: string }> };
      const existing = payload.items?.[0];
      if (existing?.html_url) {
        return { created: false, url: existing.html_url, reason: "open issue already exists" };
      }
    }
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "agentstore-radar-health",
    };
    let created = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title, body, labels }),
    });
    if (created.status === 422 && labels.length > 0) {
      created = await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title, body }),
      });
    }
    if (!created.ok) {
      return { created: false, reason: `GitHub issue create failed: HTTP ${created.status}` };
    }
    const payload = (await created.json()) as { html_url?: string };
    return { created: true, url: payload.html_url };
  };
}

export async function runHealth(options: HealthOptions = {}): Promise<HealthReport> {
  const log = options.log ?? createLogger();
  const report = evaluateHealth(options);
  if (report.ok) {
    log.info("health check passed", { date: report.currentDate, previousDate: report.previousDate });
    return report;
  }
  for (const finding of report.findings) {
    const pct = Math.round(finding.dropRatio * 100);
    const title = `[health] ${finding.source} row count dropped >30%`;
    const body = [
      `Source \`${finding.source}\` row count dropped ${pct}% (${finding.previousCount} → ${finding.currentCount})`,
      `for ${finding.currentDate} vs ${finding.previousDate}.`,
      "",
      `Threshold: ${Math.round((options.threshold ?? HEALTH_DROP_THRESHOLD) * 100)}%.`,
      `Collector: ${REPO_URL}`,
    ].join("\n");
    log.error(title, {
      previous: finding.previousCount,
      current: finding.currentCount,
    });
    const opener = options.openIssue ?? (await githubIssueOpener());
    const issue = await opener({ title, body, labels: ["source-health"] });
    if (issue.created) {
      log.info("opened health issue", { url: issue.url });
    } else {
      log.warn("did not open health issue", { reason: issue.reason, url: issue.url });
    }
  }
  return report;
}
