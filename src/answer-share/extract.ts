import type { ExtractedMention, Prompt, PromptCategory, RawResponseRecord } from "./schema.ts";

export type ParsedMention = {
  name: string;
  reason?: string;
};

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(trimmed);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function mentionFromUnknown(value: unknown): ParsedMention | null {
  if (typeof value === "string" && value.trim()) {
    return { name: value.trim() };
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const name = record.name ?? record.tool ?? record.app ?? record.title;
  if (typeof name !== "string" || name.trim() === "") {
    return null;
  }
  const reason = record.reason ?? record.why ?? record.note;
  return {
    name: name.trim(),
    reason: typeof reason === "string" && reason.trim() ? reason.trim() : undefined,
  };
}

function parseJsonMentions(text: string): ParsedMention[] {
  const candidates = [stripFences(text)];
  const embedded = text.match(/\{[\s\S]*"mentions"[\s\S]*\}/);
  if (embedded?.[0]) {
    candidates.push(embedded[0]);
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const record = asRecord(parsed);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(record?.mentions)
          ? record?.mentions
          : Array.isArray(record?.tools)
            ? record?.tools
            : Array.isArray(record?.recommendations)
              ? record?.recommendations
              : null;
      if (!list) {
        continue;
      }
      const mentions = list.map(mentionFromUnknown).filter((item): item is ParsedMention => item != null);
      if (mentions.length > 0) {
        return mentions;
      }
    } catch {
      // try next candidate
    }
  }
  return [];
}

const LIST_LINE =
  /^(?:\d+[).:]|[-*•])\s+\*?\*?(.+?)(?:\*?\*?)(?:\s*(?:[—–\-:|]|–)\s+(.+))?$/;

function parseListMentions(text: string): ParsedMention[] {
  const mentions: ParsedMention[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = LIST_LINE.exec(line);
    if (!match?.[1]) {
      continue;
    }
    const name = match[1].replace(/[`"'“”]/g, "").trim();
    if (name.length < 2 || name.length > 80) {
      continue;
    }
    if (/^mentions\b/i.test(name)) {
      continue;
    }
    mentions.push({
      name,
      reason: match[2]?.trim() || undefined,
    });
  }
  return mentions;
}

export function extractMentionNames(text: string): ParsedMention[] {
  if (!text.trim()) {
    return [];
  }
  const fromJson = parseJsonMentions(text);
  if (fromJson.length > 0) {
    return dedupeMentions(fromJson);
  }
  return dedupeMentions(parseListMentions(text));
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupeMentions(mentions: ParsedMention[]): ParsedMention[] {
  const seen = new Set<string>();
  const out: ParsedMention[] = [];
  for (const mention of mentions) {
    const key = normalizeKey(mention.name);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(mention);
  }
  return out;
}

export function mentionsFromResponse(
  record: Pick<RawResponseRecord, "prompt_id" | "provider" | "run" | "text">,
  category: PromptCategory,
): ExtractedMention[] {
  return extractMentionNames(record.text).map((mention, index) => ({
    prompt_id: record.prompt_id,
    category,
    provider: record.provider,
    run: record.run,
    name: mention.name,
    rank: index + 1,
    reason: mention.reason,
  }));
}

export function extractFromRecords(records: RawResponseRecord[], prompts: Prompt[]): ExtractedMention[] {
  const categoryById = new Map(prompts.map((prompt) => [prompt.id, prompt.category]));
  const mentions: ExtractedMention[] = [];
  for (const record of records) {
    const category = categoryById.get(record.prompt_id) ?? record.category;
    mentions.push(...mentionsFromResponse(record, category));
  }
  return mentions;
}
