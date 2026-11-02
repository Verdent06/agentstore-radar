import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeMarketplaceSchema,
  claudePluginsAdapter,
  parseClaudeMarketplace,
  rowsFromClaudeMarketplaces,
  type ClaudeMarketplaceFetch,
} from "../src/adapters/claude-plugins.ts";
import { createDiscoveredRefs } from "../src/adapters/types.ts";
import { buildAggregate } from "../src/aggregate/build.ts";
import { movers, publicMetricSeries, topChart } from "../src/aggregate/query.ts";
import { runTool } from "../src/aggregate/tools.ts";
import type { Aggregate, AppSummary } from "../src/aggregate/types.ts";
import { PUBLIC_TOP_N } from "../src/aggregate/public.ts";
import { evaluateHealth } from "../src/commands/health.ts";
import { computeMovers } from "../src/commands/report.ts";
import { CLAUDE_PLUGIN_MARKETPLACES } from "../src/lib/config.ts";
import { createHttpClient } from "../src/lib/http.ts";
import { writeNormalized } from "../src/lib/io.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { emptySourceRow, type SnapshotManifest, type SourceRow } from "../src/lib/schema.ts";
import { fixtureFetch, loadFixture } from "./helpers.ts";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_NEXT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const silent = { info() {}, warn() {}, error() {} };

function file(owner: string, repo: string, payload: unknown): ClaudeMarketplaceFetch {
  return {
    owner,
    repo,
    url: `https://raw.githubusercontent.com/${owner}/${repo}/main/.claude-plugin/marketplace.json`,
    payload,
  };
}

function marketplace(plugins: unknown[], extra?: Record<string, unknown>) {
  return {
    name: "claude-plugins-official",
    owner: { name: "Anthropic" },
    plugins,
    ...extra,
  };
}

function plugin(name: string, source: unknown, extra?: Record<string, unknown>) {
  return {
    name,
    description: `${name} plugin`,
    source,
    ...extra,
  };
}

describe("claude plugin marketplace schema", () => {
  it("accepts the committed marketplace fixture and rejects shape drift", () => {
    const fixture = loadFixture<Record<string, unknown>>("claude-plugins-marketplace.json");
    expect(ClaudeMarketplaceSchema.parse(fixture).plugins.length).toBeGreaterThan(0);
    expect(ClaudeMarketplaceSchema.parse(loadFixture("claude-plugins-skills.json")).name).toBe("anthropic-agent-skills");

    const drifted = structuredClone(fixture);
    const plugins = drifted.plugins as Array<Record<string, unknown>>;
    plugins[0] = { ...plugins[0], unexpectedField: true };
    expect(() => parseClaudeMarketplace(drifted, "fixture")).toThrow(/shape rejected/);

    expect(() => parseClaudeMarketplace({ name: "claude-plugins-official", owner: { name: "Anthropic" } }, "fixture")).toThrow(
      /shape rejected/,
    );
    expect(() =>
      parseClaudeMarketplace(
        marketplace([
          plugin("widget", { source: "npm", package: "widget" }),
        ]),
        "fixture",
      ),
    ).toThrow(/shape rejected/);
  });
});

