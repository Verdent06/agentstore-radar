import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidDateString } from "../lib/dates.ts";
import { AnswerShareSnapshotSchema, type AnswerShareRow, type AnswerShareSnapshot } from "../answer-share/schema.ts";
import type { AnswerSharePublic, AnswerShareRowPublic } from "./types.ts";

const OVERALL_LIMIT = 25;
const PROVIDER_LIMIT = 12;

export function listNormalizedAnswerShareDates(root: string): string[] {
  const dir = join(root, "normalized", "answer-share");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => isValidDateString(name) && existsSync(join(dir, name, "shares.json")))
    .sort();
}

function compactRow(row: AnswerShareRow): AnswerShareRowPublic {
  return {
    name: row.name,
    appId: row.matched_app_id,
    mentionCount: row.mention_count,
    answerShare: row.answer_share,
    runShare: row.run_share,
  };
}

function topRows(rows: AnswerShareRow[], limit: number): AnswerShareRowPublic[] {
  return [...rows].sort((a, b) => b.answer_share - a.answer_share || b.mention_count - a.mention_count || a.name.localeCompare(b.name)).slice(0, limit).map(compactRow);
}

export function compactAnswerShare(snapshot: AnswerShareSnapshot): AnswerSharePublic {
  const overall = snapshot.shares.filter((row) => row.provider == null && row.category == null);
  const byProvider: Record<string, AnswerShareRowPublic[]> = {};
  const providers = [...new Set(snapshot.shares.map((row) => row.provider).filter((value): value is NonNullable<typeof value> => value != null))].sort();
  for (const provider of providers) {
    byProvider[provider] = topRows(
      snapshot.shares.filter((row) => row.provider === provider && row.category == null),
      PROVIDER_LIMIT,
    );
  }
  return {
    probeDate: snapshot.probeDate,
    promptVersion: snapshot.promptVersion,
    meanJaccard: snapshot.meanJaccard,
    overall: topRows(overall, OVERALL_LIMIT),
    byProvider,
  };
}

export function loadPublicAnswerShare(dataDir: string): AnswerSharePublic | null {
  const latest = listNormalizedAnswerShareDates(dataDir).at(-1);
  if (!latest) {
    return null;
  }
  const path = join(dataDir, "normalized", "answer-share", latest, "shares.json");
  try {
    return compactAnswerShare(AnswerShareSnapshotSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
  } catch {
    return null;
  }
}

export function answerShareForApp(share: AnswerSharePublic | null, appId: string): AnswerShareRowPublic | null {
  if (!share) {
    return null;
  }
  return share.overall.find((row) => row.appId === appId) ?? null;
}
