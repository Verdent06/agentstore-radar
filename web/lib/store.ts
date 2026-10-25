import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Aggregate } from "./types";

const CANDIDATES = [
  process.env.AGGREGATE_PATH,
  join(process.cwd(), "data/radar.json"),
  join(process.cwd(), "web/data/radar.json"),
  join(process.cwd(), "../web/data/radar.json"),
].filter((path): path is string => Boolean(path));

let cached: Aggregate | null = null;

export function loadAggregate(): Aggregate {
  if (cached) return cached;
  const path = CANDIDATES.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error(
      "Missing web/data/radar.json. Run `npm run aggregate` from the repo root (DATA_DIR or DATA_GITHUB_TOKEN), or `npm run aggregate:fixture` for local/CI demo data.",
    );
  }
  cached = JSON.parse(readFileSync(path, "utf8")) as Aggregate;
  return cached;
}

export function appHref(id: string): string {
  return `/apps/${encodeURIComponent(id)}`;
}