describe("claude plugin rows", () => {
  it("keeps the source id stable across a rename and ignores the display name", () => {
    const source = { source: "url", url: "https://github.com/acme/widget.git", sha: SHA };
    const before = rowsFromClaudeMarketplaces("2026-11-02", [
      file(
        "anthropics",
        "claude-plugins-official",
        marketplace([plugin("widget", source, { displayName: "Widget" })]),
      ),
    ]);
    const after = rowsFromClaudeMarketplaces("2026-11-02", [
      file(
        "anthropics",
        "claude-plugins-official",
        marketplace([plugin("widget-pro", source, { displayName: "Widget Pro" })], { renames: { widget: "widget-pro" } }),
      ),
    ]);
    expect(before[0]?.source_id).toBe("claude-plugins-official:github:acme/widget");
    expect(after[0]?.source_id).toBe(before[0]?.source_id);
    expect(after[0]?.source_id).not.toContain("widget-pro");
    expect(after[0]?.source_id).not.toContain("Widget");
    expect(after[0]?.plugin_name).toBe("widget-pro");
    expect(after[0]?.display_name).toBe("Widget Pro");
    expect(after[0]?.marketplace_name).toBe("claude-plugins-official");
    expect(after[0]?.commit_sha).toBe(SHA);
    expect(after[0]?.app_id).toBe("github:acme/widget");
    expect(after[0]?.stars_scope).toBe("own_repo");
  });

  it("marks subfolder plugins and shared repos as host_repo stars", () => {
    const rows = rowsFromClaudeMarketplaces("2026-11-02", [
      file(
        "anthropics",
        "claude-plugins-official",
        marketplace([
          plugin("adobe-for-creativity", {
            source: "git-subdir",
            url: "https://github.com/adobe/skills.git",
            path: "plugins/creative-cloud/adobe-for-creativity",
            ref: "main",
            sha: SHA,
          }),
          plugin("only-plugin", {
            source: "github",
            repo: "example/only-plugin",
            sha: SHA,
          }),
          plugin("skills-a", {
            source: "url",
            url: "https://github.com/adobe/skills.git",
            sha: SHA_NEXT,
          }, { displayName: "Skills A" }),
          plugin("skills-b", {
            source: "url",
            url: "https://github.com/adobe/skills.git",
            sha: SHA_NEXT,
          }, { displayName: "Skills B" }),
          plugin("local-tool", "./plugins/local-tool"),
        ]),
      ),
    ]);
    const byName = new Map(rows.map((row) => [row.plugin_name, row]));
    expect(byName.get("adobe-for-creativity")).toMatchObject({
      app_id: "github:adobe/skills",
      stars_scope: "host_repo",
      commit_sha: SHA,
      source_id: "claude-plugins-official:github:adobe/skills#plugins/creative-cloud/adobe-for-creativity",
    });
    expect(byName.get("only-plugin")).toMatchObject({
      app_id: "github:example/only-plugin",
      stars_scope: "own_repo",
    });
    expect(byName.get("skills-a")?.stars_scope).toBe("host_repo");
    expect(byName.get("skills-b")?.stars_scope).toBe("host_repo");
    expect(byName.get("skills-a")?.source_id).not.toBe(byName.get("skills-b")?.source_id);
    expect(byName.get("skills-a")?.source_id).not.toContain("Skills");
    expect(byName.get("local-tool")).toMatchObject({
      app_id: "github:anthropics/claude-plugins-official",
      stars_scope: "host_repo",
      commit_sha: null,
      source_id: "claude-plugins-official:path:plugins/local-tool",
    });
    expect(rows).toHaveLength(5);
  });

  it("keeps a shared-locator id on the pre-rename slug", () => {
    const source = { source: "url", url: "https://github.com/adobe/skills.git", sha: SHA };
    const renamed = rowsFromClaudeMarketplaces("2026-11-02", [
      file(
        "anthropics",
        "claude-plugins-official",
        marketplace(
          [
            plugin("skills-a-next", source, { displayName: "Renamed A" }),
            plugin("skills-b", source, { displayName: "Skills B" }),
          ],
          { renames: { "skills-a": "skills-a-next" } },
        ),
      ),
    ]);
    const ids = renamed.map((row) => row.source_id).sort();
    expect(ids).toEqual([
      "claude-plugins-official:github:adobe/skills#skills-a",
      "claude-plugins-official:github:adobe/skills#skills-b",
    ]);
  });
});

