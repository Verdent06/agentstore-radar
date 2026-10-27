import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.ts";
import { answerSharePaths } from "../src/answer-share/io.ts";

const PROVIDER_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("answer-share CLI", () => {
  it("exits 1 when zero providers succeed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "answer-share-cli-none-"));
    for (const key of PROVIDER_KEYS) {
      vi.stubEnv(key, "");
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["answer-share", "--data", dataDir, "--date", "2026-10-16"]);
    expect(code).toBe(1);
    const paths = answerSharePaths("2026-10-16", dataDir);
    expect(existsSync(paths.rawDir)).toBe(false);
    expect(existsSync(paths.manifestPath)).toBe(false);
  });
});
