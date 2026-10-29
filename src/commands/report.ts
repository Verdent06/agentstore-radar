import { formatCoveragePct } from "../lib/coverage.ts";
import { listSnapshotDates, previousSnapshotDate, readApps, readManifest, resolveDataDir } from "../lib/io.ts";
import { sourceFreshWithin7dCount, type AppRow, type SnapshotManifest } from "../lib/schema.ts";

export type Mover = {
  app_id: string;
  name: string;
  metric: string;
  previous: number;
  current: number;
  delta: number;
};

export type ReportResult = {
  from?: string;
  to?: string;
  movers: Mover[];
  leaders: Array<{ metric: string; rows: AppRow[] }>;
  coverage?: Array<{
    source: string;
    coverage?: number;
    eligibleCount?: number;
    freshTodayCount?: number;
    freshWithin7dCount?: number;
    fetchedThisRunCount?: number;
    skipped: boolean;
  }>;
};

const METRICS = [
  { key: "stars", label: "stars" },
  { key: "use_count", label: "use_count" },
  { key: "npm_weekly_downloads", label: "npm_weekly_downloads" },
  { key: "pypi_last_week_downloads", label: "pypi_last_week_downloads" },
  { key: "forks", label: "forks" },
] as const;

type MetricKey = (typeof METRICS)[number]["key"];

function metricValue(row: AppRow, key: MetricKey): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}

export function computeMovers(previous: AppRow[], current: AppRow[], limit = 10): Mover[] {
  const prevById = new Map(previous.map((row) => [row.app_id, row]));
  const movers: Mover[] = [];
  for (const metric of METRICS) {
    const scored: Mover[] = [];
    for (const row of current) {
      const prior = prevById.get(row.app_id);
      if (!prior) {
        continue;
      }
      const currentValue = metricValue(row, metric.key);
      const previousValue = metricValue(prior, metric.key);
      if (currentValue == null || previousValue == null) {
        continue;
      }
      const delta = currentValue - previousValue;
      if (delta === 0) {
        continue;
      }
      scored.push({
        app_id: row.app_id,
        name: row.display_name ?? row.name,
        metric: metric.label,
        previous: previousValue,
        current: currentValue,
        delta,
      });
    }
    scored.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    movers.push(...scored.slice(0, limit));
  }
  return movers;
}

export function computeLeaders(current: AppRow[], limit = 10): Array<{ metric: string; rows: AppRow[] }> {
  return METRICS.map((metric) => {
    const rows = current
      .filter((row) => metricValue(row, metric.key) != null)
      .sort((a, b) => (metricValue(b, metric.key) ?? 0) - (metricValue(a, metric.key) ?? 0))
      .slice(0, limit);
    return { metric: metric.label, rows };
  }).filter((group) => group.rows.length > 0);
}

export function buildReport(options?: { date?: string; dataDir?: string; limit?: number }): ReportResult {
  const dataDir = resolveDataDir(options?.dataDir);
  const dates = listSnapshotDates(dataDir);
  const currentDate = options?.date ?? dates.at(-1);
  if (!currentDate) {
    return { movers: [], leaders: [] };
  }
  const previousDate = previousSnapshotDate(currentDate, dataDir);
  const current = readApps(currentDate, dataDir);
  const leaders = computeLeaders(current, options?.limit ?? 10);
  const coverage = coverageFromManifest(readManifest(currentDate, dataDir));
  if (!previousDate) {
    return { to: currentDate, movers: [], leaders, coverage };
  }
  const previous = readApps(previousDate, dataDir);
  return {
    from: previousDate,
    to: currentDate,
    movers: computeMovers(previous, current, options?.limit ?? 10),
    leaders,
    coverage,
  };
}

export function coverageFromManifest(manifest: SnapshotManifest): ReportResult["coverage"] {
  return manifest.sources.map((source) => ({
    source: source.source,
    coverage: source.coverage,
    eligibleCount: source.eligibleCount,
    freshTodayCount: source.freshTodayCount,
    freshWithin7dCount: sourceFreshWithin7dCount(source),
    fetchedThisRunCount: source.fetchedThisRunCount,
    skipped: source.skipped,
  }));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatReport(report: ReportResult): string {
  const lines: string[] = [];
  if (!report.to) {
    return "No snapshots yet. Run `npm run collect` first.";
  }
  if (!report.from) {
    lines.push(`First snapshot ${report.to}. Day-over-day movers need two dates.`);
    lines.push("");
  } else {
    lines.push(`Top movers ${report.from} → ${report.to}`);
    lines.push("");
    const byMetric = new Map<string, Mover[]>();
    for (const mover of report.movers) {
      const list = byMetric.get(mover.metric) ?? [];
      list.push(mover);
      byMetric.set(mover.metric, list);
    }
    if (byMetric.size === 0) {
      lines.push("No numeric day-over-day changes yet.");
      lines.push("");
    } else {
      for (const [metric, movers] of byMetric) {
        lines.push(`## ${metric}`);
        for (const mover of movers) {
          const signed = `${mover.delta > 0 ? "+" : ""}${formatNumber(mover.delta)}`;
          lines.push(
            `  ${signed.padStart(10)}  ${mover.name}  (${formatNumber(mover.previous)} → ${formatNumber(mover.current)})  ${mover.app_id}`,
          );
        }
        lines.push("");
      }
    }
  }
  if (report.coverage && report.coverage.length > 0) {
    lines.push("Source coverage");
    for (const source of report.coverage) {
      const window =
        source.eligibleCount != null
          ? `  ${source.freshTodayCount ?? source.freshWithin7dCount ?? 0}/${source.eligibleCount} fresh today`
          : "";
      const thisRun = source.fetchedThisRunCount != null ? `  ${source.fetchedThisRunCount} this run` : "";
      const skipped = source.skipped ? "  (skipped)" : "";
      lines.push(`  ${source.source.padEnd(16)} ${formatCoveragePct(source.coverage)}${window}${thisRun}${skipped}`);
    }
    lines.push("");
  }
  lines.push(`Current leaders (${report.to})`);
  for (const group of report.leaders) {
    lines.push(`## ${group.metric}`);
    for (const [index, row] of group.rows.entries()) {
      const value = row[group.metric as MetricKey];
      lines.push(`  ${String(index + 1).padStart(2)}. ${formatNumber(Number(value)).padStart(10)}  ${row.display_name ?? row.name}  ${row.app_id}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function printReport(options?: { date?: string; dataDir?: string; limit?: number }): string {
  const text = formatReport(buildReport(options));
  console.log(text);
  return text;
}
