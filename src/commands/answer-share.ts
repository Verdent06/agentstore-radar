import { extractFromRecords } from "../answer-share/extract.ts";
import { estimateProviderCostUsd, formatCostEstimate, formatUsd, parseMaxCalls, usdFromUsage } from "../answer-share/cost.ts";
import {
  latestAnswerShareDate,
  loadLatestApps,
  readAnswerShareManifest,
  readAnswerShareSnapshot,
  resolveAnswerShareDataDir,
  resolveProbeDate,
  writeAnswerShareOutputs,
} from "../answer-share/io.ts";
import { normalizeMentions } from "../answer-share/match.ts";
import { loadPromptSet } from "../answer-share/prompts.ts";
import {
  PROVIDERS,
  PROVIDER_CONFIGS,
  errorMessage,
  isAuthFailure,
  providerApiKey,
} from "../answer-share/providers.ts";
import { ANSWER_SHARE_DEFAULT_N, ANSWER_SHARE_PROMPT_VERSION } from "../lib/config.ts";
import { utcDateString } from "../lib/dates.ts";
import { createHttpClient, HttpError, type HttpClient } from "../lib/http.ts";
import { createLogger, type Logger } from "../lib/logger.ts";
import { computeAnswerShareSnapshot } from "../answer-share/share.ts";
import type { AppRow } from "../lib/schema.ts";
import type {
  AnswerShareManifest,
  Prompt,
  ProviderName,
  ProviderRun,
  RawResponseRecord,
} from "../answer-share/schema.ts";
import { PROVIDER_NAMES } from "../answer-share/schema.ts";

export const NO_PROVIDERS_CONFIGURED = "no providers configured";
export const NO_PROVIDER_CALLS_SUCCEEDED = "no provider calls succeeded";

function failedCallLabel(error: unknown): string {
  if (error instanceof HttpError) {
    return String(error.status);
  }
  if (error instanceof Error) {
    const status = error.message.match(/\bHTTP (\d{3})\b/);
    return status?.[1] ?? error.message;
  }
  return String(error ?? "unknown");
}

export type AnswerShareCollectOptions = {
  date?: string;
  dataDir?: string;
  providers?: string[];
  n?: number;
  maxCalls?: number;
  promptVersion?: string;
  prompts?: Prompt[];
  env?: NodeJS.ProcessEnv;
  http?: HttpClient;
  log?: Logger;
  now?: Date;
  apps?: AppRow[];
};

function selectedProviders(requested: string[] | undefined): ProviderName[] {
  if (!requested || requested.length === 0) {
    return [...PROVIDER_NAMES];
  }
  const unknown = requested.filter((name) => !PROVIDER_NAMES.includes(name as ProviderName));
  if (unknown.length > 0) {
    throw new Error(`Unknown providers: ${unknown.join(", ")}`);
  }
  return requested as ProviderName[];
}

