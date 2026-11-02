export type GithubRepoRef = {
  owner: string;
  repo: string;
};

const GITHUB_SCP_RE = /^(?:ssh:\/\/)?git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i;
const IO_GITHUB_NAME_RE = /^io\.github\.([^/]+)\/(.+)$/i;
const RESERVED_GITHUB_OWNERS = new Set(["orgs", "users", "settings", "explore"]);

/**
 * Last resort when package backing, fork status, and repo-name match all tie,
 * and the order for duplicate Gemini rows.
 * `github:` identities win, then UTF-16 code-unit order (not locale order).
 * Documented in README "Entity matching".
 */
function compareAppId(a: string, b: string): number {
  const rank = (a.startsWith("github:") ? 0 : 1) - (b.startsWith("github:") ? 0 : 1);
  if (rank !== 0) {
    return rank;
  }
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

type PackageEcosystem = "npm" | "pypi";

/**
 * How an npm package owner was chosen.
 * `github_id_fallback` and `smallest_id_fallback` are the tie-decided reasons.
 */
export const OWNER_DECISION_REASONS = [
  "sole_claimant",
  "scope_matches_github_org",
  "most_supporting_rows",
  "non_fork",
  "repo_name_matches_package",
  "github_id_fallback",
  "smallest_id_fallback",
] as const;

export type OwnerDecisionReason = (typeof OWNER_DECISION_REASONS)[number];

/** Substantive rules tied; the owner is the `github:` id, or the smallest id. */
export const TIE_DECIDED_OWNER_REASONS = ["github_id_fallback", "smallest_id_fallback"] as const;

export type TieDecidedOwnerReason = (typeof TIE_DECIDED_OWNER_REASONS)[number];

export function isTieDecidedOwnerReason(reason: OwnerDecisionReason): reason is TieDecidedOwnerReason {
  return (TIE_DECIDED_OWNER_REASONS as readonly string[]).includes(reason);
}

export type PackageOwnerDecision = {
  npm_package: string;
  app_id: string;
  owner_decided_by: OwnerDecisionReason;
  claimants: string[];
};

export type OwnerDecisionCounts = Record<OwnerDecisionReason, number>;

/** Counts of npm packages by `owner_decided_by`. Every reason key is present. */
export type LinkerManifest = {
  ownerDecisionCounts: OwnerDecisionCounts;
};

export type LinkerOutput<T> = {
  rows: T[];
  /** One record per npm package that at least one app claimed. */
  packageOwners: PackageOwnerDecision[];
  manifest: LinkerManifest;
};

function emptyOwnerDecisionCounts(): OwnerDecisionCounts {
  return {
    sole_claimant: 0,
    scope_matches_github_org: 0,
    most_supporting_rows: 0,
    non_fork: 0,
    repo_name_matches_package: 0,
    github_id_fallback: 0,
    smallest_id_fallback: 0,
  };
}

export function ownerDecisionCounts(decisions: readonly PackageOwnerDecision[]): OwnerDecisionCounts {
  const counts = emptyOwnerDecisionCounts();
  for (const decision of decisions) {
    counts[decision.owner_decided_by] += 1;
  }
  return counts;
}

export function tieDecidedPackageOwners(decisions: readonly PackageOwnerDecision[]): PackageOwnerDecision[] {
  return decisions.filter((decision) => isTieDecidedOwnerReason(decision.owner_decided_by));
}

function unscopedPackageName(pkg: string, ecosystem: PackageEcosystem): string {
  const lower = pkg.toLowerCase();
  const bare = lower.startsWith("@") ? (lower.split("/")[1] ?? lower.slice(1)) : lower;
  return ecosystem === "pypi" ? bare.replace(/_/g, "-") : bare;
}

function repoNameOf(appId: string): string | null {
  if (!appId.startsWith("github:")) {
    return null;
  }
  const name = appId.slice("github:".length).split("/")[1]?.toLowerCase();
  return name && name.length > 0 ? name : null;
}

function repoMatchesPackage(appId: string, pkg: string, ecosystem: PackageEcosystem): boolean {
  const repo = repoNameOf(appId);
  if (!repo) {
    return false;
  }
  const repoNorm = ecosystem === "pypi" ? repo.replace(/_/g, "-") : repo;
  return repoNorm === unscopedPackageName(pkg, ecosystem);
}

function parseGithubPath(ownerRaw: string, repoRaw: string): GithubRepoRef | null {
  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(ownerRaw).toLowerCase();
    repo = decodeURIComponent(repoRaw).replace(/\.git$/i, "").toLowerCase();
  } catch {
    return null;
  }
  if (!owner || !repo || RESERVED_GITHUB_OWNERS.has(owner)) {
    return null;
  }
  if (!/^[a-z0-9_.-]+$/.test(owner) || !/^[a-z0-9_.-]+$/.test(repo)) {
    return null;
  }
  return { owner, repo };
}

