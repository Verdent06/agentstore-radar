import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidDateString, utcDateString } from "../lib/dates.ts";
import { ensureDir, listSnapshotDates, readApps, readNdjson, resolveDataDir, writeNdjson } from "../lib/io.ts";
import type { AppRow } from "../lib/schema.ts";
import {
  AnswerShareManifestSchema,
  AnswerShareSnapshotSchema,
  ExtractedMentionSchema,
  NormalizedMentionSchema,
  RawResponseRecordSchema,
  type AnswerShareManifest,
  type AnswerShareSnapshot,
  type ExtractedMention,
  type NormalizedMention,
  type RawResponseRecord,
} from "./schema.ts";

export function answerShareRawDir(date: string, root = "data"): string {
  return join(root, "raw", "answer-share", date);
}

export function answerShareNormalizedDir(date: string, root = "data"): string {
  return join(root, "normalized", "answer-share", date);
}

export function answerSharePaths(date: string, root = "data") {
  const raw = answerShareRawDir(date, root);
  const normalized = answerShareNormalizedDir(date, root);
  return {
    rawDir: raw,
    normalizedDir: normalized,
    manifestPath: join(raw, "manifest.json"),
    responsesPath: join(raw, "responses.ndjson"),
    extractedPath: join(raw, "extracted.ndjson"),
    mentionsPath: join(normalized, "mentions.ndjson"),
    sharesPath: join(normalized, "shares.json"),
  };
}

export function existingAnswerShareDir(date: string, root = "data"): string | undefined {
  const dir = answerShareRawDir(date, root);
  return existsSync(dir) ? dir : undefined;
}

export function assertNotOverwritingPastAnswerShare(date: string, today: string, root = "data"): void {
  if (date >= today) {
    return;
  }
  const existing = existingAnswerShareDir(date, root);
  if (existing) {
    throw new Error(`Refusing to overwrite past answer-share probe ${existing}`);
  }
}

export function writeAnswerShareManifest(path: string, manifest: AnswerShareManifest): void {
  ensureDir(join(path, ".."));
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function readAnswerShareManifest(date: string, root = "data"): AnswerShareManifest {
  const path = answerSharePaths(date, root).manifestPath;
  return AnswerShareManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeAnswerShareOutputs(input: {
  date: string;
  today: string;
  root: string;
  manifest: AnswerShareManifest;
  responses: RawResponseRecord[];
  extracted: ExtractedMention[];
  mentions: NormalizedMention[];
  shares: AnswerShareSnapshot;
}): void {
  assertNotOverwritingPastAnswerShare(input.date, input.today, input.root);
  const paths = answerSharePaths(input.date, input.root);
  if (input.date === input.today && existsSync(paths.rawDir)) {
    rmSync(paths.rawDir, { recursive: true, force: true });
  }
  if (input.date === input.today && existsSync(paths.normalizedDir)) {
    rmSync(paths.normalizedDir, { recursive: true, force: true });
  }
  ensureDir(paths.rawDir);
  ensureDir(paths.normalizedDir);
  writeNdjson(paths.responsesPath, input.responses);
  writeNdjson(paths.extractedPath, input.extracted);
  writeNdjson(paths.mentionsPath, input.mentions);
  writeFileSync(paths.sharesPath, `${JSON.stringify(input.shares, null, 2)}\n`);
  writeAnswerShareManifest(paths.manifestPath, input.manifest);
}

export function readAnswerShareResponses(date: string, root = "data"): RawResponseRecord[] {
  return readNdjson(answerSharePaths(date, root).responsesPath, (value) => RawResponseRecordSchema.parse(value));
}

export function readAnswerShareExtracted(date: string, root = "data"): ExtractedMention[] {
  return readNdjson(answerSharePaths(date, root).extractedPath, (value) => ExtractedMentionSchema.parse(value));
}

export function readAnswerShareMentions(date: string, root = "data"): NormalizedMention[] {
  return readNdjson(answerSharePaths(date, root).mentionsPath, (value) => NormalizedMentionSchema.parse(value));
}

export function readAnswerShareSnapshot(date: string, root = "data"): AnswerShareSnapshot {
  const path = answerSharePaths(date, root).sharesPath;
  return AnswerShareSnapshotSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function listAnswerShareDates(root = "data"): string[] {
  const dir = join(root, "raw", "answer-share");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => isValidDateString(name) && existsSync(join(dir, name, "manifest.json")))
    .sort();
}

export function latestAnswerShareDate(root = "data"): string | undefined {
  return listAnswerShareDates(root).at(-1);
}

export function loadLatestApps(root = "data", explicit?: AppRow[]): AppRow[] {
  if (explicit) {
    return explicit;
  }
  const dates = listSnapshotDates(root);
  const latest = dates.at(-1);
  if (!latest) {
    return [];
  }
  return readApps(latest, root);
}

export function resolveAnswerShareDataDir(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveDataDir(override, env);
}

export function resolveProbeDate(override: string | undefined, now: Date): string {
  return override ?? utcDateString(now);
}
