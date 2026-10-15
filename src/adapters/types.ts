import type { HttpClient } from "../lib/http.ts";
import type { Logger } from "../lib/logger.ts";
import type { GithubRepoRef } from "../lib/matching.ts";
import type { SourceName, SourceRow } from "../lib/schema.ts";

export type DiscoveredRefs = {
  githubRepos: Map<string, GithubRepoRef>;
  npmPackages: Set<string>;
  pypiPackages: Set<string>;
};

export function createDiscoveredRefs(): DiscoveredRefs {
  return {
    githubRepos: new Map(),
    npmPackages: new Set(),
    pypiPackages: new Set(),
  };
}

export type CollectContext = {
  snapshotDate: string;
  collectedAt: string;
  dataDir: string;
  now: Date;
  env: NodeJS.ProcessEnv;
  http: HttpClient;
  log: Logger;
  discovered: DiscoveredRefs;
  maxPages?: number;
};

export type SourceResult = {
  source: SourceName;
  collectedAt: string;
  rowCount: number;
  skipped: boolean;
  skipReason?: string;
  raw: unknown;
  records: SourceRow[];
  eligibleCount?: number;
  fetchedCount?: number;
  coverage?: number;
  lastFetchedAt?: string;
  truncated?: boolean;
};

export interface SourceAdapter {
  readonly name: SourceName;
  readonly kind: "catalog" | "enrichment";
  collect(ctx: CollectContext): Promise<SourceResult>;
}
