import { collect } from "./commands/collect.ts";
import { runHealth } from "./commands/health.ts";
import { printReport } from "./commands/report.ts";
import { isValidDateString } from "./lib/dates.ts";

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function usage(): string {
  return `agentstore-radar

Usage:
  npm run collect -- [--date YYYY-MM-DD] [--data data] [--sources a,b] [--max-pages N]
  npm run report -- [--date YYYY-MM-DD] [--data data] [--limit N]
  npm run health -- [--date YYYY-MM-DD] [--data data]

Commands can also be invoked as: npx tsx src/cli.ts <command>
`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "help") {
    console.log(usage());
    return 0;
  }
  const date = argValue(args, "--date");
  if (date && !isValidDateString(date)) {
    console.error(`Invalid --date ${date}`);
    return 1;
  }
  const dataDir = argValue(args, "--data") ?? "data";
  if (command === "collect") {
    const sources = argValue(args, "--sources")?.split(",").filter(Boolean);
    const maxPagesRaw = argValue(args, "--max-pages");
    const manifest = await collect({
      date,
      dataDir,
      sources,
      maxPages: maxPagesRaw ? Number(maxPagesRaw) : undefined,
    });
    console.log(JSON.stringify(manifest, null, 2));
    return 0;
  }
  if (command === "report") {
    const limit = Number(argValue(args, "--limit") ?? "10");
    printReport({ date, dataDir, limit });
    return 0;
  }
  if (command === "health") {
    const report = await runHealth({ date, dataDir });
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  if (flag(args, "--help")) {
    console.log(usage());
    return 0;
  }
  console.error(`Unknown command: ${command}`);
  console.error(usage());
  return 1;
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry?.endsWith("/src/cli.ts") || entry?.endsWith("/dist/cli.js")) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
