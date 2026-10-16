import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnswerShareSnapshot } from "../answer-share/schema.ts";
import { writeNormalized } from "../lib/io.ts";
import { mergeApps } from "../lib/merge.ts";
import { emptySourceRow, type SnapshotManifest, type SourceName, type SourceRow } from "../lib/schema.ts";

export const DEMO_DATES = ["2026-10-08", "2026-10-14", "2026-10-15"] as const;

type Seed = {
  appId: string;
  source: SourceName;
  sourceId: string;
  name: string;
  displayName?: string;
  description: string;
  homepage?: string;
  repoUrl?: string;
  npmPackage?: string;
  pypiPackage?: string;
  verified?: boolean;
  byDate: Record<
    string,
    {
      stars?: number;
      forks?: number;
      useCount?: number;
      npmWeekly?: number;
      pypiWeekly?: number;
      geminiStars?: number;
    }
  >;
};

const SEEDS: Seed[] = [
  {
    appId: "github:brave/brave-search-mcp",
    source: "smithery",
    sourceId: "brave",
    name: "brave",
    displayName: "Brave Search",
    description: "Search the web with the Brave Search API.",
    homepage: "https://github.com/brave/brave-search-mcp",
    repoUrl: "https://github.com/brave/brave-search-mcp",
    verified: true,
    byDate: {
      "2026-10-08": { useCount: 72000 },
      "2026-10-14": { useCount: 85100 },
      "2026-10-15": { useCount: 87579 },
    },
  },
  {
    appId: "github:brave/brave-search-mcp",
    source: "github",
    sourceId: "brave/brave-search-mcp",
    name: "brave-search-mcp",
    displayName: "Brave Search",
    description: "Search the web with the Brave Search API.",
    repoUrl: "https://github.com/brave/brave-search-mcp",
    byDate: {
      "2026-10-08": { stars: 2100, forks: 180 },
      "2026-10-14": { stars: 2280, forks: 190 },
      "2026-10-15": { stars: 2310, forks: 192 },
    },
  },
  {
    appId: "github:example/weather",
    source: "mcp-registry",
    sourceId: "io.github.example/weather",
    name: "io.github.example/weather",
    displayName: "Weather",
    description: "Weather forecasts and severe-weather alerts for any location.",
    homepage: "https://example.com/weather",
    repoUrl: "https://github.com/example/weather",
    npmPackage: "@example/weather-mcp",
    byDate: {
      "2026-10-08": {},
      "2026-10-14": {},
      "2026-10-15": {},
    },
  },
  {
    appId: "github:example/weather",
    source: "smithery",
    sourceId: "weather",
    name: "weather",
    displayName: "Weather",
    description: "Weather forecasts and severe-weather alerts for any location.",
    repoUrl: "https://github.com/example/weather",
    byDate: {
      "2026-10-08": { useCount: 4100 },
      "2026-10-14": { useCount: 4400 },
      "2026-10-15": { useCount: 4520 },
    },
  },
  {
    appId: "github:example/weather",
    source: "github",
    sourceId: "example/weather",
    name: "weather",
    displayName: "Weather",
    description: "Weather forecasts and severe-weather alerts for any location.",
    repoUrl: "https://github.com/example/weather",
    byDate: {
      "2026-10-08": { stars: 40, forks: 6 },
      "2026-10-14": { stars: 48, forks: 7 },
      "2026-10-15": { stars: 50, forks: 7 },
    },
  },
  {
    appId: "github:example/weather",
    source: "npm",
    sourceId: "@example/weather-mcp",
    name: "@example/weather-mcp",
    displayName: "Weather",
    description: "Weather forecasts and severe-weather alerts for any location.",
    npmPackage: "@example/weather-mcp",
    repoUrl: "https://github.com/example/weather",
    byDate: {
      "2026-10-08": { npmWeekly: 1200 },
      "2026-10-14": { npmWeekly: 1540 },
      "2026-10-15": { npmWeekly: 1600 },
    },
  },
  {
    appId: "pypi:example-files-mcp",
    source: "mcp-registry",
    sourceId: "com.example/files",
    name: "com.example/files",
    displayName: "Files",
    description: "Read and write local files and directories from an agent.",
    pypiPackage: "example-files-mcp",
    byDate: {
      "2026-10-08": {},
      "2026-10-14": {},
      "2026-10-15": {},
    },
  },
  {
    appId: "pypi:example-files-mcp",
    source: "pypi",
    sourceId: "example-files-mcp",
    name: "example-files-mcp",
    displayName: "Files",
    description: "Read and write local files and directories from an agent.",
    pypiPackage: "example-files-mcp",
    byDate: {
      "2026-10-08": { pypiWeekly: 800 },
      "2026-10-14": { pypiWeekly: 910 },
      "2026-10-15": { pypiWeekly: 940 },
    },
  },
  {
    appId: "github:obra/superpowers",
    source: "gemini-cli",
    sourceId: "@obra/superpowers",
    name: "superpowers",
    displayName: "Superpowers",
    description: "Core skills library and agentic skills framework.",
    repoUrl: "https://github.com/obra/superpowers",
    byDate: {
      "2026-10-08": { geminiStars: 240000 },
      "2026-10-14": { geminiStars: 288000 },
      "2026-10-15": { geminiStars: 299294 },
    },
  },
  {
    appId: "github:obra/superpowers",
    source: "github",
    sourceId: "obra/superpowers",
    name: "superpowers",
    displayName: "Superpowers",
    description: "Core skills library and agentic skills framework.",
    repoUrl: "https://github.com/obra/superpowers",
    byDate: {
      "2026-10-08": { stars: 240000, forks: 12000 },
      "2026-10-14": { stars: 288000, forks: 14000 },
      "2026-10-15": { stars: 299294, forks: 14500 },
    },
  },
  {
    appId: "github:example/postgres-mcp",
    source: "mcp-registry",
    sourceId: "io.github.example/postgres",
    name: "io.github.example/postgres",
    displayName: "Postgres",
    description: "Query and inspect PostgreSQL databases with read-only SQL.",
    repoUrl: "https://github.com/example/postgres-mcp",
    byDate: {
      "2026-10-08": {},
      "2026-10-14": {},
      "2026-10-15": {},
    },
  },
  {
    appId: "github:example/postgres-mcp",
    source: "smithery",
    sourceId: "postgres",
    name: "postgres",
    displayName: "Postgres",
    description: "Query and inspect PostgreSQL databases with read-only SQL.",
    repoUrl: "https://github.com/example/postgres-mcp",
    byDate: {
      "2026-10-08": { useCount: 18000 },
      "2026-10-14": { useCount: 19200 },
      "2026-10-15": { useCount: 19440 },
    },
  },
  {
    appId: "github:example/postgres-mcp",
    source: "github",
    sourceId: "example/postgres-mcp",
    name: "postgres-mcp",
    displayName: "Postgres",
    description: "Query and inspect PostgreSQL databases with read-only SQL.",
    repoUrl: "https://github.com/example/postgres-mcp",
    byDate: {
      "2026-10-08": { stars: 4200, forks: 310 },
      "2026-10-14": { stars: 4380, forks: 322 },
      "2026-10-15": { stars: 4410, forks: 324 },
    },
  },
  {
    appId: "github:example/slack-mcp",
    source: "smithery",
    sourceId: "slack",
    name: "slack",
    displayName: "Slack",
    description: "Read channels and post messages in a Slack workspace.",
    repoUrl: "https://github.com/example/slack-mcp",
    byDate: {
      "2026-10-08": { useCount: 26000 },
      "2026-10-14": { useCount: 22100 },
      "2026-10-15": { useCount: 21840 },
    },
  },
  {
    appId: "github:example/slack-mcp",
    source: "github",
    sourceId: "example/slack-mcp",
    name: "slack-mcp",
    displayName: "Slack",
    description: "Read channels and post messages in a Slack workspace.",
    repoUrl: "https://github.com/example/slack-mcp",
    byDate: {
      "2026-10-08": { stars: 3100, forks: 240 },
      "2026-10-14": { stars: 3180, forks: 248 },
      "2026-10-15": { stars: 3195, forks: 250 },
    },
  },
  {
    appId: "github:example/playwright-mcp",
    source: "smithery",
    sourceId: "playwright",
    name: "playwright",
    displayName: "Playwright",
    description: "Headless browser automation with Playwright for scraping and QA.",
    repoUrl: "https://github.com/example/playwright-mcp",
    npmPackage: "@example/playwright-mcp",
    byDate: {
      "2026-10-08": { useCount: 9800 },
      "2026-10-14": { useCount: 12100 },
      "2026-10-15": { useCount: 12650 },
    },
  },
  {
    appId: "github:example/playwright-mcp",
    source: "npm",
    sourceId: "@example/playwright-mcp",
    name: "@example/playwright-mcp",
    displayName: "Playwright",
    description: "Headless browser automation with Playwright for scraping and QA.",
    npmPackage: "@example/playwright-mcp",
    repoUrl: "https://github.com/example/playwright-mcp",
    byDate: {
      "2026-10-08": { npmWeekly: 22000 },
      "2026-10-14": { npmWeekly: 26500 },
      "2026-10-15": { npmWeekly: 27100 },
    },
  },
  {
    appId: "github:example/playwright-mcp",
    source: "github",
    sourceId: "example/playwright-mcp",
    name: "playwright-mcp",
    displayName: "Playwright",
    description: "Headless browser automation with Playwright for scraping and QA.",
    repoUrl: "https://github.com/example/playwright-mcp",
    byDate: {
      "2026-10-08": { stars: 8900, forks: 620 },
      "2026-10-14": { stars: 9400, forks: 650 },
      "2026-10-15": { stars: 9520, forks: 658 },
    },
  },
  {
    appId: "github:example/memory-bank",
    source: "smithery",
    sourceId: "memory-bank",
    name: "memory-bank",
    displayName: "Memory Bank",
    description: "Persistent long-term memory bank for coding agents.",
    repoUrl: "https://github.com/example/memory-bank",
    byDate: {
      "2026-10-08": { useCount: 5400 },
      "2026-10-14": { useCount: 6100 },
      "2026-10-15": { useCount: 6280 },
    },
  },
  {
    appId: "github:example/stripe-mcp",
    source: "smithery",
    sourceId: "stripe",
    name: "stripe",
    displayName: "Stripe",
    description: "Create payments, invoices, and billing portal sessions with Stripe.",
    repoUrl: "https://github.com/example/stripe-mcp",
    npmPackage: "@example/stripe-mcp",
    byDate: {
      "2026-10-08": { useCount: 3100 },
      "2026-10-14": { useCount: 3600 },
      "2026-10-15": { useCount: 3720 },
    },
  },
  {
    appId: "github:example/stripe-mcp",
    source: "npm",
    sourceId: "@example/stripe-mcp",
    name: "@example/stripe-mcp",
    displayName: "Stripe",
    description: "Create payments, invoices, and billing portal sessions with Stripe.",
    npmPackage: "@example/stripe-mcp",
    byDate: {
      "2026-10-08": { npmWeekly: 4100 },
      "2026-10-14": { npmWeekly: 4550 },
      "2026-10-15": { npmWeekly: 4680 },
    },
  },
  {
    appId: "github:example/figma-mcp",
    source: "smithery",
    sourceId: "figma",
    name: "figma",
    displayName: "Figma",
    description: "Read Figma design files, comments, and component metadata.",
    repoUrl: "https://github.com/example/figma-mcp",
    byDate: {
      "2026-10-08": { useCount: 7200 },
      "2026-10-14": { useCount: 7900 },
      "2026-10-15": { useCount: 8040 },
    },
  },
  {
    appId: "github:example/github-mcp",
    source: "mcp-registry",
    sourceId: "io.github.example/github",
    name: "io.github.example/github",
    displayName: "GitHub",
    description: "GitHub repos, issues, pull requests, and code search.",
    repoUrl: "https://github.com/example/github-mcp",
    npmPackage: "@example/github-mcp",
    byDate: {
      "2026-10-08": {},
      "2026-10-14": {},
      "2026-10-15": {},
    },
  },
  {
    appId: "github:example/github-mcp",
    source: "smithery",
    sourceId: "github",
    name: "github",
    displayName: "GitHub",
    description: "GitHub repos, issues, pull requests, and code search.",
    repoUrl: "https://github.com/example/github-mcp",
    verified: true,
    byDate: {
      "2026-10-08": { useCount: 41000 },
      "2026-10-14": { useCount: 44800 },
      "2026-10-15": { useCount: 45620 },
    },
  },
  {
    appId: "github:example/github-mcp",
    source: "github",
    sourceId: "example/github-mcp",
    name: "github-mcp",
    displayName: "GitHub",
    description: "GitHub repos, issues, pull requests, and code search.",
    repoUrl: "https://github.com/example/github-mcp",
    byDate: {
      "2026-10-08": { stars: 15200, forks: 1100 },
      "2026-10-14": { stars: 16100, forks: 1160 },
      "2026-10-15": { stars: 16340, forks: 1172 },
    },
  },
  {
    appId: "github:example/github-mcp",
    source: "npm",
    sourceId: "@example/github-mcp",
    name: "@example/github-mcp",
    displayName: "GitHub",
    description: "GitHub repos, issues, pull requests, and code search.",
    npmPackage: "@example/github-mcp",
    byDate: {
      "2026-10-08": { npmWeekly: 38000 },
      "2026-10-14": { npmWeekly: 41200 },
      "2026-10-15": { npmWeekly: 42050 },
    },
  },
  {
    appId: "github:example/notion-mcp",
    source: "smithery",
    sourceId: "notion",
    name: "notion",
    displayName: "Notion",
    description: "Search and update Notion documents and databases.",
    repoUrl: "https://github.com/example/notion-mcp",
    byDate: {
      "2026-10-08": { useCount: 11200 },
      "2026-10-14": { useCount: 11950 },
      "2026-10-15": { useCount: 12110 },
    },
  },
  {
    appId: "github:example/aws-mcp",
    source: "smithery",
    sourceId: "aws",
    name: "aws",
    displayName: "AWS",
    description: "Inspect AWS cloud infrastructure across common services.",
    repoUrl: "https://github.com/example/aws-mcp",
    byDate: {
      "2026-10-08": { useCount: 6400 },
      "2026-10-14": { useCount: 7000 },
      "2026-10-15": { useCount: 7140 },
    },
  },
  {
    appId: "github:example/aws-mcp",
    source: "github",
    sourceId: "example/aws-mcp",
    name: "aws-mcp",
    displayName: "AWS",
    description: "Inspect AWS cloud infrastructure across common services.",
    repoUrl: "https://github.com/example/aws-mcp",
    byDate: {
      "2026-10-08": { stars: 2800, forks: 190 },
      "2026-10-14": { stars: 2950, forks: 198 },
      "2026-10-15": { stars: 2988, forks: 200 },
    },
  },
  {
    appId: "github:example/vault-mcp",
    source: "smithery",
    sourceId: "vault",
    name: "vault",
    displayName: "Vault",
    description: "Read secrets from HashiCorp Vault with tight security policy.",
    repoUrl: "https://github.com/example/vault-mcp",
    byDate: {
      "2026-10-08": { useCount: 1900 },
      "2026-10-14": { useCount: 2050 },
      "2026-10-15": { useCount: 2095 },
    },
  },
  {
    appId: "github:example/calendar-mcp",
    source: "smithery",
    sourceId: "calendar",
    name: "calendar",
    displayName: "Calendar",
    description: "Create calendar events, reminders, and daily agendas.",
    repoUrl: "https://github.com/example/calendar-mcp",
    byDate: {
      "2026-10-08": { useCount: 2500 },
      "2026-10-14": { useCount: 2680 },
      "2026-10-15": { useCount: 2740 },
    },
  },
  {
    appId: "github:example/maps-mcp",
    source: "smithery",
    sourceId: "maps",
    name: "maps",
    displayName: "Maps",
    description: "Geocoding, places search, and map tiles for location agents.",
    repoUrl: "https://github.com/example/maps-mcp",
    byDate: {
      "2026-10-08": { useCount: 3300 },
      "2026-10-14": { useCount: 3490 },
      "2026-10-15": { useCount: 3555 },
    },
  },
  {
    appId: "github:example/chroma-mcp",
    source: "smithery",
    sourceId: "chroma",
    name: "chroma",
    displayName: "Chroma",
    description: "Vector database for RAG: embeddings, collections, and retrieval.",
    repoUrl: "https://github.com/example/chroma-mcp",
    pypiPackage: "chroma-mcp",
    byDate: {
      "2026-10-08": { useCount: 8700 },
      "2026-10-14": { useCount: 9900 },
      "2026-10-15": { useCount: 10220 },
    },
  },
  {
    appId: "github:example/chroma-mcp",
    source: "pypi",
    sourceId: "chroma-mcp",
    name: "chroma-mcp",
    displayName: "Chroma",
    description: "Vector database for RAG: embeddings, collections, and retrieval.",
    pypiPackage: "chroma-mcp",
    byDate: {
      "2026-10-08": { pypiWeekly: 15000 },
      "2026-10-14": { pypiWeekly: 16800 },
      "2026-10-15": { pypiWeekly: 17200 },
    },
  },
  {
    appId: "github:example/chroma-mcp",
    source: "github",
    sourceId: "example/chroma-mcp",
    name: "chroma-mcp",
    displayName: "Chroma",
    description: "Vector database for RAG: embeddings, collections, and retrieval.",
    repoUrl: "https://github.com/example/chroma-mcp",
    byDate: {
      "2026-10-08": { stars: 6100, forks: 430 },
      "2026-10-14": { stars: 6400, forks: 450 },
      "2026-10-15": { stars: 6488, forks: 455 },
    },
  },
  {
    appId: "github:example/universal-search",
    source: "mcp-registry",
    sourceId: "io.github.example/universal-search",
    name: "io.github.example/universal-search",
    displayName: "Universal Search",
    description: "Federated web search across Brave, Bing, and site indexes.",
    repoUrl: "https://github.com/example/universal-search",
    byDate: {
      "2026-10-08": {},
      "2026-10-14": {},
      "2026-10-15": {},
    },
  },
  {
    appId: "github:example/universal-search",
    source: "smithery",
    sourceId: "universal-search",
    name: "universal-search",
    displayName: "Universal Search",
    description: "Federated web search across Brave, Bing, and site indexes.",
    repoUrl: "https://github.com/example/universal-search",
    byDate: {
      "2026-10-08": { useCount: 1400 },
      "2026-10-14": { useCount: 1880 },
      "2026-10-15": { useCount: 2010 },
    },
  },
  {
    appId: "github:example/universal-search",
    source: "gemini-cli",
    sourceId: "@example/universal-search",
    name: "universal-search",
    displayName: "Universal Search",
    description: "Federated web search across Brave, Bing, and site indexes.",
    repoUrl: "https://github.com/example/universal-search",
    byDate: {
      "2026-10-08": { geminiStars: 420 },
      "2026-10-14": { geminiStars: 610 },
      "2026-10-15": { geminiStars: 655 },
    },
  },
  {
    appId: "github:example/obsidian-mcp",
    source: "smithery",
    sourceId: "obsidian",
    name: "obsidian",
    displayName: "Obsidian",
    description: "Read and write an Obsidian vault of markdown documents.",
    repoUrl: "https://github.com/example/obsidian-mcp",
    byDate: {
      "2026-10-08": { useCount: 4800 },
      "2026-10-14": { useCount: 5300 },
      "2026-10-15": { useCount: 5410 },
    },
  },
  {
    appId: "github:example/eslint-mcp",
    source: "npm",
    sourceId: "@example/eslint-mcp",
    name: "@example/eslint-mcp",
    displayName: "ESLint",
    description: "Lint and autofix JavaScript and TypeScript with ESLint.",
    npmPackage: "@example/eslint-mcp",
    repoUrl: "https://github.com/example/eslint-mcp",
    byDate: {
      "2026-10-08": { npmWeekly: 900 },
      "2026-10-14": { npmWeekly: 1180 },
      "2026-10-15": { npmWeekly: 1240 },
    },
  },
  {
    appId: "github:example/linear-mcp",
    source: "smithery",
    sourceId: "linear",
    name: "linear",
    displayName: "Linear",
    description: "Create and search Linear issues for product teams.",
    repoUrl: "https://github.com/example/linear-mcp",
    byDate: {
      "2026-10-15": { useCount: 640 },
    },
  },
  {
    appId: "github:example/linear-mcp",
    source: "github",
    sourceId: "example/linear-mcp",
    name: "linear-mcp",
    displayName: "Linear",
    description: "Create and search Linear issues for product teams.",
    repoUrl: "https://github.com/example/linear-mcp",
    byDate: {
      "2026-10-15": { stars: 88, forks: 4 },
    },
  },
];

