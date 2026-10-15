import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { RAW_GZIP_THRESHOLD_BYTES } from "./config.ts";
import { compareDateStrings, isValidDateString } from "./dates.ts";
import type { AppRow, SnapshotManifest, SourceName, SourceRow } from "./schema.ts";
import { AppRowSchema, SnapshotManifestSchema, SourceRowSchema } from "./schema.ts";

export type DataPaths = {
  root: string;
  rawDir: (source: SourceName) => string;
  normalizedDir: (date: string) => string;
  manifestPath: (date: string) => string;
  sourceRowsPath: (date: string) => string;
  appsPath: (date: string) => string;
};

export function dataPaths(root = "data"): DataPaths {
  return {
    root,
    rawDir: (source) => join(root, "raw", source),
    normalizedDir: (date) => join(root, "normalized", date),
    manifestPath: (date) => join(root, "normalized", date, "manifest.json"),
    sourceRowsPath: (date) => join(root, "normalized", date, "source_rows.ndjson"),
    appsPath: (date) => join(root, "normalized", date, "apps.ndjson"),
  };
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function listSnapshotDates(root = "data"): string[] {
  const dir = join(root, "normalized");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => isValidDateString(name) && existsSync(join(dir, name, "manifest.json")))
    .sort(compareDateStrings);
}

export function previousSnapshotDate(date: string, root = "data"): string | undefined {
  return listSnapshotDates(root).filter((candidate) => candidate < date).at(-1);
}

function rawCandidates(dir: string, date: string): string[] {
  return [join(dir, `${date}.json.gz`), join(dir, `${date}.json`)];
}

export function existingRawPath(source: SourceName, date: string, root = "data"): string | undefined {
  const dir = join(root, "raw", source);
  return rawCandidates(dir, date).find((path) => existsSync(path));
}

export function assertNotOverwritingPastRaw(source: SourceName, date: string, today: string, root = "data"): void {
  if (date >= today) {
    return;
  }
  const existing = existingRawPath(source, date, root);
  if (existing) {
    throw new Error(`Refusing to overwrite past snapshot ${existing}`);
  }
}

export async function writeJsonSnapshot(
  source: SourceName,
  date: string,
  today: string,
  payload: unknown,
  root = "data",
): Promise<string> {
  assertNotOverwritingPastRaw(source, date, today, root);
  const dir = join(root, "raw", source);
  ensureDir(dir);
  const json = `${JSON.stringify(payload)}\n`;
  const bytes = Buffer.byteLength(json);
  const gzip = bytes >= RAW_GZIP_THRESHOLD_BYTES;
  const dest = join(dir, gzip ? `${date}.json.gz` : `${date}.json`);
  const other = join(dir, gzip ? `${date}.json` : `${date}.json.gz`);
  if (date === today && existsSync(other)) {
    unlinkSync(other);
  }
  if (gzip) {
    writeFileSync(dest, gzipSync(json, { level: 9 }));
  } else {
    writeFileSync(dest, json);
  }
  return dest;
}

export async function readJsonSnapshot<T>(source: SourceName, date: string, root = "data"): Promise<T> {
  const path = existingRawPath(source, date, root);
  if (!path) {
    throw new Error(`No raw snapshot for ${source} on ${date}`);
  }
  if (path.endsWith(".gz")) {
    return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as T;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeNdjson(path: string, rows: unknown[]): void {
  ensureDir(dirname(path));
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(path, body === "" ? "" : `${body}\n`);
}

export function readNdjson<T>(path: string, parse: (value: unknown) => T): T[] {
  if (!existsSync(path) || statSync(path).size === 0) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parse(JSON.parse(line)));
}

export function writeManifest(path: string, manifest: SnapshotManifest): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function readManifest(date: string, root = "data"): SnapshotManifest {
  const path = dataPaths(root).manifestPath(date);
  return SnapshotManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function readSourceRows(date: string, root = "data"): SourceRow[] {
  return readNdjson(dataPaths(root).sourceRowsPath(date), (value) => SourceRowSchema.parse(value));
}

export function readApps(date: string, root = "data"): AppRow[] {
  return readNdjson(dataPaths(root).appsPath(date), (value) => AppRowSchema.parse(value));
}

export function writeNormalized(date: string, sourceRows: SourceRow[], apps: AppRow[], manifest: SnapshotManifest, root = "data"): void {
  const paths = dataPaths(root);
  ensureDir(paths.normalizedDir(date));
  writeNdjson(paths.sourceRowsPath(date), sourceRows);
  writeNdjson(paths.appsPath(date), apps);
  writeManifest(paths.manifestPath(date), manifest);
}
