import { ANSWER_SHARE_PROMPT_VERSION } from "../lib/config.ts";
import {
  PromptSchema,
  PromptSetSchema,
  type Prompt,
  type PromptCategory,
  type PromptSet,
} from "./schema.ts";

const TASKS: Array<{ category: PromptCategory; text: string }> = [
  // coding
  {
    category: "coding",
    text: "I want my coding assistant to read and write files in a local repo and run tests. Which apps, tools, connectors, or MCP servers would you use or recommend?",
  },
  {
    category: "coding",
    text: "Help me review pull requests on GitHub from an AI assistant. Which apps, tools, connectors, or MCP servers would you use or recommend?",
  },
  {
    category: "coding",
    text: "I need an assistant that can search the web and then open a GitHub issue with a repro. Which apps, tools, connectors, or MCP servers would you recommend?",
  },
  {
    category: "coding",
    text: "Set up an agent that can query a Postgres database while editing TypeScript. Which apps, tools, connectors, or MCP servers would you use?",
  },
  {
    category: "coding",
    text: "I want browser automation so an assistant can click through our web app and file bugs. Which tools or MCP servers would you recommend?",
  },
  {
    category: "coding",
    text: "Recommend tools so an assistant can search our Slack for context and then open a Linear ticket.",
  },
  {
    category: "coding",
    text: "I need an assistant that understands our GitLab merge requests and can suggest reviewers. Which connectors or MCP servers should I use?",
  },
  {
    category: "coding",
    text: "Help me wire an AI coding agent to npm so it can inspect package docs and download counts before adding a dependency.",
  },
  {
    category: "coding",
    text: "I want my assistant to run Playwright tests and post results to GitHub Checks. Which apps or MCP servers would you recommend?",
  },
  {
    category: "coding",
    text: "Recommend MCP servers or connectors so a coding agent can search Stack Overflow, read local files, and commit on a branch.",
  },
  // travel
  {
    category: "travel",
    text: "Plan a week in Tokyo with flights, hotels, and a packing list. Which apps, tools, connectors, or MCP servers would you use or recommend?",
  },
  {
    category: "travel",
    text: "I need live flight status and rebooking options for a delayed connection. Which travel apps or assistant tools would you recommend?",
  },
  {
    category: "travel",
    text: "Find visa requirements and embassy links for a US citizen visiting Brazil. Which tools or connectors should an assistant use?",
  },
  {
    category: "travel",
    text: "Compare Airbnb versus hotels near a conference venue and drop the shortlist into a shared doc. Which apps would you use?",
  },
  {
    category: "travel",
    text: "Build a road-trip itinerary with maps, charging stops, and weather. Which apps, tools, or MCP servers would you recommend?",
  },
  {
    category: "travel",
    text: "I want an assistant to watch Google Flights prices and email me when a Seattle–Lisbon fare drops. Which tools would you use?",
  },
  {
    category: "travel",
    text: "Recommend restaurant and transit apps an assistant should consult for a first visit to Mexico City.",
  },
  {
    category: "travel",
    text: "Help me coordinate a group trip: shared expenses, calendar holds, and a packing checklist. Which apps or connectors?",
  },
  {
    category: "travel",
    text: "I need real-time train times in the UK plus hotel cancellation policies. Which tools or MCP servers should an assistant use?",
  },
  // finance
  {
    category: "finance",
    text: "I want an assistant to summarize my Stripe payouts and flag failed charges. Which apps, tools, connectors, or MCP servers would you recommend?",
  },
  {
    category: "finance",
    text: "Help me compare high-yield savings accounts and current Treasury yields. Which finance tools should an assistant use?",
  },
  {
    category: "finance",
    text: "I need a weekly digest of my bank transactions categorized for taxes. Which apps or connectors would you use?",
  },
  {
    category: "finance",
    text: "Recommend tools so an assistant can pull public company filings and recent earnings-call notes.",
  },
  {
    category: "finance",
    text: "I want to model a freelance cash-flow forecast from invoices in QuickBooks. Which apps or MCP servers?",
  },
  {
    category: "finance",
    text: "Watch BTC and ETH prices and explain unusual moves using news. Which tools or connectors would you recommend?",
  },
  {
    category: "finance",
    text: "Help an assistant reconcile PayPal and bank statements into a spreadsheet. Which apps should it use?",
  },
  {
    category: "finance",
    text: "I need mortgage-rate comparisons and a simple amortization walkthrough. Which finance apps or data tools?",
  },
  {
    category: "finance",
    text: "Recommend connectors so an assistant can read Plaid-linked accounts and post a budget summary to Slack.",
  },
  // productivity
  {
    category: "productivity",
    text: "I want an assistant that turns meeting notes into Notion tasks and calendar holds. Which apps, tools, connectors, or MCP servers would you recommend?",
  },
  {
    category: "productivity",
    text: "Triage my Gmail, draft replies, and file follow-ups in Todoist. Which tools would you use?",
  },
  {
    category: "productivity",
    text: "Sync action items from Slack threads into Linear and block time on Google Calendar. Which connectors?",
  },
  {
    category: "productivity",
    text: "I need an assistant to search my Google Drive and summarize a project folder. Which apps or MCP servers?",
  },
  {
    category: "productivity",
    text: "Recommend tools so an assistant can manage an Obsidian vault and daily notes from chat.",
  },
  {
    category: "productivity",
    text: "Help me run a weekly review across Asana, email, and my calendar. Which apps should the assistant connect?",
  },
  {
    category: "productivity",
    text: "I want voice memos transcribed and dropped into Apple Reminders or a similar list app. Which tools?",
  },
  {
    category: "productivity",
    text: "Build a personal CRM of people I meet, stored in Airtable. Which apps, tools, or MCP servers would you use?",
  },
  {
    category: "productivity",
    text: "Recommend connectors so an assistant can read Microsoft Outlook mail and create Teams meeting notes.",
  },
  {
    category: "productivity",
    text: "I need an assistant to capture browser tabs into a reading list and later summarize them. Which tools?",
  },
  // design
  {
    category: "design",
    text: "I want an assistant that can comment on Figma frames and file design QA issues. Which apps, tools, connectors, or MCP servers would you recommend?",
  },
  {
    category: "design",
    text: "Generate a mood board from live web references and drop assets into a shared Drive folder. Which tools?",
  },
  {
    category: "design",
    text: "Help me export icons from Figma and open a pull request with the SVG set. Which connectors or MCP servers?",
  },
  {
    category: "design",
    text: "Recommend tools so an assistant can check contrast and spacing against our design tokens in GitHub.",
  },
  {
    category: "design",
    text: "I need brand-kit lookups (hex, type, logo) from a Notion source of truth during critique. Which apps?",
  },
  {
    category: "design",
    text: "Watch Dribbble and Behance for motion-design trends and file a weekly digest. Which tools would you use?",
  },
  {
    category: "design",
    text: "Help an assistant turn a Canva social template into sized exports for Instagram and LinkedIn.",
  },
  {
    category: "design",
    text: "I want screenshot-to-ticket flow: capture a UI bug, attach it, and create a Jira issue. Which apps?",
  },
  {
    category: "design",
    text: "Recommend MCP servers or connectors for searching icon libraries and inserting SVGs into a local repo.",
  },
  // data
  {
    category: "data",
    text: "I want an assistant that can run SQL on BigQuery and chart the result. Which apps, tools, connectors, or MCP servers would you recommend?",
  },
  {
    category: "data",
    text: "Help me document dbt models and open a PR when a test fails. Which data tools should it use?",
  },
  {
    category: "data",
    text: "Recommend connectors so an assistant can query Snowflake and write a notebook summary.",
  },
  {
    category: "data",
    text: "I need weekly product metrics from Mixpanel dropped into a Google Sheet. Which apps or MCP servers?",
  },
  {
    category: "data",
    text: "Set up an assistant that can search our Metabase dashboards and explain a spike. Which tools?",
  },
  {
    category: "data",
    text: "I want to pull CSV exports from a Postgres replica and profile missing values. Which tools would you use?",
  },
  {
    category: "data",
    text: "Recommend a stack so an assistant can talk to Databricks and log findings in Notion.",
  },
  {
    category: "data",
    text: "Help me keep an Airtable base in sync with a public dataset that updates weekly. Which apps?",
  },
  {
    category: "data",
    text: "I need an assistant that can query Elasticsearch logs and file an incident note. Which connectors?",
  },
  // marketing
  {
    category: "marketing",
    text: "Draft a product-launch email, pull the list from HubSpot, and schedule it. Which apps, tools, connectors, or MCP servers would you recommend?",
  },
  {
    category: "marketing",
    text: "I want an assistant to research competing landing pages and dump notes into a Notion brief. Which tools?",
  },
  {
    category: "marketing",
    text: "Recommend connectors so an assistant can pull Google Analytics traffic and write a Slack recap.",
  },
  {
    category: "marketing",
    text: "Help me generate social posts and schedule them in Buffer or a similar tool. Which apps?",
  },
  {
    category: "marketing",
    text: "Watch brand mentions on X/Twitter and file high-priority ones as Zendesk tickets. Which tools?",
  },
  {
    category: "marketing",
    text: "I need SEO keyword research plus a draft outline stored in Google Docs. Which apps or MCP servers?",
  },
  {
    category: "marketing",
    text: "Recommend tools so an assistant can A/B test subject lines using our ESP and report open rates.",
  },
  {
    category: "marketing",
    text: "Pull ad spend from Meta Ads and Google Ads into one weekly budget sheet. Which connectors?",
  },
  {
    category: "marketing",
    text: "I want an assistant to turn a webinar transcript into a blog post and a LinkedIn thread. Which apps?",
  },
  // education
  {
    category: "education",
    text: "I want a study assistant that quizzes me from my Anki deck and adds missed cards. Which apps, tools, connectors, or MCP servers would you recommend?",
  },
  {
    category: "education",
    text: "Help a teacher generate a lesson plan from a YouTube lecture and post it to Google Classroom. Which tools?",
  },
  {
    category: "education",
    text: "Recommend connectors so an assistant can search arXiv and Zotero and draft a literature-review outline.",
  },
  {
    category: "education",
    text: "I need flashcards from a PDF textbook stored in Notion. Which apps or MCP servers?",
  },
  {
    category: "education",
    text: "Build a language-learning routine using spaced repetition and short news articles. Which tools?",
  },
  {
    category: "education",
    text: "Help a student track Coursera deadlines on a calendar and summarize lecture notes. Which apps?",
  },
  {
    category: "education",
    text: "I want an assistant to grade short quizzes in a Google Form and email feedback. Which connectors?",
  },
  {
    category: "education",
    text: "Recommend tools so an assistant can pull Khan Academy practice sets and log scores in a sheet.",
  },
  {
    category: "education",
    text: "Find open textbooks and citation-ready sources for a high-school history essay. Which tools would you use?",
  },
  // shopping
  {
    category: "shopping",
    text: "Help me find a quiet mechanical keyboard under $150 with current prices and reviews. Which apps, tools, connectors, or MCP servers would you recommend?",
  },
  {
    category: "shopping",
    text: "I want an assistant to watch Amazon and Best Buy for a GPU restock and text me. Which tools?",
  },
  {
    category: "shopping",
    text: "Compare grocery delivery from Instacart versus a local store pickup list. Which apps should it use?",
  },
  {
    category: "shopping",
    text: "Recommend connectors so an assistant can check size charts and return policies before I buy clothes online.",
  },
  {
    category: "shopping",
    text: "Build a wedding-registry shortlist across Crate & Barrel and Amazon with a shared spreadsheet. Which tools?",
  },
  {
    category: "shopping",
    text: "I need price-history charts and coupon codes for a home-office chair. Which shopping tools?",
  },
  {
    category: "shopping",
    text: "Help an assistant track package deliveries from UPS, USPS, and Amazon in one digest. Which apps?",
  },
  {
    category: "shopping",
    text: "Find ethical/sustainable alternatives to a popular sneaker and cite sources. Which tools or MCP servers?",
  },
  {
    category: "shopping",
    text: "I want to reorder household staples when a Notion inventory list runs low. Which connectors?",
  },
  // health
  {
    category: "health",
    text: "I want an assistant that logs workouts from my Apple Watch and suggests a recovery day. Which apps, tools, connectors, or MCP servers would you recommend?",
  },
  {
    category: "health",
    text: "Help me prep questions for a physical using my recent lab PDF and medication list. Which tools?",
  },
  {
    category: "health",
    text: "Recommend apps so an assistant can plan a week of meals for a gluten-free athlete.",
  },
  {
    category: "health",
    text: "I need sleep-trend summaries from Oura or a similar ring plus a short coaching note. Which connectors?",
  },
  {
    category: "health",
    text: "Find nearby clinics that take my insurance and have Saturday hours. Which tools should an assistant use?",
  },
  {
    category: "health",
    text: "Track water, steps, and mood in a simple daily note I can search later. Which apps or MCP servers?",
  },
  {
    category: "health",
    text: "Help an assistant explain a drug-interaction warning using official labels, not random blogs. Which sources or tools?",
  },
  {
    category: "health",
    text: "I want guided stretching routines based on a Strava run history. Which apps would you recommend?",
  },
  {
    category: "health",
    text: "Recommend connectors so a caregiver can share a medication schedule via calendar and SMS reminders.",
  },
  // devops
  {
    category: "devops",
    text: "I want an assistant that can inspect Kubernetes pods and open a GitHub issue when a deploy fails. Which apps, tools, connectors, or MCP servers would you recommend?",
  },
  {
    category: "devops",
    text: "Help me query Datadog or Grafana when error rates spike and post a Slack incident update. Which tools?",
  },
  {
    category: "devops",
    text: "Recommend MCP servers so an assistant can read AWS CloudWatch logs and suggest a rollback.",
  },
  {
    category: "devops",
    text: "I need CI status from GitHub Actions plus the failing test log in one reply. Which connectors?",
  },
  {
    category: "devops",
    text: "Set up an assistant that can open a PagerDuty incident and pull the latest runbook from Notion. Which apps?",
  },
  {
    category: "devops",
    text: "Help me review Terraform plans and comment on a pull request before apply. Which tools or MCP servers?",
  },
  {
    category: "devops",
    text: "I want Docker image CVE scans summarized and filed as Jira tickets. Which apps would you use?",
  },
  {
    category: "devops",
    text: "Recommend connectors so an assistant can restart a Heroku dyno and tail logs.",
  },
  {
    category: "devops",
    text: "Watch Sentry for a new high-volume error and draft a postmortem outline. Which tools?",
  },
  {
    category: "devops",
    text: "I need an assistant that can query Prometheus and compare the last two deploys on Vercel. Which apps or MCP servers?",
  },
];

