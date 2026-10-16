import { collectAnswerShare, printAnswerShareReport } from "./commands/answer-share.ts";
import { collect } from "./commands/collect.ts";
import { runHealth } from "./commands/health.ts";
import { printReport } from "./commands/report.ts";
import { isValidDateString } from "./lib/dates.ts";
import { resolveDataDir } from "./lib/io.ts";

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
  npm run collect -- [--date YYYY-MM-DD] [--data DIR] [--sources a,b] [--max-pages N]
  npm run report -- [--date YYYY-MM-DD] [--data DIR] [--limit N]
  npm run health -- [--date YYYY-MM-DD] [--data DIR]
  npm run answer-share -- [--date YYYY-MM-DD] [--data DIR] [--providers a,b] [--n 3] [--max-calls N] [--prompt-version v1]
  npm run answer-share:report -- [--date YYYY-MM-DD] [--data DIR] [--limit N]

Data directory: --data, else $DATA_DIR, else ./data (gitignored; history lives in the private data repo).

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
  const dataDir = resolveDataDir(argValue(args, "--data"));
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
  if (command === "answer-share") {
    const providers = argValue(args, "--providers")?.split(",").filter(Boolean);
    const nRaw = argValue(args, "--n");
    const maxCallsRaw = argValue(args, "--max-calls");
    const manifest = await collectAnswerShare({
      date,
      dataDir,
      providers,
      n: nRaw ? Number(nRaw) : undefined,
      maxCalls: maxCallsRaw ? Number(maxCallsRaw) : undefined,
      promptVersion: argValue(args, "--prompt-version"),
    });
    console.log(JSON.stringify(manifest, null, 2));
    return 0;
  }
  if (command === "answer-share-report") {
    const limit = Number(argValue(args, "--limit") ?? "10");
    printAnswerShareReport({ date, dataDir, limit });
    return 0;
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