export function parseGithubRepo(value: string | undefined | null): GithubRepoRef | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  const scp = GITHUB_SCP_RE.exec(trimmed);
  if (scp?.[1] && scp[2]) {
    return parseGithubPath(scp[1], scp[2]);
  }

  let candidate = trimmed;
  if (/^git\+/i.test(candidate)) {
    candidate = candidate.slice(4);
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    if (/^(?:www\.)?github\.com\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      return null;
    }
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "github.com" && host !== "www.github.com") {
    return null;
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (!parts[0] || !parts[1]) {
    return null;
  }
  return parseGithubPath(parts[0], parts[1]);
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

export function normalizeGeminiExtensionId(id: string | null | undefined): string | null {
  if (!id) {
    return null;
  }
  const normalized = id.trim().replace(/\/+$/g, "").toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function canonicalPackageName(name: string | null | undefined, ecosystem: "npm" | "pypi"): string | null {
  if (!name) {
    return null;
  }
  const stripped = name.trim().replace(/\/+$/g, "");
  if (!stripped) {
    return null;
  }
  return normalizePackageName(stripped, ecosystem);
}

type LinkableRow = {
  source: string;
  app_id: string;
  source_id?: string;
  name?: string;
  repo_url?: string | null;
  npm_package?: string | null;
  pypi_package?: string | null;
  fork?: boolean | null;
};

function canonicalizeIdentity<T extends LinkableRow>(row: T): T {
  if (row.source === "npm" || row.source === "pypi") {
    return row;
  }
  const repoUrl = row.repo_url?.trim();
  if (!repoUrl) {
    return row;
  }
  const repo = parseGithubRepo(repoUrl);
  if (repo) {
    const app_id = `github:${githubRepoSlug(repo)}`;
    const canonicalUrl = githubRepoUrl(repo);
    if (row.app_id === app_id && row.repo_url === canonicalUrl) {
      return row;
    }
    return { ...row, app_id, repo_url: canonicalUrl };
  }
  if (row.app_id.startsWith("github:") && row.source && row.source_id) {
    const app_id = `${row.source}:${row.source_id}`.toLowerCase();
    if (row.app_id === app_id) {
      return row;
    }
    return { ...row, app_id };
  }
  return row;
}

function compareGeminiRow(a: LinkableRow, b: LinkableRow, indexA: number, indexB: number): number {
  const byApp = compareAppId(a.app_id, b.app_id);
  if (byApp !== 0) {
    return byApp;
  }
  const repoA = a.repo_url ?? "";
  const repoB = b.repo_url ?? "";
  if (repoA !== repoB) {
    if (!repoA) {
      return 1;
    }
    if (!repoB) {
      return -1;
    }
    return repoA < repoB ? -1 : 1;
  }
  const nameA = a.name ?? "";
  const nameB = b.name ?? "";
  if (nameA !== nameB) {
    return nameA < nameB ? -1 : 1;
  }
  return indexA - indexB;
}

function dedupeGeminiExtensions<T extends LinkableRow>(rows: T[]): T[] {
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (row.source !== "gemini-cli") {
      return;
    }
    const id = normalizeGeminiExtensionId(row.source_id);
    if (!id) {
      return;
    }
    const list = groups.get(id) ?? [];
    list.push(index);
    groups.set(id, list);
  });
  const drop = new Set<number>();
  for (const indexes of groups.values()) {
    if (indexes.length < 2) {
      continue;
    }
    const ranked = indexes.slice().sort((left, right) => compareGeminiRow(rows[left]!, rows[right]!, left, right));
    const winner = ranked[0]!;
    for (const index of indexes) {
      if (index !== winner) {
        drop.add(index);
      }
    }
  }
  if (drop.size === 0) {
    return rows;
  }
  return rows.filter((_, index) => !drop.has(index));
}

