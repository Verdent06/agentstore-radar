import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RAW_GZIP_THRESHOLD_BYTES } from "../src/lib/config.ts";
import { assertNotOverwritingPastRaw, existingRawPath, writeJsonSnapshot } from "../src/lib/io.ts";

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
});