function parseN(env: NodeJS.ProcessEnv, override?: number): number {
  if (override != null) {
    if (!Number.isInteger(override) || override < 1) {
      throw new Error(`Invalid n: ${override}`);
    }
    return override;
  }
  const raw = env.ANSWER_SHARE_N?.trim();
  if (!raw) {
    return ANSWER_SHARE_DEFAULT_N;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ANSWER_SHARE_N: ${raw}`);
  }
  return value;
}

export async function collectAnswerShare(options: AnswerShareCollectOptions = {}): Promise<AnswerShareManifest> {
  const now = options.now ?? new Date();
  const probeDate = resolveProbeDate(options.date, now);
  const today = utcDateString(now);
  const env = options.env ?? process.env;
  const dataDir = resolveAnswerShareDataDir(options.dataDir, env);
  const log = options.log ?? createLogger();
  const http = options.http ?? createHttpClient();
  const promptVersion = options.promptVersion ?? ANSWER_SHARE_PROMPT_VERSION;
  const promptSet = options.prompts
    ? { version: promptVersion, prompts: options.prompts }
    : loadPromptSet(promptVersion);
  const n = parseN(env, options.n);
  const maxCalls = parseMaxCalls(env, options.maxCalls);
  const requested = selectedProviders(options.providers);
  const collectedAt = now.toISOString();

  const providerStates = requested.map((name) => {
    const key = providerApiKey(name, env);
    const settings = PROVIDERS[name].settings(env);
    if (!key) {
      return {
        name,
        enabled: false as const,
        skipReason: `missing ${PROVIDER_CONFIGS[name].envKey}`,
        settings,
        disabledMidRun: false,
        lastError: undefined as unknown,
      };
    }
    return {
      name,
      enabled: true as const,
      settings,
      disabledMidRun: false,
      skipReason: undefined as string | undefined,
      lastError: undefined as unknown,
    };
  });

  const enabled = providerStates.filter((state) => state.enabled);
  if (enabled.length === 0) {
    log.error(NO_PROVIDERS_CONFIGURED);
    throw new Error(NO_PROVIDERS_CONFIGURED);
  }
  // Fair estimate: interleave until global cap.
  const plannedByProvider = new Map<ProviderName, number>(enabled.map((state) => [state.name, 0]));
  let planned = 0;
  outer: for (let promptIndex = 0; promptIndex < promptSet.prompts.length; promptIndex += 1) {
    for (let run = 1; run <= n; run += 1) {
      for (const state of enabled) {
        if (maxCalls != null && planned >= maxCalls) {
          break outer;
        }
        plannedByProvider.set(state.name, (plannedByProvider.get(state.name) ?? 0) + 1);
        planned += 1;
      }
    }
  }
  const printed = formatCostEstimate(
    enabled.map((state) => {
      const calls = plannedByProvider.get(state.name) ?? 0;
      return { provider: state.name, calls, estimateUsd: estimateProviderCostUsd(state.name, calls) };
    }),
  );
  log.info(printed);
  if (maxCalls != null) {
    log.info(`MAX_CALLS=${maxCalls}`);
  }

  const apps = loadLatestApps(dataDir, options.apps);
  const responses: RawResponseRecord[] = [];
  const callsByProvider = new Map<ProviderName, { calls: number; errors: number; input: number; output: number; searches: number; actual: number }>();
  for (const name of requested) {
    callsByProvider.set(name, { calls: 0, errors: 0, input: 0, output: 0, searches: 0, actual: 0 });
  }

  let callsMade = 0;
  let truncated = false;

  collectLoop: for (const prompt of promptSet.prompts) {
    for (let run = 1; run <= n; run += 1) {
      for (const state of providerStates) {
        if (!state.enabled || state.disabledMidRun) {
          continue;
        }
        if (maxCalls != null && callsMade >= maxCalls) {
          truncated = true;
          log.warn("MAX_CALLS reached; stopping", { maxCalls, callsMade });
          break collectLoop;
        }
        const timestamp = new Date(now.getTime() + callsMade).toISOString();
        const stats = callsByProvider.get(state.name)!;
        try {
          const record = await PROVIDERS[state.name].complete({
            prompt,
            run,
            timestamp,
            env,
            http,
          });
          responses.push(record);
          stats.calls += 1;
          stats.input += record.usage?.input_tokens ?? 0;
          stats.output += record.usage?.output_tokens ?? 0;
          stats.searches += record.usage?.web_search_calls ?? 0;
          stats.actual += usdFromUsage(state.name, record.usage ?? {});
          callsMade += 1;
          log.info("answer-share call", { provider: state.name, prompt: prompt.id, run, callsMade });
        } catch (error) {
          stats.errors += 1;
          stats.calls += 1;
          callsMade += 1;
          const message = errorMessage(error);
          responses.push({
            prompt_id: prompt.id,
            category: prompt.category,
            provider: state.name,
            run,
            model: state.settings.model,
            settings: state.settings,
            timestamp,
            text: "",
            raw: { error: message },
            error: message,
          });
          log.warn("answer-share call failed", { provider: state.name, prompt: prompt.id, run, error: message });
          state.lastError = error;
          if (isAuthFailure(error)) {
            state.disabledMidRun = true;
            state.skipReason = message;
            log.warn(`disabling ${state.name} after auth failure`);
          }
        }
      }
    }
  }

  if (maxCalls != null && callsMade >= maxCalls && planned > callsMade) {
    truncated = true;
  }

  const providerRuns: ProviderRun[] = providerStates.map((state) => {
    const stats = callsByProvider.get(state.name)!;
    const ran = stats.calls - stats.errors > 0;
    const skipped = !state.enabled || stats.calls === stats.errors;
    let skipReason: string | undefined;
    if (!state.enabled) {
      skipReason = state.skipReason;
    } else if (stats.calls === stats.errors && stats.calls > 0) {
      skipReason = `all calls failed: ${failedCallLabel(state.lastError)}`;
    } else if (skipped) {
      skipReason = state.skipReason;
    }
    const estimateCalls = plannedByProvider.get(state.name) ?? 0;
    return {
      provider: state.name,
      ran,
      skipped,
      skipReason,
      model: state.settings.model,
      settings: state.settings,
      calls: stats.calls,
      errors: stats.errors,
      costEstimateUsd: estimateProviderCostUsd(state.name, estimateCalls),
      costActualUsd: Number(stats.actual.toFixed(6)),
      inputTokens: stats.input,
      outputTokens: stats.output,
      webSearchCalls: stats.searches,
    };
  });

  if (!providerRuns.some((row) => row.ran)) {
    log.error(NO_PROVIDER_CALLS_SUCCEEDED);
    throw new Error(NO_PROVIDER_CALLS_SUCCEEDED);
  }

  const extracted = extractFromRecords(responses, promptSet.prompts);
  const mentions = normalizeMentions(extracted, apps);
  const shares = computeAnswerShareSnapshot(probeDate, promptSet.version, mentions, responses);

  const manifest: AnswerShareManifest = {
    probeDate,
    collectedAt,
    promptVersion: promptSet.version,
    n,
    maxCalls,
    callsMade,
    truncated,
    providers: providerRuns,
    ran: providerRuns.filter((row) => row.ran).map((row) => row.provider),
    skipped: providerRuns.filter((row) => row.skipped).map((row) => row.provider),
    promptCount: promptSet.prompts.length,
    mentionCount: mentions.length,
    matchedMentionCount: mentions.filter((mention) => mention.matched_app_id).length,
    costEstimateUsd: providerRuns.reduce((sum, row) => sum + row.costEstimateUsd, 0),
    costActualUsd: providerRuns.reduce((sum, row) => sum + row.costActualUsd, 0),
  };

  writeAnswerShareOutputs({
    date: probeDate,
    today,
    root: dataDir,
    manifest,
    responses,
    extracted,
    mentions,
    shares,
  });

  const actualLines = providerRuns
    .filter((row) => row.ran || row.skipped)
    .map((row) => {
      const status = row.skipped && !row.ran ? `skipped (${row.skipReason})` : `${row.calls} calls`;
      return `  ${row.provider.padEnd(10)} ${status.padEnd(36)} ${formatUsd(row.costActualUsd)} actual / ${formatUsd(row.costEstimateUsd)} est.`;
    });
  log.info(["Answer-share actual cost", ...actualLines, `  total      ${formatUsd(manifest.costActualUsd)}`].join("\n"));
  log.info("answer-share written", {
    date: probeDate,
    calls: callsMade,
    mentions: mentions.length,
    matched: manifest.matchedMentionCount,
    ran: manifest.ran,
    skipped: manifest.skipped,
  });
  return manifest;
}

export type AnswerShareReportOptions = {
  date?: string;
  dataDir?: string;
  limit?: number;
};

export function buildAnswerShareReport(options: AnswerShareReportOptions = {}): string {
  const dataDir = resolveAnswerShareDataDir(options.dataDir);
  const date = options.date ?? latestAnswerShareDate(dataDir);
  if (!date) {
    return "No answer-share probes yet. Run `npm run answer-share` first.";
  }
  const limit = options.limit ?? 10;
  const manifest = readAnswerShareManifest(date, dataDir);
  const snapshot = readAnswerShareSnapshot(date, dataDir);
  const lines: string[] = [];
  lines.push(`Answer share ${date}  (prompt ${manifest.promptVersion}, N=${manifest.n})`);
  lines.push("");
  lines.push(`Providers ran: ${manifest.ran.length > 0 ? manifest.ran.join(", ") : "(none)"}`);
  if (manifest.skipped.length > 0) {
    const reasons = manifest.providers
      .filter((row) => row.skipped)
      .map((row) => `${row.provider} (${row.skipReason ?? "skipped"})`);
    lines.push(`Skipped: ${reasons.join(", ")}`);
  }
  const cap = manifest.maxCalls == null ? "uncapped" : String(manifest.maxCalls);
  lines.push(
    `Calls: ${manifest.callsMade} / MAX_CALLS ${cap}${manifest.truncated ? "  (truncated)" : ""}`,
  );
  lines.push(
    `Cost: ${manifest.providers
      .filter((row) => row.ran)
      .map((row) => `${row.provider} ${formatUsd(row.costActualUsd)}`)
      .join(" · ")}${manifest.ran.length > 0 ? " · " : ""}total ${formatUsd(manifest.costActualUsd)}`,
  );
  if (snapshot.meanJaccard != null) {
    lines.push(`Variance (mean pairwise Jaccard @ N=${manifest.n}): ${snapshot.meanJaccard.toFixed(2)}`);
  }
  lines.push("");

  const groups = new Map<string, typeof snapshot.shares>();
  for (const row of snapshot.shares) {
    const key = `${row.provider ?? "all"} / ${row.category ?? "all categories"}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const [title, rows] of groups) {
    lines.push(`## ${title}`);
    for (const [index, row] of rows.slice(0, limit).entries()) {
      const pct = `${(row.answer_share * 100).toFixed(1)}%`;
      const app = row.matched_app_id ?? "(unmatched)";
      lines.push(`  ${String(index + 1).padStart(2)}. ${pct.padStart(6)}  ${row.name}  ${app}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function printAnswerShareReport(options: AnswerShareReportOptions = {}): string {
  const text = buildAnswerShareReport(options);
  console.log(text);
  return text;
}
