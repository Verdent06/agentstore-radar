import { describe, expect, it } from "vitest";
import { normalizeGeminiExtension } from "../src/adapters/gemini.ts";
import {
  OWNER_DECISION_REASONS,
  isTieDecidedOwnerReason,
  linkCrossStore,
  linkSourceRows,
  normalizePackageName,
  parseGithubRepo,
  tieDecidedPackageOwners,
  type OwnerDecisionReason,
  type PackageOwnerDecision,
} from "../src/lib/matching.ts";
import { mergeApps } from "../src/lib/merge.ts";
import { emptySourceRow, type SourceName, type SourceRow } from "../src/lib/schema.ts";

const DATE = "2026-10-21";

function row(partial: {
  source: SourceName;
  app_id: string;
  source_id?: string;
  name?: string;
  repo_url?: string | null;
  npm_package?: string | null;
  pypi_package?: string | null;
  npm_weekly_downloads?: number | null;
  fork?: boolean | null;
}): SourceRow {
  return emptySourceRow({
    snapshot_date: DATE,
    source_id: partial.source_id ?? partial.app_id,
    name: partial.name ?? partial.app_id,
    ...partial,
  });
}

function appsFrom(rows: SourceRow[]): ReturnType<typeof mergeApps> {
  return mergeApps(DATE, linkSourceRows(rows));
}

function npmOwners(apps: ReturnType<typeof mergeApps>): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const app of apps) {
    if (!app.npm_package) {
      continue;
    }
    const key = normalizePackageName(app.npm_package.trim().replace(/\/+$/g, ""), "npm");
    const list = owners.get(key) ?? [];
    list.push(app.app_id);
    owners.set(key, list);
  }
  return owners;
}

