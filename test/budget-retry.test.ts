import { describe, expect, it } from "vitest";
import type { SourceAdapter } from "../src/adapters/types.ts";
import { collectAdapter } from "../src/commands/collect.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { createLogger } from "../src/lib/logger.ts";

const silent = createLogger({
  log() {},
  warn() {},
  error() {},
});

describe("shared source budget across retries", () => {
  it("does not retry an adapter after the budget is spent, and elapsed stays within the budget", async () => {
    const budgetMs = 1_000;
    const origin = 1_700_000_000_000;
    let now = origin;
    let calls = 0;
    let slept = false;
    const adapter: SourceAdapter = {
      name: "npm",
      kind: "enrichment",
      async collect(ctx) {
        calls += 1;
        now = ctx.budget!.startedAtMs + ctx.budget!.budgetMs;
        throw new Error("npm blew up after the budget was spent");
      },
    };

    const result = await collectAdapter(
      adapter,
      {
        snapshotDate: "2026-11-03",
        collectedAt: "2026-11-03T12:00:00.000Z",
        dataDir: "/tmp/unused",
        now: new Date("2026-11-03T12:00:00.000Z"),
        env: { RADAR_NPM_BUDGET_MS: String(budgetMs) },
        http: createHttpClient({ fetchImpl: async () => { throw new Error("no http"); } }),
        log: silent,
        discovered: { githubRepos: new Map(), npmPackages: new Set(), pypiPackages: new Set() },
        monotonicNow: () => now,
      },
      3,
      async () => {
        slept = true;
      },
    );

    expect(calls).toBe(1);
    expect(slept).toBe(false);
    expect(now - origin).toBeLessThanOrEqual(budgetMs);
    expect(result.truncated).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.stoppedAt?.error).toMatch(/wall-clock budget|blew up/);
  });
});
