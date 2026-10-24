import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { RAW_GZIP_THRESHOLD_BYTES } from "./config.ts";
import { compareDateStrings, isValidDateString } from "./dates.ts";
import type { AppRow, SnapshotManifest, SourceName, SourceRow } from "./schema.ts";
import { AppRowSchema, SnapshotManifestSchema, SourceRowSchema, snapshotIsPartial, sourceIsIncomplete } from "./schema.ts";

export type DataPaths = {
  root: string;
  rawDir: (source: SourceName) => string;
  normalizedDir: (date: string) => string;
  manifestPath: (date: string) => string;
  sourceRowsPath: (date: string) => string;
  appsPath: (date: string) => string;
};

export function resolveDataDir(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = override?.trim() || env.DATA_DIR?.trim();
  return value && value.length > 0 ? value : "data";
}

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

export function writeFileAtomic(path: string, data: string | Buffer): void {
  ensureDir(dirname(path));
  const tmp = join(dirname(path), `.tmp-${basename(path)}-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmp, data);
    const size = statSync(tmp).size;
    const expected = Buffer.byteLength(data);
    if (size !== expected) {
      throw new Error(`atomic write size mismatch for ${path}: got ${size}, expected ${expected}`);
    }
    if (size === 0) {
      throw new Error(`refusing to write zero-size file ${path}`);
    }
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) {
      unlinkSync(tmp);
    }
  }
}

function replaceDirAtomic(tmp: string, dest: string): void {
  if (existsSync(dest) && statSync(dest).isFile()) {
    unlinkSync(dest);
  }
  if (existsSync(dest) && statSync(dest).isDirectory()) {
    const bak = `${dest}.bak-${process.pid}-${randomBytes(4).toString("hex")}`;
    renameSync(dest, bak);
    try {
      renameSync(tmp, dest);
      rmSync(bak, { recursive: true, force: true });
    } catch (error) {
      if (!existsSync(dest) && existsSync(bak)) {
        renameSync(bak, dest);
      }
      throw error;
    }
    return;
  }
  renameSync(tmp, dest);
}

export type SnapshotInspection = {
  date: string;
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isFile: boolean;
  usable: boolean;
  needsRetry: boolean;
  reason?: string;
  sizeBytes: number;
  hasManifest: boolean;
  hasApps: boolean;
  hasSourceRows: boolean;
  failedSources: string[];
  truncatedSources: string[];
};

function fileSize(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }
  return statSync(path).size;
}

function hasNonEmptyNdjson(basePath: string): boolean {
  const gz = `${basePath}.gz`;
  if (existsSync(basePath) && statSync(basePath).size > 0) {
    return true;
  }
  return existsSync(gz) && statSync(gz).size > 0;
}

export function inspectSnapshot(date: string, root = "data"): SnapshotInspection {
  const path = dataPaths(root).normalizedDir(date);
  const inspection: SnapshotInspection = {
    date,
    path,
    exists: existsSync(path),
    isDirectory: false,
    isFile: false,
    usable: false,
    needsRetry: true,
    sizeBytes: 0,
    hasManifest: false,
    hasApps: false,
    hasSourceRows: false,
    failedSources: [],
    truncatedSources: [],
  };
  if (!inspection.exists) {
    inspection.reason = "missing";
    return inspection;
  }
  const st = statSync(path);
  inspection.sizeBytes = st.size;
  inspection.isFile = st.isFile();
  inspection.isDirectory = st.isDirectory();
  if (st.isFile()) {
    inspection.reason = st.size === 0 ? "zero-size file" : "snapshot path is a file, not a directory";
    return inspection;
  }
  if (!st.isDirectory()) {
    inspection.reason = "snapshot path is not a directory";
    return inspection;
  }

  const manifestPath = join(path, "manifest.json");
  inspection.hasManifest = existsSync(manifestPath) && statSync(manifestPath).size > 0;
  inspection.hasApps = hasNonEmptyNdjson(join(path, "apps.ndjson"));
  inspection.hasSourceRows = hasNonEmptyNdjson(join(path, "source_rows.ndjson"));
  if (!inspection.hasManifest) {
    inspection.reason = "missing or empty manifest.json";
    return inspection;
  }
  if (!inspection.hasApps) {
    inspection.reason = "missing or empty apps.ndjson";
    return inspection;
  }
  if (!inspection.hasSourceRows) {
    inspection.reason = "missing or empty source_rows.ndjson";
    return inspection;
  }

  try {
    const manifest = SnapshotManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    inspection.failedSources = manifest.sources.filter((source) => source.failed).map((source) => source.source);
    inspection.truncatedSources = manifest.sources
      .filter((source) => source.truncated && !source.failed)
      .map((source) => source.source);
    inspection.usable = true;
    inspection.needsRetry = snapshotIsPartial(manifest) || manifest.sources.some(sourceIsIncomplete);
    if (inspection.needsRetry) {
      const parts = [
        inspection.failedSources.length > 0 ? `failed sources: ${inspection.failedSources.join(", ")}` : undefined,
        inspection.truncatedSources.length > 0 ? `truncated sources: ${inspection.truncatedSources.join(", ")}` : undefined,
      ].filter(Boolean);
      inspection.reason = parts.join("; ") || "partial snapshot";
    }
    return inspection;
  } catch (error) {
    inspection.reason = `invalid manifest.json: ${(error as Error).message}`;
    return inspection;
  }
}

export function isUsableSnapshot(date: string, root = "data"): boolean {
  return inspectSnapshot(date, root).usable;
}

export function snapshotNeedsRetry(date: string, root = "data"): boolean {
  return inspectSnapshot(date, root).needsRetry;
}

export function isBrokenEmptySnapshot(date: string, root = "data"): boolean {
  const inspection = inspectSnapshot(date, root);
  if (!inspection.exists) {
    return false;
  }
  if (inspection.isFile) {
    return true;
  }
  if (!inspection.isDirectory) {
    return true;
  }
  if (inspection.usable) {
    return false;
  }
  const dir = inspection.path;
  const entries = existsSync(dir) ? readdirSync(dir) : [];
  if (entries.length === 0) {
    return true;
  }
  const allEmpty = entries.every((name) => {
    const child = join(dir, name);
    const st = statSync(child);
    return st.isFile() && st.size === 0;
  });
  return allEmpty || !inspection.hasManifest;
}

export function removeBrokenSnapshot(date: string, root = "data"): boolean {
  if (!isBrokenEmptySnapshot(date, root)) {
    return false;
  }
  const path = dataPaths(root).normalizedDir(date);
  if (!existsSync(path)) {
    return false;
  }
  const st = statSync(path);
  if (st.isFile()) {
    unlinkSync(path);
    return true;
  }
  rmSync(path, { recursive: true, force: true });
  return true;
}

export function cleanupBrokenNormalizedEntries(root = "data"): string[] {
  const dir = join(root, "normalized");
  const removed: string[] = [];
  if (!existsSync(dir)) {
    return removed;
  }
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name.startsWith(".tmp-") || name.includes(".bak-")) {
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
      continue;
    }
    if (!isValidDateString(name)) {
      continue;
    }
    if (removeBrokenSnapshot(name, root)) {
      removed.push(name);
    }
  }
  return removed;
}

export function listSnapshotDates(root = "data"): string[] {
  const dir = join(root, "normalized");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => isValidDateString(name) && isUsableSnapshot(name, root))
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
  return rawCandidates(dir, date).find((path) => existsSync(path) && statSync(path).size > 0);
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
    writeFileAtomic(dest, gzipSync(json, { level: 9 }));
  } else {
    writeFileAtomic(dest, json);
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

function ndjsonPath(path: string): string | undefined {
  if (existsSync(path)) {
    return path;
  }
  if (existsSync(`${path}.gz`)) {
    return `${path}.gz`;
  }
  return undefined;
}

export function writeNdjson(path: string, rows: unknown[]): string {
  ensureDir(dirname(path));
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  const text = body === "" ? "\n" : `${body}\n`;
  const gzip = Buffer.byteLength(text) >= RAW_GZIP_THRESHOLD_BYTES;
  const dest = gzip ? `${path}.gz` : path;
  const other = gzip ? path : `${path}.gz`;
  if (existsSync(other)) {
    unlinkSync(other);
  }
  if (gzip) {
    writeFileAtomic(dest, gzipSync(text, { level: 9 }));
  } else {
    writeFileAtomic(dest, text);
  }
  return dest;
}

export function readNdjson<T>(path: string, parse: (value: unknown) => T): T[] {
  const actual = ndjsonPath(path);
  if (!actual || statSync(actual).size === 0) {
    return [];
  }
  const text = actual.endsWith(".gz")
    ? gunzipSync(readFileSync(actual)).toString("utf8")
    : readFileSync(actual, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parse(JSON.parse(line)));
}

export function writeManifest(path: string, manifest: SnapshotManifest): void {
  ensureDir(dirname(path));
  writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
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

function assertUsableNormalizedDir(dir: string, date: string, manifest: SnapshotManifest): void {
  const manifestPath = join(dir, "manifest.json");
  if (fileSize(manifestPath) === 0) {
    throw new Error(`refusing to publish empty snapshot ${date}: missing manifest`);
  }
  SnapshotManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!hasNonEmptyNdjson(join(dir, "apps.ndjson"))) {
    throw new Error(`refusing to publish empty snapshot ${date}: missing apps.ndjson`);
  }
  if (!hasNonEmptyNdjson(join(dir, "source_rows.ndjson"))) {
    throw new Error(`refusing to publish empty snapshot ${date}: missing source_rows.ndjson`);
  }
  if (manifest.snapshotDate !== date) {
    throw new Error(`manifest snapshotDate ${manifest.snapshotDate} does not match ${date}`);
  }
}

export function writeNormalized(
  date: string,
  sourceRows: SourceRow[],
  apps: AppRow[],
  manifest: SnapshotManifest,
  root = "data",
): void {
  const parent = join(root, "normalized");
  ensureDir(parent);
  const dest = join(parent, date);
  const tmp = join(parent, `.tmp-${date}-${process.pid}-${randomBytes(4).toString("hex")}`);
  ensureDir(tmp);
  try {
    writeNdjson(join(tmp, "source_rows.ndjson"), sourceRows);
    writeNdjson(join(tmp, "apps.ndjson"), apps);
    writeManifest(join(tmp, "manifest.json"), manifest);
    assertUsableNormalizedDir(tmp, date, manifest);
    replaceDirAtomic(tmp, dest);
  } finally {
    if (existsSync(tmp)) {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
