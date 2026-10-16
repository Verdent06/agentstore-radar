import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Aggregate } from "../../src/aggregate/types.ts";

const here = dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  process.env.AGGREGATE_PATH,
  join(here, "../data/radar.json"),
  join(here, "../../web/data/radar.json"),
  join(process.cwd(), "mcp/data/radar.json"),
  join(process.cwd(), "web/data/radar.json"),
  join(process.cwd(), "data/radar.json"),
].filter((path): path is string => Boolean(path));

let cached: Aggregate | null = null;

export function loadAggregate(): Aggregate {
  if (cached) {
    return cached;
  }
  const path = CANDIDATES.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error(
      `No radar.json aggregate found. Run \`npm run aggregate\` or set AGGREGATE_PATH. Looked in: ${CANDIDATES.join(", ")}`,
    );
  }
  cached = JSON.parse(readFileSync(path, "utf8")) as Aggregate;
  return cached;
}