describe("npm package ownership", () => {
  it("property: no npm name maps to more than one app id", () => {
    const scenarios: SourceRow[][] = [];
    for (let i = 0; i < 40; i += 1) {
      const scoped = i % 2 === 0;
      const pkg = scoped ? `@Scope${i}/Name` : `pkg-${i}`;
      scenarios.push([
        row({ source: "mcp-registry", app_id: `github:owner${i}/b-repo`, npm_package: `${pkg}/` }),
        row({ source: "mcp-registry", app_id: `github:owner${i}/a-repo`, npm_package: pkg.toUpperCase() }),
        row({
          source: "npm",
          app_id: `npm:${pkg.toLowerCase()}`,
          npm_package: pkg,
          source_id: pkg,
          npm_weekly_downloads: 50 + i,
        }),
      ]);
    }
    scenarios.push([
      row({ source: "mcp-registry", app_id: "github:zeta/repo", npm_package: "plain-tool" }),
      row({ source: "mcp-registry", app_id: "mcp-registry:aaa", npm_package: "Plain-Tool", source_id: "aaa" }),
      row({ source: "gemini-cli", app_id: "gemini-cli:zzz", npm_package: "plain-tool", source_id: "zzz" }),
    ]);
    scenarios.push([
      row({ source: "mcp-registry", app_id: "github:alpha/one", npm_package: "@acme/left" }),
      row({ source: "mcp-registry", app_id: "github:beta/two", npm_package: "left" }),
    ]);
    scenarios.push([
      row({
        source: "mcp-registry",
        app_id: "npm:@only/pkg",
        npm_package: "@only/pkg",
        source_id: "com.example/only",
        name: "only",
      }),
      row({
        source: "mcp-registry",
        app_id: "github:example/only",
        npm_package: "@Only/Pkg",
        source_id: "io.github.example/only",
        name: "example",
      }),
    ]);

    for (const [index, rows] of scenarios.entries()) {
      const owners = npmOwners(appsFrom(rows));
      for (const [name, ids] of owners) {
        expect(new Set(ids).size, `scenario ${index} package ${name} -> ${ids.join(",")}`).toBe(1);
      }
    }

    const scoped = appsFrom(scenarios[0]!);
    expect(scoped.find((app) => app.app_id === "github:owner0/a-repo")?.npm_package).toBe("@scope0/name");
    expect(scoped.find((app) => app.app_id === "github:owner0/b-repo")?.npm_package).toBeNull();
    expect(scoped.find((app) => app.app_id === "github:owner0/a-repo")?.npm_weekly_downloads).toBe(50);

    const preferred = appsFrom(scenarios[40]!);
    expect(preferred.find((app) => app.app_id === "github:zeta/repo")?.npm_package).toBe("plain-tool");
    expect(preferred.filter((app) => app.npm_package)).toHaveLength(1);

    const distinct = npmOwners(appsFrom(scenarios[41]!));
    expect(distinct.get("@acme/left")).toEqual(["github:alpha/one"]);
    expect(distinct.get("left")).toEqual(["github:beta/two"]);

    const packageOnly = appsFrom(scenarios[42]!).map((app) => app.app_id);
    expect(packageOnly.sort()).toEqual(["github:example/only", "mcp-registry:com.example/only"]);
  });

  it("gives xcodebuildmcp to getsentry rather than the fork", () => {
    const apps = appsFrom([
      row({
        source: "mcp-registry",
        app_id: "github:cameroncooke/xcodebuildmcp",
        source_id: "io.github.cameroncooke/XcodeBuildMCP",
        name: "XcodeBuildMCP",
        repo_url: "https://github.com/cameroncooke/XcodeBuildMCP",
        npm_package: "xcodebuildmcp",
        fork: true,
      }),
      row({
        source: "github",
        app_id: "github:cameroncooke/xcodebuildmcp",
        source_id: "cameroncooke/xcodebuildmcp",
        name: "cameroncooke/XcodeBuildMCP",
        repo_url: "https://github.com/cameroncooke/XcodeBuildMCP",
        fork: true,
      }),
      row({
        source: "mcp-registry",
        app_id: "github:getsentry/xcodebuildmcp",
        source_id: "com.xcodebuildmcp/XcodeBuildMCP",
        name: "XcodeBuildMCP",
        repo_url: "https://github.com/getsentry/XcodeBuildMCP",
        npm_package: "xcodebuildmcp",
        fork: false,
      }),
      row({
        source: "github",
        app_id: "github:getsentry/xcodebuildmcp",
        source_id: "getsentry/xcodebuildmcp",
        name: "getsentry/XcodeBuildMCP",
        repo_url: "https://github.com/getsentry/XcodeBuildMCP",
        fork: false,
      }),
      row({
        source: "npm",
        app_id: "npm:xcodebuildmcp",
        npm_package: "xcodebuildmcp",
        npm_weekly_downloads: 4200,
      }),
    ]);
    expect(apps.find((app) => app.app_id === "github:getsentry/xcodebuildmcp")).toMatchObject({
      npm_package: "xcodebuildmcp",
      npm_weekly_downloads: 4200,
    });
    expect(apps.find((app) => app.app_id === "github:cameroncooke/xcodebuildmcp")?.npm_package).toBeNull();
  });

  it("gives lithtrix-mcp to the repo with more registry rows and a GitHub row", () => {
    const apps = appsFrom([
      row({
        source: "mcp-registry",
        app_id: "github:lithtrix/api",
        source_id: "io.github.learningloons-hash/lithtrix",
        name: "lithtrix",
        repo_url: "https://github.com/lithtrix/api",
        npm_package: "lithtrix-mcp",
      }),
      row({
        source: "mcp-registry",
        app_id: "github:lithtrix/lithtrix-mcp",
        source_id: "ai.lithtrix/lithtrix-mcp",
        name: "Lithtrix",
        repo_url: "https://github.com/lithtrix/lithtrix-mcp",
        npm_package: "lithtrix-mcp",
      }),
      row({
        source: "mcp-registry",
        app_id: "github:lithtrix/lithtrix-mcp",
        source_id: "io.github.lithtrix/lithtrix",
        name: "lithtrix",
        repo_url: "https://github.com/lithtrix/lithtrix-mcp",
        npm_package: "lithtrix-mcp",
      }),
      row({
        source: "github",
        app_id: "github:lithtrix/lithtrix-mcp",
        source_id: "lithtrix/lithtrix-mcp",
        name: "lithtrix/lithtrix-mcp",
        repo_url: "https://github.com/lithtrix/lithtrix-mcp",
      }),
      row({
        source: "npm",
        app_id: "npm:lithtrix-mcp",
        npm_package: "lithtrix-mcp",
        npm_weekly_downloads: 80,
      }),
    ]);
    expect(apps.find((app) => app.app_id === "github:lithtrix/lithtrix-mcp")).toMatchObject({
      npm_package: "lithtrix-mcp",
      npm_weekly_downloads: 80,
    });
    expect(apps.find((app) => app.app_id === "github:lithtrix/api")?.npm_package).toBeNull();
  });

  it("lets a higher support count beat a non-fork whose repo name matches", () => {
    const apps = appsFrom([
      row({
        source: "mcp-registry",
        app_id: "github:aaa/widget",
        source_id: "com.example/widget",
        repo_url: "https://github.com/aaa/widget",
        npm_package: "widget",
        fork: false,
      }),
      row({
        source: "github",
        app_id: "github:aaa/widget",
        source_id: "aaa/widget",
        repo_url: "https://github.com/aaa/widget",
        fork: false,
      }),
      row({
        source: "mcp-registry",
        app_id: "github:zzz/other",
        source_id: "com.example/other-a",
        repo_url: "https://github.com/zzz/other",
        npm_package: "widget",
        fork: true,
      }),
      row({
        source: "mcp-registry",
        app_id: "github:zzz/other",
        source_id: "com.example/other-b",
        repo_url: "https://github.com/zzz/other",
        npm_package: "widget",
        fork: true,
      }),
      row({
        source: "github",
        app_id: "github:zzz/other",
        source_id: "zzz/other",
        repo_url: "https://github.com/zzz/other",
        fork: true,
      }),
    ]);
    expect(apps.find((app) => app.npm_package === "widget")?.app_id).toBe("github:zzz/other");
  });
});