function numberedId(category: PromptCategory, index: number): string {
  return `${category}-${String(index + 1).padStart(3, "0")}`;
}

export const ANSWER_SHARE_SYSTEM_PROMPT = `You recommend concrete apps, tools, connectors, and MCP servers for a user's task.

Rules:
- Name real products people can install or connect (for example GitHub, Slack, Notion, Stripe, Playwright, filesystem MCP, Postgres MCP).
- Prefer MCP servers, official connectors, and AI-app integrations when they exist.
- Rank 3 to 8 items, most useful first.
- Reply with JSON only, no markdown fences:
{"mentions":[{"name":"GitHub","reason":"review pull requests"}]}
`;

export function buildPromptSet(version = ANSWER_SHARE_PROMPT_VERSION): PromptSet {
  const counts = new Map<PromptCategory, number>();
  const prompts: Prompt[] = TASKS.map((task) => {
    const index = counts.get(task.category) ?? 0;
    counts.set(task.category, index + 1);
    return PromptSchema.parse({
      id: numberedId(task.category, index),
      category: task.category,
      text: task.text,
    });
  });
  return PromptSetSchema.parse({ version, prompts });
}

export const PROMPT_SET_V1 = buildPromptSet("v1");

export function loadPromptSet(version = ANSWER_SHARE_PROMPT_VERSION): PromptSet {
  if (version === "v1") {
    return PROMPT_SET_V1;
  }
  throw new Error(`Unknown answer-share prompt version: ${version}`);
}

export function listPromptVersions(): string[] {
  return ["v1"];
}

export function userPromptFor(prompt: Prompt): string {
  return `${prompt.text}

Reply with JSON only as specified.`;
}
