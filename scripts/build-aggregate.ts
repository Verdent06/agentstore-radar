import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAggregate } from "../src/aggregate/build.ts";
import { resolveSnapshotRoot } from "../src/aggregate/load.ts";
import { writeAggregateFiles } from "../src/aggregate/write.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export async function buildPublicAggregate(argv = process.argv.slice(2)): Promise<void> {
  const dataDirFlag = argValue(argv, "--data");
  const outFlag = argValue(argv, "--out");
  const resolved = await resolveSnapshotRoot({ dataDir: dataDirFlag, allowFixture: !argv.includes("--require-private") });
  try {
    const agg = buildAggregate(resolved.dataDir, resolved.origin);
    const destinations = outFlag
      ? [resolve(outFlag)]
      : [join(root, "web", "data"), join(root, "mcp", "data")];
    for (const dest of destinations) {
      const written = writeAggregateFiles(agg, dest);
      const metaPath = join(dest, "meta.json");
      writeFileSync(
        metaPath,
        `${JSON.stringify(
          {
            builtAt: agg.meta.builtAt,
            origin: agg.meta.origin,
            latestDate: agg.meta.latestDate,
            snapshotCount: agg.meta.snapshotDates.length,
            appCount: agg.stats.appCount,
            json: written.json,
            sqlite: written.sqlite,
          },
          null,
          2,
        )}\n`,
      );
      console.log(`Wrote aggregate (${agg.meta.origin}, ${agg.stats.appCount} apps) → ${dest}`);
    }
    mkdirSync(join(root, "aggregate"), { recursive: true });
    writeFileSync(
      join(root, "aggregate", "README.md"),
      `# Generated aggregates\n\nThis directory is a convenience copy target. Canonical files live in \`web/data\` and \`mcp/data\`.\nThey contain **chosen public summaries only** — never raw \`apps.ndjson\` / \`source_rows.ndjson\` history.\n`,
    );
  } finally {
    resolved.cleanup?.();
  }
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry?.endsWith("/scripts/build-aggregate.ts")) {
  buildPublicAggregate().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
