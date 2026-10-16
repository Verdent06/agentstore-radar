import { CATEGORY_LABELS, type CategorySlug } from "./types.ts";

type Rule = { slug: Exclude<CategorySlug, "other">; weight: number; terms: string[] };

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "your",
  "you",
  "are",
  "was",
  "can",
  "mcp",
  "server",
  "servers",
  "tool",
  "tools",
  "api",
  "app",
  "apps",
  "agent",
  "agents",
  "using",
  "into",
  "over",
  "via",
]);

const RULES: Rule[] = [
  { slug: "rag", weight: 4, terms: ["rag", "retriev", "embedding", "vector", "pinecone", "chroma", "weaviate", "qdrant", "faiss", "knowledge base", "semantic search"] },
  { slug: "search", weight: 2, terms: ["search", "brave", "serper", "tavily", "bing", "duckduckgo", "google search", "web search", "serp"] },
  { slug: "browser", weight: 3, terms: ["browser", "playwright", "puppeteer", "scrape", "scraping", "crawl", "crawler", "headless", "webpage", "web page"] },
  { slug: "database", weight: 3, terms: ["postgres", "postgresql", "mysql", "sqlite", "mongodb", "redis", "sql", "database", "supabase", "dynamodb", "clickhouse"] },
  { slug: "filesystem", weight: 3, terms: ["filesystem", "file system", "files", "directory", "local file", "read file", "write file"] },
  { slug: "git", weight: 3, terms: ["github", "gitlab", "bitbucket", "pull request", "git repo", "repository", "issue tracker", "gitea"] },
  { slug: "communication", weight: 3, terms: ["slack", "discord", "telegram", "whatsapp", "email", "gmail", "outlook", "sms", "chat room", "imessage"] },
  { slug: "memory", weight: 3, terms: ["memory", "remember", "mem0", "long-term memory", "memory bank"] },
  { slug: "cloud", weight: 3, terms: ["aws", "amazon web", "gcp", "google cloud", "azure", "kubernetes", "k8s", "terraform", "docker", "cloudflare", "vercel"] },
  { slug: "finance", weight: 3, terms: ["stripe", "payment", "billing", "stock", "finance", "crypto", "bitcoin", "trading", "invoice", "bank"] },
  { slug: "design", weight: 3, terms: ["figma", "sketch", "design", "canvas", "illustration", "photoshop", "image gen"] },
  { slug: "maps", weight: 3, terms: ["map", "maps", "geocod", "geojson", "location", "latitude", "weather", "forecast", "places"] },
  { slug: "calendar", weight: 3, terms: ["calendar", "schedule", "scheduling", "reminder", "todo", "agenda", "gcal"] },
  { slug: "ai", weight: 2, terms: ["llm", "openai", "anthropic", "huggingface", "inference", "prompt", "completion", "embeddings model"] },
  { slug: "security", weight: 3, terms: ["security", "secret", "vault", "oauth", "auth0", "sso", "vulnerability", "sast", "password"] },
  { slug: "docs", weight: 3, terms: ["notion", "confluence", "markdown", "pdf", "document", "documents", "docs", "wiki", "obsidian", "knowledge"] },
  { slug: "devtools", weight: 2, terms: ["eslint", "prettier", "lint", "debugger", "ci/cd", "test runner", "vscode", "ide", "compiler"] },
];

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+]+/g)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function termMatches(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i");
  return pattern.test(haystack);
}

export function classifyCategory(name: string, description: string | null | undefined): CategorySlug {
  const haystack = `${name} ${description ?? ""}`.toLowerCase();
  const scores = new Map<CategorySlug, number>();
  for (const rule of RULES) {
    let score = 0;
    for (const term of rule.terms) {
      if (termMatches(haystack, term)) {
        score += rule.weight;
      }
    }
    if (score > 0) {
      scores.set(rule.slug, (scores.get(rule.slug) ?? 0) + score);
    }
  }
  let best: CategorySlug = "other";
  let bestScore = 0;
  for (const [slug, score] of scores) {
    if (score > bestScore) {
      best = slug;
      bestScore = score;
    }
  }
  return best;
}

export function categoryLabel(slug: CategorySlug): string {
  return CATEGORY_LABELS[slug];
}

export function jaccardTokens(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const left = new Set(a);
  const right = new Set(b);
  let inter = 0;
  for (const token of left) {
    if (right.has(token)) {
      inter += 1;
    }
  }
  return inter / (left.size + right.size - inter);
}