describe("claude plugin star growth", () => {
  it("does not treat host_repo stars as plugin growth", () => {
    const day = (date: string, hostStars: number, ownStars: number): SourceRow[] => [
      emptySourceRow({
        snapshot_date: date,
        app_id: "github:adobe/skills",
        source: "claude-plugins",
        source_id: "claude-plugins-official:github:adobe/skills#plugins/creative-cloud/adobe-for-creativity",
        name: "Adobe for Creativity",
        plugin_name: "adobe-for-creativity",
        marketplace_name: "claude-plugins-official",
        stars_scope: "host_repo",
      }),
      emptySourceRow({
        snapshot_date: date,
        app_id: "github:adobe/skills",
        source: "github",
        source_id: "adobe/skills",
        name: "skills",
        stars: hostStars,
        fetched_at: `${date}T12:00:00Z`,
      }),
      emptySourceRow({
        snapshot_date: date,
        app_id: "github:example/only-plugin",
        source: "claude-plugins",
        source_id: "claude-plugins-official:github:example/only-plugin",
        name: "Only",
        plugin_name: "only-plugin",
        marketplace_name: "claude-plugins-official",
        stars_scope: "own_repo",
        stars: ownStars,
        fetched_at: `${date}T12:00:00Z`,
      }),
    ];
    const previous = mergeApps("2026-11-01", day("2026-11-01", 1000, 10));
    const current = mergeApps("2026-11-02", day("2026-11-02", 5000, 40));
    expect(current.find((app) => app.app_id === "github:adobe/skills")).toMatchObject({
      stars: 5000,
      stars_scope: "host_repo",
      stars_source: "github",
    });
    const moved = computeMovers(previous, current);
    expect(moved.filter((row) => row.metric === "stars").map((row) => row.app_id)).toEqual(["github:example/only-plugin"]);
    expect(moved.find((row) => row.app_id === "github:adobe/skills")).toBeUndefined();
  });

  it("drops host_repo star growth from aggregate movers", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-claude-growth-"));
    const writeDay = (date: string, hostStars: number, ownStars: number) => {
      const rows = [
        emptySourceRow({
          snapshot_date: date,
          app_id: "github:adobe/skills",
          source: "claude-plugins",
          source_id: "claude-plugins-official:github:adobe/skills#plugins/a",
          name: "Adobe",
          plugin_name: "adobe-for-creativity",
          marketplace_name: "claude-plugins-official",
          stars_scope: "host_repo",
        }),
        emptySourceRow({
          snapshot_date: date,
          app_id: "github:adobe/skills",
          source: "github",
          source_id: "adobe/skills",
          name: "skills",
          stars: hostStars,
          fetched_at: `${date}T12:00:00Z`,
          carried_forward: false,
        }),
        emptySourceRow({
          snapshot_date: date,
          app_id: "github:example/only-plugin",
          source: "github",
          source_id: "example/only-plugin",
          name: "Only",
          stars: ownStars,
          fetched_at: `${date}T12:00:00Z`,
          carried_forward: false,
        }),
        emptySourceRow({
          snapshot_date: date,
          app_id: "github:example/only-plugin",
          source: "claude-plugins",
          source_id: "claude-plugins-official:github:example/only-plugin",
          name: "Only",
          plugin_name: "only-plugin",
          marketplace_name: "claude-plugins-official",
          stars_scope: "own_repo",
        }),
      ];
      const manifest: SnapshotManifest = {
        snapshotDate: date,
        collectedAt: `${date}T12:00:00Z`,
        appCount: 2,
        sourceRowCount: rows.length,
        partial: false,
        completedSources: ["claude-plugins", "github"],
        sources: [
          { source: "claude-plugins", rowCount: 2, skipped: false, collectedAt: `${date}T12:00:00Z`, eligibleCount: 2, freshTodayCount: 2, fetchedThisRunCount: 2, fetchedShare: 1, coverage: 1 },
          { source: "github", rowCount: 2, skipped: false, collectedAt: `${date}T12:00:00Z`, eligibleCount: 2, freshTodayCount: 2, fetchedThisRunCount: 2, fetchedShare: 1, coverage: 1 },
        ],
      };
      writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
    };
    writeDay("2026-11-01", 1000, 10);
    writeDay("2026-11-02", 8000, 50);
    const agg = buildAggregate(dataDir);
    const starMovers = movers(agg, { window: "1d", metric: "stars", limit: 10 });
    expect(starMovers.map((row) => row.id)).toEqual(["github:example/only-plugin"]);
    expect(publicMetricSeries(agg, "github:adobe/skills", "stars").every((point) => point.growth == null)).toBe(true);
    expect(publicMetricSeries(agg, "github:example/only-plugin", "stars").some((point) => point.growth != null)).toBe(true);
    expect(JSON.stringify(agg)).not.toMatch(/commit_sha|plugin_name|marketplace_name|installs/);
    expect(agg.apps.length).toBeLessThanOrEqual(PUBLIC_TOP_N);
    expect(agg.apps.find((app) => app.id === "github:adobe/skills")?.stars).toBe(8000);
    expect(agg.apps.find((app) => app.id === "github:adobe/skills")?.starsScope).toBe("host_repo");
  });

  it("nulls previousValue and delta for a host_repo app on the stars chart", () => {
    const agg = starChartAggregate();
    const rows = topChart(agg, "github", 10);
    const host = rows.find((row) => row.app.id === "github:adobe/skills");
    const own = rows.find((row) => row.app.id === "github:example/only-plugin");
    expect(host).toMatchObject({ value: 8000, previousValue: null, delta: null });
    expect(own?.previousValue).toBe(10);
    expect(own?.delta).toBe(30);
    const tool = JSON.parse(runTool(agg, "top_charts", { chart: "github", limit: 10 }).content[0]!.text) as {
      rows: Array<{ id: string; growth: string | null; value: number }>;
    };
    expect(tool.rows.find((row) => row.id === "github:adobe/skills")).toMatchObject({ value: 8000, growth: null });
    expect(tool.rows.find((row) => row.id === "github:example/only-plugin")?.growth).toBe(">100%");
  });
});

