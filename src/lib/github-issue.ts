export type GitHubIssueResult = {
  created: boolean;
  commented: boolean;
  url?: string;
  number?: number;
  reason?: string;
};

export type GitHubIssueOpener = (input: {
  title: string;
  body: string;
  labels?: string[];
  comment?: string;
  commentOnExisting?: boolean;
  createIfMissing?: boolean;
}) => Promise<GitHubIssueResult>;

export type GitHubIssueClientOptions = {
  repo: string;
  token: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
};

function headers(token: string, userAgent: string, json = false): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": userAgent,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

export async function findOpenIssueByTitle(
  repo: string,
  title: string,
  token: string,
  fetchImpl: typeof fetch,
  userAgent: string,
): Promise<{ number: number; html_url: string } | undefined> {
  const query = new URL("https://api.github.com/search/issues");
  query.searchParams.set("q", `repo:${repo} is:issue is:open in:title "${title}"`);
  const search = await fetchImpl(query, { headers: headers(token, userAgent) });
  if (!search.ok) {
    return undefined;
  }
  const payload = (await search.json()) as { items?: Array<{ number?: number; html_url?: string; title?: string }> };
  const exact = payload.items?.find((item) => item.title === title && item.number != null && item.html_url);
  if (exact?.number != null && exact.html_url) {
    return { number: exact.number, html_url: exact.html_url };
  }
  const first = payload.items?.[0];
  if (first?.number != null && first.html_url) {
    return { number: first.number, html_url: first.html_url };
  }
  return undefined;
}

export function createGitHubIssueClient(options: GitHubIssueClientOptions): GitHubIssueOpener {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const userAgent = options.userAgent ?? "agentstore-radar";
  const { repo, token } = options;

  return async ({ title, body, labels = [], comment, commentOnExisting = true, createIfMissing = true }) => {
    const existing = await findOpenIssueByTitle(repo, title, token, fetchImpl, userAgent);
    if (existing) {
      if (!commentOnExisting) {
        return { created: false, commented: false, url: existing.html_url, number: existing.number, reason: "open issue already exists" };
      }
      const posted = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${existing.number}/comments`, {
        method: "POST",
        headers: headers(token, userAgent, true),
        body: JSON.stringify({ body: comment ?? body }),
      });
      if (!posted.ok) {
        return {
          created: false,
          commented: false,
          url: existing.html_url,
          number: existing.number,
          reason: `GitHub comment failed: HTTP ${posted.status}`,
        };
      }
      return { created: false, commented: true, url: existing.html_url, number: existing.number };
    }
    if (!createIfMissing) {
      return { created: false, commented: false, reason: "no open issue to comment on" };
    }

    const issueHeaders = headers(token, userAgent, true);
    let created = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: issueHeaders,
      body: JSON.stringify({ title, body, labels }),
    });
    if (created.status === 422 && labels.length > 0) {
      created = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
        method: "POST",
        headers: issueHeaders,
        body: JSON.stringify({ title, body }),
      });
    }
    if (!created.ok) {
      return { created: false, commented: false, reason: `GitHub issue create failed: HTTP ${created.status}` };
    }
    const payload = (await created.json()) as { html_url?: string; number?: number };
    return { created: true, commented: false, url: payload.html_url, number: payload.number };
  };
}

export function collectorMissedTitle(date: string): string {
  return `Collector missed ${date}`;
}
