/**
 * Backup gate for the 08:47 and 19:23 collects.
 * Writes skip=true to GITHUB_OUTPUT when the core sources are already complete.
 * `--if-incomplete` uses the same decision (`BACKUP_CORE_SOURCES`).
 */
import { isValidDateString } from "../src/lib/dates.ts";
import { publishIfIncompleteGate } from "../src/lib/backup-core.ts";

const dataDir = process.argv[2];
const date = process.argv[3];
if (!dataDir || !date || !isValidDateString(date)) {
  console.error("usage: if-incomplete-gate.ts <data-dir> <YYYY-MM-DD>");
  process.exit(2);
}

const decision = publishIfIncompleteGate(date, dataDir);
if (decision.proceed) {
  console.log(`backup will collect: ${decision.reason}`);
} else {
  console.log(`backup skipped: ${decision.reason}`);
}