function starChartAggregate(): Aggregate {
  const app = (id: string, stars: number, starsScope: "host_repo" | "own_repo"): AppSummary => ({
    id,
    name: id,
    displayName: id,
    description: null,
    homepage: null,
    repoUrl: null,
    npmPackage: null,
    pypiPackage: null,
    sources: ["github", "claude-plugins"],
    stores: [],
    category: "other",
    firstSeen: "2026-11-01",
    lastSeen: "2026-11-02",
    stars,
    forks: null,
    openIssues: null,
    pushedAt: null,
    npmWeeklyDownloads: null,
    pypiLastWeekDownloads: null,
    geminiStars: null,
    verified: null,
    starsScope,
  });
  return {
    meta: {
      builtAt: "2026-11-02T00:00:00Z",
      origin: "fixture",
      source: "fixture",
      snapshotDates: ["2026-11-01", "2026-11-02"],
      latestDate: "2026-11-02",
      previousDate: "2026-11-01",
      weekAgoDate: null,
      partialDates: [],
      latestCompleteDate: "2026-11-02",
      previousCompleteDate: "2026-11-01",
      coverage: [],
    },
    stats: {
      appCount: 2,
      storeCount: 0,
      snapshotCount: 2,
      latestDate: "2026-11-02",
      previousDate: "2026-11-01",
      weekAgoDate: null,
      totalStars: 0,
      totalNpmWeekly: 0,
      multiStoreCount: 0,
      newArrivalCount: 0,
      categoryCount: 1,
      starsKpiHeld: false,
      npmKpiHeld: false,
      pypiKpiHeld: false,
      starsFreshCount: 0,
      npmFreshCount: 0,
      pypiFreshCount: 0,
    },
    apps: [
      app("github:adobe/skills", 8000, "host_repo"),
      app("github:example/only-plugin", 40, "own_repo"),
    ],
    series: {
      "github:adobe/skills": { s: [1000, 8000] },
      "github:example/only-plugin": { s: [10, 40] },
    },
    answerShare: null,
  };
}

