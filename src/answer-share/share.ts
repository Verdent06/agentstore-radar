import type {
  AnswerShareRow,
  AnswerShareSnapshot,
  NormalizedMention,
  PromptCategory,
  PromptVariance,
  ProviderName,
  RawResponseRecord,
} from "./schema.ts";

export type ShareScope = {
  provider: ProviderName | null;
  category: PromptCategory | null;
};

function mentionKey(mention: NormalizedMention): string {
  return mention.matched_app_id ?? `name:${mention.name.trim().toLowerCase()}`;
}

function displayName(mention: NormalizedMention): string {
  return mention.matched_app_id ? mention.name : mention.name;
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  let inter = 0;
  for (const value of left) {
    if (right.has(value)) {
      inter += 1;
    }
  }
  return inter / (left.size + right.size - inter);
}

export function meanPairwiseJaccard(sets: Array<Set<string>>): number | null {
  if (sets.length < 2) {
    return null;
  }
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      sum += jaccard(sets[i] ?? [], sets[j] ?? []);
      pairs += 1;
    }
  }
  return pairs === 0 ? null : sum / pairs;
}

export function computeVariance(mentions: NormalizedMention[]): PromptVariance[] {
  const groups = new Map<string, Map<number, Set<string>>>();
  for (const mention of mentions) {
    const key = `${mention.provider}:${mention.prompt_id}`;
    const runs = groups.get(key) ?? new Map<number, Set<string>>();
    const names = runs.get(mention.run) ?? new Set<string>();
    names.add(mentionKey(mention));
    runs.set(mention.run, names);
    groups.set(key, runs);
  }
  const rows: PromptVariance[] = [];
  for (const [key, runs] of groups) {
    const [provider, promptId] = key.split(":") as [ProviderName, string];
    rows.push({
      prompt_id: promptId,
      provider,
      runs: runs.size,
      mean_jaccard: meanPairwiseJaccard([...runs.values()]),
    });
  }
  return rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.prompt_id.localeCompare(b.prompt_id));
}

function eligibleRuns(records: RawResponseRecord[], provider: ProviderName | null, category: PromptCategory | null): number {
  return records.filter((record) => {
    if (record.error) {
      return false;
    }
    if (provider && record.provider !== provider) {
      return false;
    }
    if (category && record.category !== category) {
      return false;
    }
    return true;
  }).length;
}

function scopedMentions(
  mentions: NormalizedMention[],
  provider: ProviderName | null,
  category: PromptCategory | null,
): NormalizedMention[] {
  return mentions.filter((mention) => {
    if (provider && mention.provider !== provider) {
      return false;
    }
    if (category && mention.category !== category) {
      return false;
    }
    return true;
  });
}

export function computeShareRows(
  mentions: NormalizedMention[],
  records: RawResponseRecord[],
  scopes: ShareScope[],
): AnswerShareRow[] {
  const rows: AnswerShareRow[] = [];
  for (const scope of scopes) {
    const scoped = scopedMentions(mentions, scope.provider, scope.category);
    const totalMentions = scoped.length;
    const eligible = eligibleRuns(records, scope.provider, scope.category);
    const byKey = new Map<string, NormalizedMention[]>();
    for (const mention of scoped) {
      const key = mentionKey(mention);
      const list = byKey.get(key) ?? [];
      list.push(mention);
      byKey.set(key, list);
    }
    for (const group of byKey.values()) {
      const first = group[0];
      if (!first) {
        continue;
      }
      const runKeys = new Set(group.map((item) => `${item.prompt_id}:${item.run}`));
      rows.push({
        name: displayName(first),
        matched_app_id: first.matched_app_id,
        provider: scope.provider,
        category: scope.category,
        mention_count: group.length,
        run_count: runKeys.size,
        eligible_runs: eligible,
        answer_share: totalMentions === 0 ? 0 : group.length / totalMentions,
        run_share: eligible === 0 ? 0 : runKeys.size / eligible,
      });
    }
  }
  return rows.sort((a, b) => {
    const providerCmp = (a.provider ?? "").localeCompare(b.provider ?? "");
    if (providerCmp !== 0) {
      return providerCmp;
    }
    const categoryCmp = (a.category ?? "").localeCompare(b.category ?? "");
    if (categoryCmp !== 0) {
      return categoryCmp;
    }
    return b.answer_share - a.answer_share || b.mention_count - a.mention_count || a.name.localeCompare(b.name);
  });
}

export function defaultScopes(
  mentions: NormalizedMention[],
  records: RawResponseRecord[],
): ShareScope[] {
  const providers = new Set<ProviderName>();
  const categories = new Set<PromptCategory>();
  for (const record of records) {
    providers.add(record.provider);
    categories.add(record.category);
  }
  for (const mention of mentions) {
    providers.add(mention.provider);
    categories.add(mention.category);
  }
  const scopes: ShareScope[] = [{ provider: null, category: null }];
  for (const provider of [...providers].sort()) {
    scopes.push({ provider, category: null });
    for (const category of [...categories].sort()) {
      scopes.push({ provider, category });
    }
  }
  return scopes;
}

export function computeAnswerShareSnapshot(
  probeDate: string,
  promptVersion: string,
  mentions: NormalizedMention[],
  records: RawResponseRecord[],
): AnswerShareSnapshot {
  const variance = computeVariance(mentions);
  const jaccards = variance.map((row) => row.mean_jaccard).filter((value): value is number => value != null);
  const meanJaccard = jaccards.length === 0 ? null : jaccards.reduce((sum, value) => sum + value, 0) / jaccards.length;
  return {
    probeDate,
    promptVersion,
    shares: computeShareRows(mentions, records, defaultScopes(mentions, records)),
    variance,
    meanJaccard,
  };
}
