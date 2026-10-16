import type { ProviderName, TokenUsage } from "./schema.ts";

export type ProviderRates = {
  inputPerMillion: number;
  outputPerMillion: number;
  searchPerCall: number;
  /** Extra billed input tokens assumed per web-search call (e.g. OpenAI mini 8k block). */
  searchInputTokens: number;
  notes: string;
};

export const PROVIDER_RATES: Record<ProviderName, ProviderRates> = {
  openai: {
    inputPerMillion: 0.4,
    outputPerMillion: 1.6,
    searchPerCall: 0.01,
    searchInputTokens: 8_000,
    notes: "gpt-4.1-mini + web_search ($10/1k calls + 8k input block)",
  },
  anthropic: {
    inputPerMillion: 1,
    outputPerMillion: 5,
    searchPerCall: 0.01,
    searchInputTokens: 2_000,
    notes: "claude-haiku-4-5 + web_search ($10/1k searches)",
  },
  gemini: {
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    searchPerCall: 0.035,
    searchInputTokens: 0,
    notes: "gemini-2.5-flash; grounding $35/1k after 1,500 free RPD",
  },
  xai: {
    inputPerMillion: 0.2,
    outputPerMillion: 0.5,
    searchPerCall: 0.005,
    searchInputTokens: 0,
    notes: "grok-4-fast-non-reasoning + web_search ($5/1k calls)",
  },
};

export const DEFAULT_USAGE_PER_CALL: TokenUsage = {
  input_tokens: 600,
  output_tokens: 400,
  web_search_calls: 1,
};

export function usdFromUsage(provider: ProviderName, usage: TokenUsage): number {
  const rates = PROVIDER_RATES[provider];
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const searches = usage.web_search_calls ?? 0;
  const searchTokens = searches * rates.searchInputTokens;
  return (
    ((input + searchTokens) * rates.inputPerMillion) / 1_000_000 +
    (output * rates.outputPerMillion) / 1_000_000 +
    searches * rates.searchPerCall
  );
}

export function estimateProviderCostUsd(provider: ProviderName, calls: number, usage = DEFAULT_USAGE_PER_CALL): number {
  if (calls <= 0) {
    return 0;
  }
  return usdFromUsage(provider, {
    input_tokens: (usage.input_tokens ?? 0) * calls,
    output_tokens: (usage.output_tokens ?? 0) * calls,
    web_search_calls: (usage.web_search_calls ?? 0) * calls,
  });
}

export function parseMaxCalls(env: NodeJS.ProcessEnv, override?: number): number | null {
  if (override != null) {
    if (!Number.isFinite(override) || override < 0) {
      throw new Error(`Invalid maxCalls: ${override}`);
    }
    return Math.floor(override);
  }
  const raw = env.MAX_CALLS?.trim();
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid MAX_CALLS: ${raw}`);
  }
  return Math.floor(value);
}

export function plannedCalls(input: {
  promptCount: number;
  n: number;
  providerCount: number;
  maxCalls: number | null;
}): number {
  const uncapped = input.promptCount * input.n * input.providerCount;
  if (input.maxCalls == null) {
    return uncapped;
  }
  return Math.min(uncapped, input.maxCalls);
}

export function formatUsd(value: number): string {
  if (value === 0) {
    return "$0.00";
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

export function formatCostEstimate(lines: Array<{ provider: ProviderName; calls: number; estimateUsd: number }>): string {
  const out = ["Answer-share cost estimate"];
  let totalCalls = 0;
  let totalUsd = 0;
  for (const line of lines) {
    totalCalls += line.calls;
    totalUsd += line.estimateUsd;
    out.push(
      `  ${line.provider.padEnd(10)} ${String(line.calls).padStart(4)} calls  ${formatUsd(line.estimateUsd).padStart(8)}  ${PROVIDER_RATES[line.provider].notes}`,
    );
  }
  out.push(`  ${"total".padEnd(10)} ${String(totalCalls).padStart(4)} calls  ${formatUsd(totalUsd).padStart(8)}`);
  return out.join("\n");
}