describe("claude plugin collect health", () => {
  function payloads(sha: string | null, extraRelative = false) {
    const plugins = [
      plugin("widget", { source: "github", repo: "acme/widget", ...(sha ? { sha } : {}) }),
    ];
    if (extraRelative) {
      plugins.push(plugin("local-tool", "./plugins/local-tool"));
    }
    return [
      file("anthropics", "claude-plugins-official", marketplace(plugins)),
      file("anthropics", "skills", { name: "anthropic-agent-skills", owner: { name: "Anthropic" }, plugins: [] }),
      file("anthropics", "knowledge-work-plugins", { name: "knowledge-work-plugins", owner: { name: "Anthropic" }, plugins: [] }),
    ];
  }

  function httpFor(files: ClaudeMarketplaceFetch[]) {
    return createHttpClient({
      fetchImpl: fixtureFetch(files.map((item) => ({ match: item.url, body: item.payload }))),
      maxRetries: 0,
    });
  }

  it("fetches each marketplace file once and discovers repos without per-plugin calls", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-claude-fetch-"));
    const files = payloads(SHA);
    let calls = 0;
    const discovered = createDiscoveredRefs();
    const result = await claudePluginsAdapter.collect({
      snapshotDate: "2026-11-02",
      collectedAt: "2026-11-02T12:00:00Z",
      now: new Date("2026-11-02T12:00:00Z"),
      dataDir,
      env: {},
      log: silent,
      discovered,
      http: createHttpClient({
        fetchImpl: async (input) => {
          calls += 1;
          const url = String(input);
          const hit = files.find((item) => item.url === url);
          if (!hit) {
            throw new Error(`unexpected fetch ${url}`);
          }
          return new Response(JSON.stringify(hit.payload), { status: 200, headers: { "content-type": "application/json" } });
        },
        maxRetries: 0,
      }),
    });
    expect(calls).toBe(CLAUDE_PLUGIN_MARKETPLACES.length);
    expect(calls).toBe(3);
    expect(result.fetchedShare).toBe(1);
    expect(result.fetchedThisRunCount).toBe(result.rowCount);
    expect(result.records[0]?.frozen).toBe(false);
    expect([...discovered.githubRepos.keys()]).toEqual(["acme/widget"]);
  });

  it("does not freeze a repeated listing until the pinned sha is unchanged for N days", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-claude-fresh-"));
    const files = payloads(SHA);
    const result = await claudePluginsAdapter.collect({
      snapshotDate: "2026-11-02",
      collectedAt: "2026-11-02T12:00:00Z",
      now: new Date("2026-11-02T12:00:00Z"),
      dataDir,
      env: {},
      log: silent,
      discovered: createDiscoveredRefs(),
      http: httpFor(files),
    });
    expect(result.records[0]).toMatchObject({ frozen: false, carried_forward: false, commit_sha: SHA });
    expect(result.fetchedShare).toBe(1);
    expect(result.freshTodayCount).toBe(result.rowCount);
    expect(result.coverage).toBe(1);
  });

  it("counts the listing as fetched when an unchanged pin freezes, and a sha change does not freeze", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-claude-frozen-"));
    const writeDay = (date: string, sha: string) => {
      const rows = rowsFromClaudeMarketplaces(date, payloads(sha)).map((row) => ({
        ...row,
        fetched_at: `${date}T12:00:00Z`,
        carried_forward: false,
        frozen: false,
      }));
      const manifest: SnapshotManifest = {
        snapshotDate: date,
        collectedAt: `${date}T12:00:00Z`,
        appCount: 1,
        sourceRowCount: rows.length,
        partial: false,
        completedSources: ["claude-plugins"],
        sources: [
          {
            source: "claude-plugins",
            rowCount: rows.length,
            skipped: false,
            collectedAt: `${date}T12:00:00Z`,
            eligibleCount: rows.length,
            freshTodayCount: rows.length,
            fetchedThisRunCount: rows.length,
            fetchedShare: 1,
            coverage: 1,
          },
        ],
      };
      writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
    };
    writeDay("2026-10-30", SHA);
    writeDay("2026-10-31", SHA);
    const frozen = await claudePluginsAdapter.collect({
      snapshotDate: "2026-11-01",
      collectedAt: "2026-11-01T12:00:00Z",
      now: new Date("2026-11-01T12:00:00Z"),
      dataDir,
      env: {},
      log: silent,
      discovered: createDiscoveredRefs(),
      http: httpFor(payloads(SHA)),
    });
    expect(frozen.records[0]).toMatchObject({ frozen: true, carried_forward: true, commit_sha: SHA });
    expect(frozen.freshTodayCount).toBe(0);
    expect(frozen.fetchedThisRunCount).toBe(frozen.records.length);
    expect(frozen.fetchedShare).toBe(1);
    expect((frozen.raw as { freeze?: { sourceFrozen: boolean } }).freeze?.sourceFrozen).toBe(true);

    const moved = await claudePluginsAdapter.collect({
      snapshotDate: "2026-11-02",
      collectedAt: "2026-11-02T12:00:00Z",
      now: new Date("2026-11-02T12:00:00Z"),
      dataDir,
      env: {},
      log: silent,
      discovered: createDiscoveredRefs(),
      http: httpFor(payloads(SHA_NEXT)),
    });
    expect(moved.records[0]).toMatchObject({ frozen: false, carried_forward: false, commit_sha: SHA_NEXT });
    expect(moved.fetchedShare).toBe(1);
    expect((moved.raw as { freeze?: { sourceFrozen: boolean } }).freeze?.sourceFrozen).toBe(false);
  });

  it("does not source-freeze a listing whose unpinned plugins keep it under 95%", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-claude-mixed-"));
    const writeDay = (date: string) => {
      const rows = rowsFromClaudeMarketplaces(date, payloads(SHA, true)).map((row) => ({
        ...row,
        fetched_at: `${date}T12:00:00Z`,
      }));
      const manifest: SnapshotManifest = {
        snapshotDate: date,
        collectedAt: `${date}T12:00:00Z`,
        appCount: rows.length,
        sourceRowCount: rows.length,
        partial: false,
        completedSources: ["claude-plugins"],
        sources: [{ source: "claude-plugins", rowCount: rows.length, skipped: false, collectedAt: `${date}T12:00:00Z` }],
      };
      writeNormalized(date, rows, mergeApps(date, rows), manifest, dataDir);
    };
    writeDay("2026-10-30");
    writeDay("2026-10-31");
    const result = await claudePluginsAdapter.collect({
      snapshotDate: "2026-11-01",
      collectedAt: "2026-11-01T12:00:00Z",
      now: new Date("2026-11-01T12:00:00Z"),
      dataDir,
      env: {},
      log: silent,
      discovered: createDiscoveredRefs(),
      http: httpFor(payloads(SHA, true)),
    });
    expect(result.records.every((row) => row.frozen !== true)).toBe(true);
    expect((result.raw as { freeze?: { sourceFrozen: boolean } }).freeze?.sourceFrozen).toBe(false);
    expect(result.fetchedShare).toBe(1);
    expect(result.coverage).toBe(1);
  });

  it("does not alert when the claude-plugins row count holds", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-claude-health-"));
    const manifest = (date: string): SnapshotManifest => ({
      snapshotDate: date,
      collectedAt: `${date}T12:00:00Z`,
      appCount: 4,
      sourceRowCount: 4,
      sources: [
        {
          source: "claude-plugins",
          rowCount: 4,
          skipped: false,
          collectedAt: `${date}T12:00:00Z`,
          eligibleCount: 4,
          freshTodayCount: 4,
          fetchedThisRunCount: 4,
          fetchedShare: 1,
          coverage: 1,
        },
      ],
    });
    writeNormalized("2026-11-01", [], [], manifest("2026-11-01"), dataDir);
    writeNormalized("2026-11-02", [], [], manifest("2026-11-02"), dataDir);
    const report = evaluateHealth({ date: "2026-11-02", dataDir });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.coverageFindings).toEqual([]);
  });
});