function claimantAppId(appId: string, ecosystem: "npm" | "pypi", pkg: string): string {
  if (appId.toLowerCase().startsWith(`${ecosystem}:`)) {
    return `${ecosystem}:${pkg}`;
  }
  return appId;
}

function packageField(ecosystem: PackageEcosystem): "npm_package" | "pypi_package" {
  return ecosystem === "npm" ? "npm_package" : "pypi_package";
}

function supportScore(appId: string, pkg: string, ecosystem: PackageEcosystem, rows: LinkableRow[]): number {
  const field = packageField(ecosystem);
  let registry = 0;
  let github = false;
  for (const row of rows) {
    if (row.source === "npm" || row.source === "pypi") {
      continue;
    }
    if (row.source === "github") {
      if (row.app_id === appId) {
        github = true;
      }
      continue;
    }
    const named = canonicalPackageName(row[field], ecosystem);
    if (named === pkg && claimantAppId(row.app_id, ecosystem, pkg) === appId) {
      registry += 1;
    }
  }
  return registry + (github ? 1 : 0);
}

function isKnownFork(appId: string, pkg: string, ecosystem: PackageEcosystem, rows: LinkableRow[]): boolean {
  const field = packageField(ecosystem);
  for (const row of rows) {
    if (row.fork !== true) {
      continue;
    }
    if (row.app_id === appId) {
      return true;
    }
    if (row.source === "npm" || row.source === "pypi" || row.source === "github") {
      continue;
    }
    const named = canonicalPackageName(row[field], ecosystem);
    if (named === pkg && claimantAppId(row.app_id, ecosystem, pkg) === appId) {
      return true;
    }
  }
  return false;
}

