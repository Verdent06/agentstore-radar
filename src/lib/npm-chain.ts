import { appendFileSync } from "node:fs";

/** Follow-up collects started by a budget stop. The run that hits the cap does not dispatch another. */
export const NPM_CHAIN_CAP = 3;

/** No dispatch at or after this UTC hour. The midnight stop is separate. */
export const NPM_CHAIN_STOP_HOUR_UTC = 23;

/**
 * Sources the chained collect runs before npm recovery.
 * npm itself is not in this list: the next run passes `--recover-npm`.
 */
export const CHAINED_COLLECT_SOURCES = [
  "mcp-registry",
  "smithery",
  "gemini-cli",
  "github",
  "pypi",
] as const;

export type NpmChainRequest = {
  ifIncomplete: true;
  recoverNpm: true;
  chain: number;
  sources: readonly string[];
};

export type NpmChainDecision = {
  dispatch: boolean;
  reason: string;
  request?: NpmChainRequest;
};

export function readCollectChain(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.RADAR_COLLECT_CHAIN?.trim();
  if (!raw) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

/**
 * Dispatch another full `--if-incomplete --recover-npm` collect only when npm
 * stopped for the wall-clock budget, made progress, the UTC hour is before
 * 23:00, and this lineage has not already chained {@link NPM_CHAIN_CAP} times.
 */
export function decideNpmChain(input: {
  nowMs: number;
  chain: number;
  halt?: "budget" | "midnight";
  npmFetchedThisRun: number;
  npmRan: boolean;
  dayComplete: boolean;
}): NpmChainDecision {
  if (input.dayComplete) {
    return { dispatch: false, reason: "day is complete" };
  }
  if (input.halt === "midnight") {
    return { dispatch: false, reason: "hit the UTC midnight stop" };
  }
  if (new Date(input.nowMs).getUTCHours() >= NPM_CHAIN_STOP_HOUR_UTC) {
    return { dispatch: false, reason: "at or after 23:00 UTC" };
  }
  if (!input.npmRan) {
    return { dispatch: false, reason: "npm did not run" };
  }
  if (input.halt !== "budget") {
    return { dispatch: false, reason: "npm finished inside the budget and the UTC day" };
  }
  if (input.npmFetchedThisRun <= 0) {
    return { dispatch: false, reason: "no npm progress" };
  }
  if (input.chain >= NPM_CHAIN_CAP) {
    return { dispatch: false, reason: "chain cap of 3 chained runs in this UTC day" };
  }
  const chain = input.chain + 1;
  return {
    dispatch: true,
    reason: "npm hit the wall-clock budget",
    request: {
      ifIncomplete: true,
      recoverNpm: true,
      chain,
      sources: CHAINED_COLLECT_SOURCES,
    },
  };
}

export function formatNpmChainSummary(decision: NpmChainDecision): string {
  const lines = [
    "### npm chain",
    "",
    `- Decision: ${decision.dispatch ? "dispatch" : "stop"}`,
    `- Reason: ${decision.reason}`,
  ];
  if (decision.request) {
    lines.push(
      `- Next: collect --if-incomplete --recover-npm (chain ${decision.request.chain} of ${NPM_CHAIN_CAP})`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function writeCollectOutputs(
  env: NodeJS.ProcessEnv | undefined,
  input: { wrote: boolean; decision: NpmChainDecision },
): void {
  const path = env?.GITHUB_OUTPUT;
  if (!path) {
    return;
  }
  const lines = [
    `wrote=${input.wrote ? "true" : "false"}`,
    `chain_dispatch=${input.decision.dispatch ? "true" : "false"}`,
    `chain_reason=${input.decision.reason}`,
  ];
  if (input.decision.request) {
    lines.push(`chain_next=${input.decision.request.chain}`);
  }
  appendFileSync(path, `${lines.join("\n")}\n`);
}
