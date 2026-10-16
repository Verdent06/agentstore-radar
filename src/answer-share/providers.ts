import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  ANSWER_SHARE_REQUEST_TIMEOUT_MS,
  ANSWER_SHARE_TEMPERATURE,
  GEMINI_GENERATE_BASE,
  OPENAI_RESPONSES_URL,
  XAI_RESPONSES_URL,
} from "../lib/config.ts";
import { HttpError, type HttpClient } from "../lib/http.ts";
import { ANSWER_SHARE_SYSTEM_PROMPT, userPromptFor } from "./prompts.ts";
import type { Prompt, ProviderName, RawResponseRecord, TokenUsage } from "./schema.ts";

export type ProviderConfig = {
  name: ProviderName;
  envKey: string;
  defaultModel: string;
  modelEnv: string;
};

export const PROVIDER_CONFIGS: Record<ProviderName, ProviderConfig> = {
  openai: { name: "openai", envKey: "OPENAI_API_KEY", defaultModel: "gpt-4.1-mini", modelEnv: "OPENAI_MODEL" },
  anthropic: {
    name: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-haiku-4-5",
    modelEnv: "ANTHROPIC_MODEL",
  },
  gemini: { name: "gemini", envKey: "GEMINI_API_KEY", defaultModel: "gemini-2.5-flash", modelEnv: "GEMINI_MODEL" },
  xai: { name: "xai", envKey: "XAI_API_KEY", defaultModel: "grok-4-fast-non-reasoning", modelEnv: "XAI_MODEL" },
};

export type ProviderSettings = {
  model: string;
  temperature: number;
  webSearch: true;
  tool: string;
};

export type ProviderCallInput = {
  prompt: Prompt;
  run: number;
  timestamp: string;
  env: NodeJS.ProcessEnv;
  http: HttpClient;
};

export type ProviderAdapter = {
  name: ProviderName;
  envKey: string;
  settings(env: NodeJS.ProcessEnv): ProviderSettings;
  complete(input: ProviderCallInput): Promise<RawResponseRecord>;
};

function modelFor(config: ProviderConfig, env: NodeJS.ProcessEnv): string {
  return env[config.modelEnv]?.trim() || config.defaultModel;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function collectText(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) {
      into.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, into);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  if (typeof record.text === "string") {
    into.push(record.text);
  }
  if (typeof record.output_text === "string") {
    into.push(record.output_text);
  }
  if (record.content != null) {
    collectText(record.content, into);
  }
  if (record.parts != null) {
    collectText(record.parts, into);
  }
  if (record.output != null) {
    collectText(record.output, into);
  }
  if (record.message != null) {
    collectText(record.message, into);
  }
  if (record.candidates != null) {
    collectText(record.candidates, into);
  }
}

export function extractResponseText(payload: unknown): string {
  const parts: string[] = [];
  const record = asRecord(payload);
  if (typeof record?.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }
  collectText(payload, parts);
  return parts.join("\n").trim();
}

export function usageFromPayload(payload: unknown, fallbackSearches = 0): TokenUsage {
  const record = asRecord(payload);
  const usage = asRecord(record?.usage) ?? asRecord(record?.usageMetadata);
  const input =
    num(usage?.input_tokens) ??
    num(usage?.prompt_tokens) ??
    num(usage?.promptTokenCount) ??
    num(usage?.inputTokens);
  const output =
    num(usage?.output_tokens) ??
    num(usage?.completion_tokens) ??
    num(usage?.candidatesTokenCount) ??
    num(usage?.outputTokens);
  const searches =
    num(usage?.web_search_calls) ??
    num(asRecord(usage?.server_tool_use)?.web_search_requests) ??
    countSearchCalls(payload) ??
    fallbackSearches;
  return { input_tokens: input, output_tokens: output, web_search_calls: searches };
}

function countSearchCalls(payload: unknown): number | undefined {
  const text = JSON.stringify(payload);
  const hits = text.match(/web_search_call|web_search_tool_result|google_search|groundingMetadata/g);
  return hits && hits.length > 0 ? 1 : undefined;
}

function baseRecord(
  input: ProviderCallInput,
  provider: ProviderName,
  settings: ProviderSettings,
  raw: unknown,
  error?: string,
): RawResponseRecord {
  return {
    prompt_id: input.prompt.id,
    category: input.prompt.category,
    provider,
    run: input.run,
    model: settings.model,
    settings,
    timestamp: input.timestamp,
    text: error ? "" : extractResponseText(raw),
    raw,
    usage: error ? undefined : usageFromPayload(raw, 1),
    error,
  };
}

async function postJson(http: HttpClient, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  return http.fetchJson<unknown>(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeoutMs: ANSWER_SHARE_REQUEST_TIMEOUT_MS,
  });
}