const GEMINI_CASES: Array<{
  label: string;
  appId: string;
  stars: number;
  extensions: Array<Record<string, unknown>>;
}> = [
  {
    label: "wix",
    appId: "github:wix/skills",
    stars: 27,
    extensions: [
      {
        id: "@wix/wix",
        url: "https://github.com/wix/wix-mcp",
        fullName: "wix/wix-mcp",
        extensionName: "wix",
        stars: 15,
        extensionVersion: "1.0.0",
      },
      {
        id: "@wix/wix",
        url: "https://github.com/wix/skills",
        fullName: "wix/skills",
        extensionName: "wix",
        stars: 27,
        extensionVersion: "1.17.0",
      },
    ],
  },
  {
    label: "supabase-community",
    appId: "github:supabase-community/gemini-extension",
    stars: 4,
    extensions: [
      {
        id: "@supabase-community/supabase",
        url: "https://github.com/supabase-community/supabase-plugin",
        fullName: "supabase-community/supabase-plugin",
        extensionName: "supabase",
        stars: 36,
        extensionVersion: "0.1.16",
      },
      {
        id: "@supabase-community/supabase",
        url: "https://github.com/supabase-community/gemini-extension",
        fullName: "supabase-community/gemini-extension",
        extensionName: "supabase",
        stars: 4,
        extensionVersion: "0.1.6",
      },
    ],
  },
  {
    label: "outline-driven-development",
    appId: "github:outlinedriven/odin-gemini-cli-extension",
    stars: 4,
    extensions: [
      {
        id: "@OutlineDriven/outline-driven-development",
        url: "https://github.com/OutlineDriven/outline-driven-development",
        fullName: "OutlineDriven/outline-driven-development",
        extensionName: "",
        stars: 53,
      },
      {
        id: "@OutlineDriven/outline-driven-development",
        url: "https://github.com/OutlineDriven/odin-gemini-cli-extension",
        fullName: "OutlineDriven/odin-gemini-cli-extension",
        extensionName: "outline-driven-development",
        stars: 4,
        extensionVersion: "1.3.2",
      },
    ],
  },
  {
    label: "archastro intern",
    appId: "github:archastro/intern",
    stars: 0,
    extensions: [
      {
        id: "@ArchAstro/intern/",
        url: "https://github.com/ArchAstro/intern-mcp",
        fullName: "ArchAstro/intern-mcp",
        extensionName: "intern",
        stars: 0,
        extensionVersion: "1.0.0",
      },
      {
        id: "@archastro/intern",
        url: "https://github.com/ArchAstro/intern",
        fullName: "ArchAstro/intern",
        extensionName: "intern",
        stars: 0,
        extensionVersion: "1.0.0",
      },
    ],
  },
];

