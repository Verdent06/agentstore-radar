import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RAW_GZIP_THRESHOLD_BYTES } from "../src/lib/config.ts";
import {
  assertNotOverwritingPastRaw,
  cleanupBrokenNormalizedEntries,
  existingRawPath,
  inspectSnapshot,
  writeFileAtomic,
  writeJsonSnapshot,
  writeNormalized,
} from "../src/lib/io.ts";

describe("snapshot io", () => {
  it("refuses to overwrite a past day's raw snapshot", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-io-"));
    await writeJsonSnapshot("mcp-registry", "2026-10-14", "2026-10-14", { ok: true }, dataDir);
    expect(() => assertNotOverwritingPastRaw("mcp-registry", "2026-10-14", "2026-10-15", dataDir)).toThrow(
      /past snapshot/,
    );
  });

  it("gzips large payloads and allows same-day refresh", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-io-"));
    const large = { rows: Array.from({ length: 20_000 }, (_, index) => ({ index, name: "x".repeat(20) })) };
    const path = await writeJsonSnapshot("smithery", "2026-10-15", "2026-10-15", large, dataDir);
    expect(path.endsWith(".json.gz")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(large)) >= RAW_GZIP_THRESHOLD_BYTES).toBe(true);
    const parsed = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as { rows: unknown[] };
    expect(parsed.rows).toHaveLength(20_000);

    const refreshed = await writeJsonSnapshot("smithery", "2026-10-15", "2026-10-15", { ok: true }, dataDir);
    expect(refreshed.endsWith(".json")).toBe(true);
    expect(existingRawPath("smithery", "2026-10-15", dataDir)).toBe(refreshed);
  });

  it("refuses zero-size atomic writes and cleans broken date placeholders", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-io-broken-"));
    expect(() => writeFileAtomic(join(dataDir, "empty.json"), "")).toThrow(/zero-size/);
    mkdirSync(join(dataDir, "normalized"), { recursive: true });
    writeFileSync(join(dataDir, "normalized", "2026-10-19"), "");
    mkdirSync(join(dataDir, "normalized", "2026-10-18"), { recursive: true });
    const removed = cleanupBrokenNormalizedEntries(dataDir);
    expect(removed).toContain("2026-10-19");
    expect(existsSync(join(dataDir, "normalized", "2026-10-19"))).toBe(false);
    expect(inspectSnapshot("2026-10-18", dataDir).usable).toBe(false);
  });

  it("does not delete a usable snapshot when cleaning broken entries", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "radar-io-keep-"));
    writeNormalized(
      "2026-10-20",
      [],
      [],
      {
        snapshotDate: "2026-10-20",
        collectedAt: "2026-10-20T00:00:00Z",
        appCount: 0,
        sourceRowCount: 0,
        sources: [],
      },
      dataDir,
    );
    expect(cleanupBrokenNormalizedEntries(dataDir)).toEqual([]);
    expect(inspectSnapshot("2026-10-20", dataDir).usable).toBe(true);
  });
});
