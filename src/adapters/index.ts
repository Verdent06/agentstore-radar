import type { SourceAdapter } from "./types.ts";
import { geminiAdapter } from "./gemini.ts";
import { githubAdapter } from "./github.ts";
import { mcpRegistryAdapter } from "./mcp-registry.ts";
import { npmAdapter } from "./npm.ts";
import { pypiAdapter } from "./pypi.ts";
import { smitheryAdapter } from "./smithery.ts";

export const adapters: SourceAdapter[] = [
  mcpRegistryAdapter,
  smitheryAdapter,
  geminiAdapter,
  githubAdapter,
  npmAdapter,
  pypiAdapter,
];

export function adaptersByKind(kind: SourceAdapter["kind"]): SourceAdapter[] {
  return adapters.filter((adapter) => adapter.kind === kind);
}

export function adapterByName(name: string): SourceAdapter | undefined {
  return adapters.find((adapter) => adapter.name === name);
}