function sortUtf16(ids: readonly string[]): string[] {
  return ids.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** GitHub owner from `github:{owner}/{repo}`, compared case-insensitively. */
function githubOwnerOf(appId: string): string | null {
  const lower = appId.toLowerCase();
  if (!lower.startsWith("github:")) {
    return null;
  }
  const owner = lower.slice("github:".length).split("/")[0] ?? "";
  return owner.length > 0 ? owner : null;
}

/** Scope from `@scope/name`, without the leading `@`. Unscoped names return null. */
function npmPackageScope(pkg: string): string | null {
  if (!pkg.startsWith("@")) {
    return null;
  }
  const slash = pkg.indexOf("/");
  if (slash <= 1) {
    return null;
  }
  const scope = pkg.slice(1, slash).toLowerCase();
  return scope.length > 0 ? scope : null;
}

/**
 * The one candidate whose GitHub owner equals the npm scope.
 * Null when the package is unscoped, or when the number of matches is not exactly one.
 */
function uniqueScopeOwner(ids: readonly string[], pkg: string): string | null {
  const scope = npmPackageScope(pkg);
  if (!scope) {
    return null;
  }
  const matches = ids.filter((id) => githubOwnerOf(id) === scope);
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * First rule that uniquely selects the owner.
 * Scope applies to npm only and outranks support, fork, and name.
 * Fork and id rules match the #20 order: a known fork loses to an app that is not a known fork;
 * `github:` wins over other ids; otherwise the smallest UTF-16 id.
 */
function decidePackageOwner(
  ids: readonly string[],
  pkg: string,
  ecosystem: PackageEcosystem,
  rows: LinkableRow[],
): { owner: string; reason: OwnerDecisionReason } {
  if (ids.length === 0) {
    throw new Error(`no claimants for ${ecosystem} package ${pkg}`);
  }
  if (ids.length === 1) {
    return { owner: ids[0]!, reason: "sole_claimant" };
  }
  if (ecosystem === "npm") {
    const scoped = uniqueScopeOwner(ids, pkg);
    if (scoped) {
      return { owner: scoped, reason: "scope_matches_github_org" };
    }
  }

  const scores = new Map(ids.map((id) => [id, supportScore(id, pkg, ecosystem, rows)]));
  const bestSupport = Math.max(...scores.values());
  let remaining = ids.filter((id) => scores.get(id) === bestSupport);
  if (remaining.length === 1) {
    return { owner: remaining[0]!, reason: "most_supporting_rows" };
  }

  const notFork = remaining.filter((id) => !isKnownFork(id, pkg, ecosystem, rows));
  if (notFork.length > 0 && notFork.length < remaining.length) {
    if (notFork.length === 1) {
      return { owner: notFork[0]!, reason: "non_fork" };
    }
    remaining = notFork;
  }

  const nameMatches = remaining.filter((id) => repoMatchesPackage(id, pkg, ecosystem));
  if (nameMatches.length === 1) {
    return { owner: nameMatches[0]!, reason: "repo_name_matches_package" };
  }
  if (nameMatches.length > 1) {
    remaining = nameMatches;
  }

  const githubIds = remaining.filter((id) => id.startsWith("github:"));
  if (githubIds.length === 1 && githubIds.length < remaining.length) {
    return { owner: githubIds[0]!, reason: "github_id_fallback" };
  }
  if (githubIds.length > 1) {
    remaining = githubIds;
  }

  return { owner: sortUtf16(remaining)[0]!, reason: "smallest_id_fallback" };
}

function relinkPackages<T extends LinkableRow>(rows: T[]): { rows: T[]; packageOwners: PackageOwnerDecision[] } {
  const owners = new Map<"npm" | "pypi", Map<string, string>>();
  const packageOwners: PackageOwnerDecision[] = [];
  for (const ecosystem of ["npm", "pypi"] as const) {
    const claims = new Map<string, Set<string>>();
    for (const row of rows) {
      if (row.source === ecosystem) {
        continue;
      }
      const pkg = canonicalPackageName(row[packageField(ecosystem)], ecosystem);
      if (!pkg) {
        continue;
      }
      const set = claims.get(pkg) ?? new Set<string>();
      set.add(claimantAppId(row.app_id, ecosystem, pkg));
      claims.set(pkg, set);
    }
    const chosen = new Map<string, string>();
    for (const [pkg, ids] of claims) {
      const decision = decidePackageOwner([...ids], pkg, ecosystem, rows);
      chosen.set(pkg, decision.owner);
      if (ecosystem === "npm") {
        packageOwners.push({
          npm_package: pkg,
          app_id: decision.owner,
          owner_decided_by: decision.reason,
          claimants: sortUtf16([...ids]),
        });
      }
    }
    owners.set(ecosystem, chosen);
  }
  packageOwners.sort((a, b) => (a.npm_package < b.npm_package ? -1 : a.npm_package > b.npm_package ? 1 : 0));

  const linked = rows.map((row) => {
    let next = row;
    for (const ecosystem of ["npm", "pypi"] as const) {
      const field = packageField(ecosystem);
      const pkg = canonicalPackageName(next[field], ecosystem);
      if (!pkg) {
        continue;
      }
      const owner = owners.get(ecosystem)?.get(pkg) ?? `${ecosystem}:${pkg}`;
      if (next.source === ecosystem) {
        next = { ...next, app_id: owner, [field]: pkg };
        continue;
      }
      if (claimantAppId(next.app_id, ecosystem, pkg) !== owner) {
        const packageWasIdentity = next.app_id.toLowerCase().startsWith(`${ecosystem}:`);
        const app_id =
          packageWasIdentity && next.source_id
            ? `${next.source}:${next.source_id}`.toLowerCase()
            : next.app_id;
        next = { ...next, app_id, [field]: null };
        continue;
      }
      const app_id = next.app_id.toLowerCase().startsWith(`${ecosystem}:`) ? owner : next.app_id;
      next = { ...next, app_id, [field]: pkg };
    }
    return next;
  });
  return { rows: linked, packageOwners };
}

export function relinkPackageAppIds<T extends LinkableRow>(rows: T[]): T[] {
  return relinkPackages(rows).rows;
}

/** Rows, per-package `owner_decided_by`, and `manifest.ownerDecisionCounts`. */
export function linkCrossStore<T extends LinkableRow>(rows: T[]): LinkerOutput<T> {
  const linked = relinkPackages(dedupeGeminiExtensions(rows.map((row) => canonicalizeIdentity(row))));
  return {
    rows: linked.rows,
    packageOwners: linked.packageOwners,
    manifest: { ownerDecisionCounts: ownerDecisionCounts(linked.packageOwners) },
  };
}

export function linkSourceRows<T extends LinkableRow>(rows: T[]): T[] {
  return linkCrossStore(rows).rows;
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
