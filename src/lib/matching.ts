export type GithubRepoRef = {
  owner: string;
  repo: string;
};

const GITHUB_REPO_RE =
  /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i;
const GITHUB_SSH_RE = /git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i;
const IO_GITHUB_NAME_RE = /^io\.github\.([^/]+)\/(.+)$/i;

export function parseGithubRepo(value: string | undefined | null): GithubRepoRef | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  const match = GITHUB_SSH_RE.exec(trimmed) ?? GITHUB_REPO_RE.exec(trimmed);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const owner = match[1].toLowerCase();
  const repo = match[2].replace(/\.git$/i, "").toLowerCase();
  if (owner === "orgs" || owner === "users" || owner === "settings" || owner === "explore") {
    return null;
  }
  return { owner, repo };
}

export function githubRepoSlug(ref: GithubRepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

export function githubRepoUrl(ref: GithubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}`;
}

export function githubRepoFromMcpName(name: string | undefined | null): GithubRepoRef | null {
  if (!name) {
    return null;
  }
  const match = IO_GITHUB_NAME_RE.exec(name.trim());
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { owner: match[1].toLowerCase(), repo: match[2].toLowerCase() };
}

export function normalizePackageName(name: string, ecosystem: "npm" | "pypi"): string {
  const trimmed = name.trim();
  return ecosystem === "pypi" ? trimmed.toLowerCase().replace(/_/g, "-") : trimmed.toLowerCase();
}

export function relinkPackageAppIds<T extends { source: string; app_id: string; npm_package?: string | null; pypi_package?: string | null }>(
  rows: T[],
): T[] {
  const npmToApp = new Map<string, string>();
  const pypiToApp = new Map<string, string>();

  const remember = (map: Map<string, string>, key: string | null | undefined, appId: string): void => {
    if (!key || map.has(key)) {
      return;
    }
    map.set(key, appId);
  };

  for (const row of rows) {
    if (row.source === "npm" || row.source === "pypi") {
      continue;
    }
    if (row.app_id.startsWith("github:")) {
      remember(npmToApp, row.npm_package, row.app_id);
      remember(pypiToApp, row.pypi_package, row.app_id);
    }
  }
  for (const row of rows) {
    if (row.source === "npm" || row.source === "pypi") {
      continue;
    }
    remember(npmToApp, row.npm_package, row.app_id);
    remember(pypiToApp, row.pypi_package, row.app_id);
  }

  return rows.map((row) => {
    if (row.source === "npm" && row.npm_package && npmToApp.has(row.npm_package)) {
      return { ...row, app_id: npmToApp.get(row.npm_package)! };
    }
    if (row.source === "pypi" && row.pypi_package && pypiToApp.has(row.pypi_package)) {
      return { ...row, app_id: pypiToApp.get(row.pypi_package)! };
    }
    return row;
  });
}

export function appIdFromIdentity(input: {
  repoUrl?: string | null;
  npmPackage?: string | null;
  pypiPackage?: string | null;
  source: string;
  sourceId: string;
}): string {
  const github = parseGithubRepo(input.repoUrl ?? undefined);
  if (github) {
    return `github:${githubRepoSlug(github)}`;
  }
  if (input.npmPackage) {
    return `npm:${normalizePackageName(input.npmPackage, "npm")}`;
  }
  if (input.pypiPackage) {
    return `pypi:${normalizePackageName(input.pypiPackage, "pypi")}`;
  }
  return `${input.source}:${input.sourceId}`.toLowerCase();
}