export function openaiRequestBody(prompt: Prompt, settings: ProviderSettings): unknown {
  return {
    model: settings.model,
    temperature: settings.temperature,
    tools: [{ type: "web_search", search_context_size: "low" }],
    input: [
      { role: "system", content: ANSWER_SHARE_SYSTEM_PROMPT },
      { role: "user", content: userPromptFor(prompt) },
    ],
  };
}

export function anthropicRequestBody(prompt: Prompt, settings: ProviderSettings): unknown {
  return {
    model: settings.model,
    max_tokens: 1024,
    temperature: settings.temperature,
    system: ANSWER_SHARE_SYSTEM_PROMPT,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    messages: [{ role: "user", content: userPromptFor(prompt) }],
  };
}

export function geminiRequestBody(prompt: Prompt, settings: ProviderSettings): unknown {
  return {
    systemInstruction: { parts: [{ text: ANSWER_SHARE_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: userPromptFor(prompt) }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: settings.temperature },
  };
}

export function xaiRequestBody(prompt: Prompt, settings: ProviderSettings): unknown {
  return {
    model: settings.model,
    temperature: settings.temperature,
    tools: [{ type: "web_search" }],
    input: [
      { role: "system", content: ANSWER_SHARE_SYSTEM_PROMPT },
      { role: "user", content: userPromptFor(prompt) },
    ],
  };
}

function openaiAdapter(): ProviderAdapter {
  const config = PROVIDER_CONFIGS.openai;
  return {
    name: "openai",
    envKey: config.envKey,
    settings(env) {
      return {
        model: modelFor(config, env),
        temperature: ANSWER_SHARE_TEMPERATURE,
        webSearch: true,
        tool: "web_search",
      };
    },
    async complete(input) {
      const settings = this.settings(input.env);
      const key = input.env[config.envKey]?.trim();
      const raw = await postJson(
        input.http,
        OPENAI_RESPONSES_URL,
        { authorization: `Bearer ${key}`, "content-type": "application/json" },
        openaiRequestBody(input.prompt, settings),
      );
      return baseRecord(input, "openai", settings, raw);
    },
  };
}

function anthropicAdapter(): ProviderAdapter {
  const config = PROVIDER_CONFIGS.anthropic;
  return {
    name: "anthropic",
    envKey: config.envKey,
    settings(env) {
      return {
        model: modelFor(config, env),
        temperature: ANSWER_SHARE_TEMPERATURE,
        webSearch: true,
        tool: "web_search_20250305",
      };
    },
    async complete(input) {
      const settings = this.settings(input.env);
      const key = input.env[config.envKey]?.trim();
      const raw = await postJson(
        input.http,
        ANTHROPIC_MESSAGES_URL,
        {
          "x-api-key": key ?? "",
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        anthropicRequestBody(input.prompt, settings),
      );
      return baseRecord(input, "anthropic", settings, raw);
    },
  };
}

function geminiAdapter(): ProviderAdapter {
  const config = PROVIDER_CONFIGS.gemini;
  return {
    name: "gemini",
    envKey: config.envKey,
    settings(env) {
      return {
        model: modelFor(config, env),
        temperature: ANSWER_SHARE_TEMPERATURE,
        webSearch: true,
        tool: "google_search",
      };
    },
    async complete(input) {
      const settings = this.settings(input.env);
      const key = input.env[config.envKey]?.trim();
      const url = `${GEMINI_GENERATE_BASE}/${settings.model}:generateContent`;
      const raw = await postJson(
        input.http,
        url,
        { "x-goog-api-key": key ?? "", "content-type": "application/json" },
        geminiRequestBody(input.prompt, settings),
      );
      return baseRecord(input, "gemini", settings, raw);
    },
  };
}

function xaiAdapter(): ProviderAdapter {
  const config = PROVIDER_CONFIGS.xai;
  return {
    name: "xai",
    envKey: config.envKey,
    settings(env) {
      return {
        model: modelFor(config, env),
        temperature: ANSWER_SHARE_TEMPERATURE,
        webSearch: true,
        tool: "web_search",
      };
    },
    async complete(input) {
      const settings = this.settings(input.env);
      const key = input.env[config.envKey]?.trim();
      const raw = await postJson(
        input.http,
        XAI_RESPONSES_URL,
        { authorization: `Bearer ${key}`, "content-type": "application/json" },
        xaiRequestBody(input.prompt, settings),
      );
      return baseRecord(input, "xai", settings, raw);
    },
  };
}

export const PROVIDERS: Record<ProviderName, ProviderAdapter> = {
  openai: openaiAdapter(),
  anthropic: anthropicAdapter(),
  gemini: geminiAdapter(),
  xai: xaiAdapter(),
};

export function providerApiKey(name: ProviderName, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[PROVIDER_CONFIGS[name].envKey]?.trim();
  return value ? value : undefined;
}

export function isAuthFailure(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 401 || error.status === 403);
}

export function errorMessage(error: unknown): string {
  if (error instanceof HttpError) {
    return `${error.message}: ${error.body.slice(0, 240)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