function rowsForDate(date: string): SourceRow[] {
  return SEEDS.flatMap((seed) => {
    const point = seed.byDate[date];
    if (!point) {
      return [];
    }
    return [
      emptySourceRow({
        snapshot_date: date,
        app_id: seed.appId,
        source: seed.source,
        source_id: seed.sourceId,
        name: seed.name,
        display_name: seed.displayName ?? seed.name,
        description: seed.description,
        homepage: seed.homepage ?? seed.repoUrl ?? null,
        repo_url: seed.repoUrl ?? null,
        npm_package: seed.npmPackage ?? null,
        pypi_package: seed.pypiPackage ?? null,
        stars: point.geminiStars ?? point.stars ?? null,
        forks: point.forks ?? null,
        use_count: point.useCount ?? null,
        npm_weekly_downloads: point.npmWeekly ?? null,
        pypi_last_week_downloads: point.pypiWeekly ?? null,
        verified: seed.verified ?? null,
      }),
    ];
  });
}

function manifestFor(date: string, sourceRows: SourceRow[], appCount: number): SnapshotManifest {
  const sources: SourceName[] = ["mcp-registry", "smithery", "gemini-cli", "github", "npm", "pypi"];
  return {
    snapshotDate: date,
    collectedAt: `${date}T12:00:00.000Z`,
    appCount,
    sourceRowCount: sourceRows.length,
    sources: sources.map((source) => {
      const count = sourceRows.filter((row) => row.source === source).length;
      return {
        source,
        rowCount: count,
        skipped: false,
        collectedAt: `${date}T12:00:00.000Z`,
        eligibleCount: count,
        fetchedCount: count,
        coverage: 1,
      };
    }),
  };
}

