import { COLLECTOR_ISSUE_REPO_DEFAULT, COLLECTOR_MISSED_LABEL, REPO_URL } from "../lib/config.ts";
import { utcDateString } from "../lib/dates.ts";
import { collectorMissedTitle, createGitHubIssueClient, type GitHubIssueOpener } from "../lib/github-issue.ts";
import { inspectSnapshot, resolveDataDir } from "../lib/io.ts";
import { createLogger, type Logger } from "../lib/logger.ts";

export type AlertMissedOptions = {
  date?: string;
  dataDir?: string;
  now?: Date;
  log?: Logger;
  env?: NodeJS.ProcessEnv;
  collectFailed?: boolean;
  backstop?: boolean;
  runUrl?: string;
  openIssue?: GitHubIssueOpener;
};

export type AlertMissedReport = {
  date: string;
  usable: boolean;
  needsRetry: boolean;
  reason?: string;
  alerted: boolean;
  created: boolean;
  commented: boolean;
  url?: string;
  message: string;
};

export function resolveCollectorIssueRepo(env: NodeJS.ProcessEnv = process.env): string {
  return env.COLLECTOR_ISSUE_REPO?.trim() || env.GITHUB_REPOSITORY?.trim() || COLLECTOR_ISSUE_REPO_DEFAULT;
}

export function defaultRunUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const server = env.GITHUB_SERVER_URL?.trim() || "https://github.com";
  const repo = env.GITHUB_REPOSITORY?.trim();
  const runId = env.GITHUB_RUN_ID?.trim();
  if (!repo || !runId) {
    return undefined;
  }
  return `${server}/${repo}/actions/runs/${runId}`;
}

function issueBody(input: {
  date: string;
  reason?: string;
  collectFailed: boolean;
  backstop: boolean;
  runUrl?: string;
  failedSources?: string[];
}): string {
  const lines = [
    `The daily collector did not land a usable snapshot for **${input.date}**.`,
    "",
    `- Reason: ${input.reason ?? "missing snapshot"}`,
    `- Collect failed: ${input.collectFailed ? "yes" : "no"}`,
    `- Backstop run: ${input.backstop ? "yes" : "no"}`,
  ];
  if (input.failedSources && input.failedSources.length > 0) {
    lines.push(`- Failed sources: ${input.failedSources.join(", ")}`);
  }
  if (input.runUrl) {
    lines.push(`- Workflow run: ${input.runUrl}`);
  }
  lines.push(
    "",
    "This is an operational alert only. Snapshot details stay in the private data repo.",
    `Collector: ${REPO_URL}`,
  );
  return lines.join("\n");
}

function recoveryComment(date: string, runUrl?: string): string {
  const lines = [`Backstop or a later run recovered a usable snapshot for **${date}**.`];
  if (runUrl) {
    lines.push("", `Workflow run: ${runUrl}`);
  }
  return lines.join("\n");
}

export async function githubCollectorIssueOpener(env: NodeJS.ProcessEnv = process.env): Promise<GitHubIssueOpener | undefined> {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN ?? env.COLLECTOR_ISSUE_TOKEN;
  const repo = resolveCollectorIssueRepo(env);
  if (!token) {
    return undefined;
  }
  return createGitHubIssueClient({
    repo,
    token,
    userAgent: "agentstore-radar-collector-alert",
  });
}

export async function runCollectorMissedAlert(options: AlertMissedOptions = {}): Promise<AlertMissedReport> {
  const log = options.log ?? createLogger();
  const now = options.now ?? new Date();
  const dataDir = resolveDataDir(options.dataDir, options.env);
  const date = options.date ?? utcDateString(now);
  const env = options.env ?? process.env;
  const inspection = inspectSnapshot(date, dataDir);
  const runUrl = options.runUrl ?? defaultRunUrl(env);
  const collectFailed = options.collectFailed === true;
  const backstop = options.backstop === true;
  const missing = !inspection.usable;
  const shouldAlert = missing && (collectFailed || backstop);

  if (!missing) {
    if (backstop) {
      const opener = options.openIssue ?? (await githubCollectorIssueOpener(env));
      if (opener) {
        const result = await opener({
          title: collectorMissedTitle(date),
          body: recoveryComment(date, runUrl),
          comment: recoveryComment(date, runUrl),
          labels: [COLLECTOR_MISSED_LABEL],
          commentOnExisting: true,
          createIfMissing: false,
        });
        if (result.commented) {
          log.info("commented recovery on collector-missed issue", { url: result.url, date });
        }
      }
    }
    return {
      date,
      usable: true,
      needsRetry: inspection.needsRetry,
      reason: inspection.reason,
      alerted: false,
      created: false,
      commented: false,
      message: inspection.needsRetry
        ? `snapshot ${date} is usable but some sources failed`
        : `snapshot ${date} is present`,
    };
  }

  if (!shouldAlert) {
    return {
      date,
      usable: false,
      needsRetry: true,
      reason: inspection.reason,
      alerted: false,
      created: false,
      commented: false,
      message: `snapshot ${date} is missing; waiting for backstop unless this run failed`,
    };
  }

  const opener = options.openIssue ?? (await githubCollectorIssueOpener(env));
  if (!opener) {
    log.warn("cannot open collector-missed issue: no token");
    return {
      date,
      usable: false,
      needsRetry: true,
      reason: inspection.reason,
      alerted: false,
      created: false,
      commented: false,
      message: "no token available to open a collector-missed issue",
    };
  }

  const title = collectorMissedTitle(date);
  const body = issueBody({
    date,
    reason: inspection.reason,
    collectFailed,
    backstop,
    runUrl,
    failedSources: inspection.failedSources,
  });
  const result = await opener({
    title,
    body,
    labels: [COLLECTOR_MISSED_LABEL],
    commentOnExisting: true,
  });
  if (result.created) {
    log.error(title, { url: result.url, reason: inspection.reason });
  } else if (result.commented) {
    log.warn("commented on existing collector-missed issue", { url: result.url, date });
  } else {
    log.warn("did not open collector-missed issue", { reason: result.reason, url: result.url });
  }
  return {
    date,
    usable: false,
    needsRetry: true,
    reason: inspection.reason,
    alerted: result.created || result.commented,
    created: result.created,
    commented: result.commented,
    url: result.url,
    message: result.created ? `opened ${title}` : result.commented ? `commented on ${title}` : result.reason ?? "not alerted",
  };
}
