import { formatCount, formatNumber } from "@/lib/format";

export function KpiGrid({
  items,
}: {
  items: Array<{ label: string; value: string; hint?: string }>;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="surface rounded-lg px-4 py-3 shadow-card">
          <div className="text-[11px] uppercase tracking-wide text-muted">{item.label}</div>
          <div className="mt-1 font-mono text-2xl tabular tracking-tight">{item.value}</div>
          {item.hint ? <div className="mt-1 text-xs text-muted">{item.hint}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function DemoBanner({
  origin,
  source,
  latestDate,
}: {
  origin: string;
  source?: string;
  latestDate: string | null;
}) {
  if (source !== "fixture" && origin !== "fixture") {
    return (
      <p className="text-xs text-muted">
        Snapshot {latestDate ?? "—"} · sourced from private history via build-time aggregate
      </p>
    );
  }
  return (
    <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
      Showing bundled demo snapshots. Point <code className="font-mono">DATA_DIR</code> or{" "}
      <code className="font-mono">DATA_GITHUB_TOKEN</code> at the private data repo to publish live charts.
    </div>
  );
}

export function formatKpis(stats: {
  appCount: number;
  storeCount: number;
  totalNpmWeekly: number;
  totalStars: number;
  multiStoreCount: number;
  newArrivalCount: number;
  snapshotCount: number;
  latestDate: string | null;
}) {
  return [
    { label: "Apps tracked", value: formatNumber(stats.appCount), hint: `${stats.snapshotCount} snapshots` },
    { label: "Stores", value: formatNumber(stats.storeCount), hint: stats.latestDate ?? "" },
    { label: "npm / week", value: formatCount(stats.totalNpmWeekly), hint: "sum of latest weekly downloads" },
    { label: "GitHub stars", value: formatCount(stats.totalStars), hint: `${stats.multiStoreCount} multi-store · ${stats.newArrivalCount} new` },
  ];
}