function share(
  name: string,
  appId: string | null,
  provider: "openai" | "anthropic" | "gemini" | "xai" | null,
  mentionCount: number,
  eligible: number,
  totalMentions: number,
): AnswerShareSnapshot["shares"][number] {
  return {
    name,
    matched_app_id: appId,
    provider,
    category: null,
    mention_count: mentionCount,
    run_count: mentionCount,
    eligible_runs: eligible,
    answer_share: totalMentions === 0 ? 0 : mentionCount / totalMentions,
    run_share: eligible === 0 ? 0 : mentionCount / eligible,
  };
}

export function writeDemoAnswerShare(dataDir: string, probeDate = "2026-10-13"): void {
  const snapshot: AnswerShareSnapshot = {
    probeDate,
    promptVersion: "demo-1",
    meanJaccard: 0.62,
    variance: [],
    shares: [
      share("Brave Search", "github:brave/brave-search-mcp", null, 18, 48, 60),
      share("GitHub", "github:example/github-mcp", null, 14, 48, 60),
      share("Playwright", "github:example/playwright-mcp", null, 9, 48, 60),
      share("Postgres", "github:example/postgres-mcp", null, 7, 48, 60),
      share("Notion", "github:example/notion-mcp", null, 5, 48, 60),
      share("Unknown CLI", null, null, 7, 48, 60),
      share("Brave Search", "github:brave/brave-search-mcp", "openai", 8, 12, 18),
      share("GitHub", "github:example/github-mcp", "openai", 5, 12, 18),
      share("Playwright", "github:example/playwright-mcp", "openai", 3, 12, 18),
      share("GitHub", "github:example/github-mcp", "anthropic", 6, 12, 16),
      share("Brave Search", "github:brave/brave-search-mcp", "anthropic", 5, 12, 16),
      share("Postgres", "github:example/postgres-mcp", "anthropic", 3, 12, 16),
      share("Brave Search", "github:brave/brave-search-mcp", "gemini", 5, 12, 14),
      share("Playwright", "github:example/playwright-mcp", "gemini", 4, 12, 14),
      share("Notion", "github:example/notion-mcp", "gemini", 3, 12, 14),
      share("Unknown CLI", null, "xai", 4, 12, 12),
      share("GitHub", "github:example/github-mcp", "xai", 3, 12, 12),
      share("Postgres", "github:example/postgres-mcp", "xai", 2, 12, 12),
    ],
  };
  const dir = join(dataDir, "normalized", "answer-share", probeDate);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "shares.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function writeDemoSnapshots(dataDir: string, dates: readonly string[] = DEMO_DATES): string[] {
  for (const date of dates) {
    const sourceRows = rowsForDate(date);
    const apps = mergeApps(date, sourceRows);
    writeNormalized(date, sourceRows, apps, manifestFor(date, sourceRows, apps.length), dataDir);
  }
  if (dates.length >= 2) {
    writeDemoAnswerShare(dataDir);
  }
  return [...dates];
}