describe("npm owner provenance", () => {
  const reasonCases: Array<{ reason: OwnerDecisionReason; rows: SourceRow[]; decision: PackageOwnerDecision }> = [
    {
      reason: "sole_claimant",
      rows: [
        row({
          source: "mcp-registry",
          app_id: "github:solo/only",
          source_id: "io.github.solo/only",
          repo_url: "https://github.com/solo/only",
          npm_package: "only-pkg",
        }),
      ],
      decision: {
        npm_package: "only-pkg",
        app_id: "github:solo/only",
        owner_decided_by: "sole_claimant",
        claimants: ["github:solo/only"],
      },
    },
    {
      reason: "scope_matches_github_org",
      rows: [
        row({
          source: "mcp-registry",
          app_id: "github:smartergpt/lex",
          source_id: "io.github.smartergpt/lex",
          repo_url: "https://github.com/smartergpt/lex",
          npm_package: "@smartergpt/lex-mcp",
        }),
        row({
          source: "mcp-registry",
          app_id: "github:guffawaffle/lex",
          source_id: "io.github.guffawaffle/lex",
          repo_url: "https://github.com/guffawaffle/lex",
          npm_package: "@smartergpt/lex-mcp",
        }),
        row({
          source: "mcp-registry",
          app_id: "github:guffawaffle/lex",
          source_id: "com.guffawaffle/lex-b",
          repo_url: "https://github.com/guffawaffle/lex",
          npm_package: "@smartergpt/lex-mcp",
        }),
        row({
          source: "mcp-registry",
          app_id: "github:guffawaffle/lex",
          source_id: "com.guffawaffle/lex-c",
          repo_url: "https://github.com/guffawaffle/lex",
          npm_package: "@smartergpt/lex-mcp",
        }),
      ],
      decision: {
        npm_package: "@smartergpt/lex-mcp",
        app_id: "github:smartergpt/lex",
        owner_decided_by: "scope_matches_github_org",
        claimants: ["github:guffawaffle/lex", "github:smartergpt/lex"],
      },
    },
    {
      reason: "most_supporting_rows",
      rows: [
        row({
          source: "mcp-registry",
          app_id: "github:aaa/few",
          source_id: "com.example/few",
          repo_url: "https://github.com/aaa/few",
          npm_package: "backed-tool",
        }),
        row({
          source: "mcp-registry",
          app_id: "github:zzz/many",
          source_id: "com.example/many-a",
          repo_url: "https://github.com/zzz/many",
          npm_package: "backed-tool",
        }),
        row({
          source: "mcp-registry",
          app_id: "github:zzz/many",
          source_id: "com.example/many-b",
          repo_url: "https://github.com/zzz/many",
          npm_package: "backed-tool",
        }),
      ],
      decision: {
        npm_package: "backed-tool",
        app_id: "github:zzz/many",
        owner_decided_by: "most_supporting_rows",
        claimants: ["github:aaa/few", "github:zzz/many"],
      },
    },
    {
      reason: "non_fork",
      rows: [
        row({
          source: "mcp-registry",
          app_id: "github:aaa/copy",
          source_id: "com.example/copy",
          repo_url: "https://github.com/aaa/copy",
          npm_package: "special-tool",
          fork: true,
        }),
        row({
          source: "mcp-registry",
          app_id: "github:zzz/orig",
          source_id: "com.example/orig",
          repo_url: "https://github.com/zzz/orig",
          npm_package: "special-tool",
          fork: false,
        }),
      ],
      decision: {
        npm_package: "special-tool",
        app_id: "github:zzz/orig",
        owner_decided_by: "non_fork",
        claimants: ["github:aaa/copy", "github:zzz/orig"],
      },
    },
    {
      reason: "repo_name_matches_package",
      rows: [
        row({
          source: "mcp-registry",
          app_id: "github:aaa/other",
          source_id: "com.example/other",
          repo_url: "https://github.com/aaa/other",
          npm_package: "widget",
        }),
        row({
          source: "mcp-registry",
          app_id: "github:zzz/widget",
          source_id: "com.example/widget",
          repo_url: "https://github.com/zzz/widget",
          npm_package: "widget",
        }),
      ],
      decision: {
        npm_package: "widget",
        app_id: "github:zzz/widget",
        owner_decided_by: "repo_name_matches_package",
        claimants: ["github:aaa/other", "github:zzz/widget"],
      },
    },
    {
      reason: "github_id_fallback",
      rows: [
        row({
          source: "gemini-cli",
          app_id: "gemini-cli:aaa",
          source_id: "aaa",
          npm_package: "widget",
        }),
        row({
          source: "mcp-registry",
          app_id: "github:zzz/other",
          source_id: "io.github.zzz/other",
          repo_url: "https://github.com/zzz/other",
          npm_package: "widget",
        }),
      ],
      decision: {
        npm_package: "widget",
        app_id: "github:zzz/other",
        owner_decided_by: "github_id_fallback",
        claimants: ["gemini-cli:aaa", "github:zzz/other"],
      },
    },
    {
      reason: "smallest_id_fallback",
      rows: [
        row({
          source: "mcp-registry",
          app_id: "github:bbb/repo",
          source_id: "io.github.bbb/repo",
          repo_url: "https://github.com/bbb/repo",
          npm_package: "widget",
        }),
        row({
          source: "mcp-registry",
          app_id: "github:aaa/repo",
          source_id: "io.github.aaa/repo",
          repo_url: "https://github.com/aaa/repo",
          npm_package: "widget",
        }),
      ],
      decision: {
        npm_package: "widget",
        app_id: "github:aaa/repo",
        owner_decided_by: "smallest_id_fallback",
        claimants: ["github:aaa/repo", "github:bbb/repo"],
      },
    },
  ];

  it.each(reasonCases)("records $reason", ({ rows, decision }) => {
    const output = linkCrossStore(rows);
    expect(output.packageOwners).toEqual([decision]);
    expect(output.manifest.ownerDecisionCounts[decision.owner_decided_by]).toBe(1);
    expect(npmOwners(mergeApps(DATE, output.rows)).get(decision.npm_package)).toEqual([decision.app_id]);
    expect(linkSourceRows(rows)).toEqual(output.rows);
  });

  it("matches an npm scope to a GitHub owner case-insensitively", () => {
    const output = linkCrossStore([
      row({
        source: "mcp-registry",
        app_id: "github:SmarterGPT/lex",
        source_id: "io.github.SmarterGPT/lex",
        npm_package: "@SmArTeRgPt/lex-mcp",
      }),
      row({
        source: "mcp-registry",
        app_id: "github:AAA/lex",
        source_id: "io.github.AAA/lex",
        npm_package: "@smartergpt/lex-mcp",
      }),
      row({
        source: "mcp-registry",
        app_id: "github:AAA/lex",
        source_id: "com.aaa/extra",
        npm_package: "@SMARTERGPT/lex-mcp",
      }),
    ]);
    expect(output.packageOwners).toEqual([
      {
        npm_package: "@smartergpt/lex-mcp",
        app_id: "github:SmarterGPT/lex",
        owner_decided_by: "scope_matches_github_org",
        claimants: ["github:AAA/lex", "github:SmarterGPT/lex"],
      },
    ]);
    expect(npmOwners(mergeApps(DATE, output.rows)).get("@smartergpt/lex-mcp")).toEqual(["github:SmarterGPT/lex"]);
  });

  it("does not apply the scope rule when two candidates share the org", () => {
    const output = linkCrossStore([
      row({
        source: "mcp-registry",
        app_id: "github:acme/one",
        source_id: "io.github.acme/one",
        repo_url: "https://github.com/ACME/one",
        npm_package: "@Acme/tool",
      }),
      row({
        source: "mcp-registry",
        app_id: "github:acme/two",
        source_id: "io.github.acme/two",
        repo_url: "https://github.com/acme/two",
        npm_package: "@acme/tool",
      }),
      row({
        source: "mcp-registry",
        app_id: "github:other/zzz",
        source_id: "com.other/a",
        repo_url: "https://github.com/other/zzz",
        npm_package: "@acme/tool",
      }),
      row({
        source: "mcp-registry",
        app_id: "github:other/zzz",
        source_id: "com.other/b",
        repo_url: "https://github.com/other/zzz",
        npm_package: "@ACME/tool",
      }),
      row({
        source: "mcp-registry",
        app_id: "github:other/zzz",
        source_id: "com.other/c",
        repo_url: "https://github.com/Other/zzz",
        npm_package: "@acme/tool",
      }),
    ]);
    expect(output.packageOwners).toEqual([
      {
        npm_package: "@acme/tool",
        app_id: "github:other/zzz",
        owner_decided_by: "most_supporting_rows",
        claimants: ["github:acme/one", "github:acme/two", "github:other/zzz"],
      },
    ]);
  });

  it("gives every contested npm package one owner and one reason", () => {
    const rows: SourceRow[] = [];
    const contested: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      const pkg = i % 2 === 0 ? `@org${i}/tool-${i}` : `Tool-${i}`;
      contested.push(pkg.toLowerCase());
      const claimants = 2 + (i % 3);
      for (let c = 0; c < claimants; c += 1) {
        rows.push(
          row({
            source: "mcp-registry",
            app_id: `github:owner${i}/repo${c}`,
            source_id: `io.github.owner${i}/repo${c}`,
            repo_url: `https://github.com/owner${i}/repo${c}`,
            npm_package: pkg,
            fork: c === 1 && i % 5 === 0 ? true : null,
          }),
        );
      }
      if (i % 4 === 0) {
        rows.push(
          row({
            source: "mcp-registry",
            app_id: `github:owner${i}/repo0`,
            source_id: `com.owner${i}/extra`,
            repo_url: `https://github.com/owner${i}/repo0`,
            npm_package: pkg,
          }),
        );
      }
    }
    rows.push(
      row({
        source: "mcp-registry",
        app_id: "github:solo/only",
        source_id: "solo",
        npm_package: "only-pkg",
      }),
    );

    const output = linkCrossStore(rows);
    expect(linkSourceRows(rows)).toEqual(output.rows);
    expect(Object.keys(output.manifest.ownerDecisionCounts).sort()).toEqual([...OWNER_DECISION_REASONS].sort());
    const counted = Object.values(output.manifest.ownerDecisionCounts).reduce((sum, count) => sum + count, 0);
    expect(counted).toBe(output.packageOwners.length);

    const seen = new Set<string>();
    for (const decision of output.packageOwners) {
      expect(seen.has(decision.npm_package), decision.npm_package).toBe(false);
      seen.add(decision.npm_package);
      expect(OWNER_DECISION_REASONS).toContain(decision.owner_decided_by);
      expect(decision.claimants).toContain(decision.app_id);
      expect(new Set(decision.claimants).size).toBe(decision.claimants.length);
    }
    const contestedDecisions = output.packageOwners.filter((decision) => decision.claimants.length > 1);
    expect(contestedDecisions.map((decision) => decision.npm_package).sort()).toEqual([...contested].sort());
    for (const decision of contestedDecisions) {
      expect(decision.owner_decided_by).not.toBe("sole_claimant");
    }
    expect(output.packageOwners.find((decision) => decision.npm_package === "only-pkg")?.owner_decided_by).toBe(
      "sole_claimant",
    );

    const owners = npmOwners(mergeApps(DATE, output.rows));
    for (const decision of output.packageOwners) {
      expect(owners.get(decision.npm_package)).toEqual([decision.app_id]);
    }

    const ties = tieDecidedPackageOwners(output.packageOwners);
    expect(ties.length).toBe(
      output.manifest.ownerDecisionCounts.github_id_fallback + output.manifest.ownerDecisionCounts.smallest_id_fallback,
    );
    expect(ties.every((decision) => isTieDecidedOwnerReason(decision.owner_decided_by))).toBe(true);
    expect(output.packageOwners.filter((decision) => !isTieDecidedOwnerReason(decision.owner_decided_by))).toHaveLength(
      output.packageOwners.length - ties.length,
    );
  });

  it("leaves PyPI owners out of the npm decision manifest", () => {
    const output = linkCrossStore([
      row({
        source: "mcp-registry",
        app_id: "github:aaa/one",
        source_id: "com.example/one",
        repo_url: "https://github.com/aaa/one",
        pypi_package: "Demo_Pkg",
      }),
      row({
        source: "mcp-registry",
        app_id: "gemini-cli:zzz",
        source_id: "zzz",
        pypi_package: "demo_pkg",
      }),
    ]);
    expect(output.packageOwners).toEqual([]);
    expect(output.manifest.ownerDecisionCounts).toEqual({
      sole_claimant: 0,
      scope_matches_github_org: 0,
      most_supporting_rows: 0,
      non_fork: 0,
      repo_name_matches_package: 0,
      github_id_fallback: 0,
      smallest_id_fallback: 0,
    });
    expect(output.rows.find((item) => item.app_id === "github:aaa/one")?.pypi_package).toBe("demo-pkg");
    expect(output.rows.find((item) => item.app_id === "gemini-cli:zzz")?.pypi_package).toBeNull();
  });
});

