import { defineConfig } from "vitest/config";

/**
 * MCP tests live in src/*.test.ts. CI runs `npm test` in this workspace
 * (`vitest run`). `tsx --test` does not load this config, and a vitest
 * invocation without it walks up to the repo root and misses these files.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
  },
});
