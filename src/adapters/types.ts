import { HttpError, type HttpClient } from "../lib/http.ts";
import type { Logger } from "../lib/logger.ts";
import type { GithubRepoRef } from "../lib/matching.ts";
import type { SourceName, SourceRow, SourceStoppedAt } from "../lib/schema.ts";
import { errorMessage } from "../lib/util.ts";

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
  freshWithin7dCount?: number;
  fetchedThisRunCount?: number;
  coverage?: number;
  lastFetchedAt?: string;
  truncated?: boolean;
  failed?: boolean;
  error?: string;
  backfilled?: boolean;
  backfilledFields?: string[];
  stoppedAt?: SourceStoppedAt;
};

export class CollectSourceError extends Error {
  readonly stoppedAt: SourceStoppedAt;

  constructor(stoppedAt: SourceStoppedAt) {
    super(stoppedAt.error);
    this.name = "CollectSourceError";
    this.stoppedAt = stoppedAt;
  }
}

export function sourceStoppedAt(
  source: SourceName,
  error: unknown,
  extra?: { page?: number; cursor?: string },
): SourceStoppedAt {
  if (error instanceof CollectSourceError) {
    return error.stoppedAt;
  }
  let message = errorMessage(error);
  if (error instanceof HttpError && error.body.trim()) {
    message = `${message}: ${error.body.trim().slice(0, 300)}`;
  }
  return {
    source,
    page: extra?.page,
    cursor: extra?.cursor,
    error: message,
  };
}

export interface SourceAdapter {
  readonly name: SourceName;
  readonly kind: "catalog" | "enrichment";
  collect(ctx: CollectContext): Promise<SourceResult>;
}