describe("gemini extension identity", () => {
  it.each(GEMINI_CASES)("maps $label to one record ($appId)", ({ extensions, appId, stars }) => {
    const rows = extensions.map((item) => {
      const normalized = normalizeGeminiExtension(DATE, item);
      expect(normalized).not.toBeNull();
      return normalized!;
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((item) => item.app_id)).size).toBe(2);

    const apps = appsFrom(rows);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ app_id: appId, stars, sources: "gemini-cli" });
  });
});

describe("unrelated apps", () => {
  it("does not merge unrelated apps", () => {
    expect(parseGithubRepo("https://github.com/Example/Weather.git")).toEqual({
      owner: "example",
      repo: "weather",
    });
    expect(parseGithubRepo("https://www.github.com/Example/Weather/")).toEqual({
      owner: "example",
      repo: "weather",
    });
    const sameRepo = appsFrom([
      row({
        source: "mcp-registry",
        app_id: "github:example/weather",
        repo_url: "https://github.com/Example/Weather.git",
        source_id: "io.github.example/weather",
        npm_package: "@example/weather",
      }),
      row({
        source: "smithery",
        app_id: "smithery:example/weather",
        repo_url: "https://github.com/example/weather/",
        source_id: "example/weather",
      }),
    ]);
    expect(sameRepo.map((app) => app.app_id)).toEqual(["github:example/weather"]);

    const sneaky = "https://example.com/catalog/acme-widget?upstream=https://github.com/unrelated/other";
    expect(parseGithubRepo(sneaky)).toBeNull();
    expect(parseGithubRepo("https://mygithub.com/acme/widget")).toBeNull();
    const unrelatedHosts = appsFrom([
      row({
        source: "smithery",
        app_id: "github:unrelated/other",
        repo_url: sneaky,
        source_id: "acme/widget",
        name: "acme/widget",
      }),
      row({
        source: "mcp-registry",
        app_id: "github:unrelated/other",
        repo_url: "https://github.com/unrelated/other",
        source_id: "io.github.unrelated/other",
        name: "other",
      }),
    ]);
    expect(unrelatedHosts.map((app) => app.app_id).sort()).toEqual([
      "github:unrelated/other",
      "smithery:acme/widget",
    ]);

    const sharedPackage = appsFrom([
      row({ source: "mcp-registry", app_id: "github:alpha/one", npm_package: "@shared/kit", name: "alpha" }),
      row({ source: "mcp-registry", app_id: "github:beta/two", npm_package: "@shared/kit", name: "beta" }),
    ]);
    expect(sharedPackage.map((app) => app.app_id)).toEqual(["github:alpha/one", "github:beta/two"]);

    const sameDisplayName = [
      normalizeGeminiExtension(DATE, {
        id: "@wix/wix",
        url: "https://github.com/wix/skills",
        fullName: "wix/skills",
        extensionName: "wix",
        stars: 27,
      }),
      normalizeGeminiExtension(DATE, {
        id: "@other/wix",
        url: "https://github.com/other/wix-skills",
        fullName: "other/wix-skills",
        extensionName: "wix",
        stars: 3,
      }),
    ];
    expect(sameDisplayName.every((item) => item != null)).toBe(true);
    const displayApps = appsFrom(sameDisplayName as SourceRow[]);
    expect(displayApps.map((app) => app.app_id).sort()).toEqual([
      "github:other/wix-skills",
      "github:wix/skills",
    ]);
  });
});
