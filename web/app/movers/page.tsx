import Link from "next/link";
import { Shell } from "@/components/shell";
import { Delta } from "@/components/table";
import { formatCount, formatDate } from "@/lib/format";
import { MOVERS_PER_SIDE, movers } from "@/lib/query";
import { appHref, loadAggregate } from "@/lib/store";
import { METRIC_LABELS, type MetricKey } from "@/lib/types";

export const metadata = {
  title: "Weekly movers",
  description: "Screenshot-ready weekly gainers and losers across agent stores.",
};

function Column({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ id: string; name: string; delta: number; current: number; previous: number; growth: string | null }>;
}) {
  return (
    <div className="surface rounded-xl p-5">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">{title}</h2>
      <ol className="mt-3 space-y-2">
        {rows.map((row, index) => (
          <li key={row.id} className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-baseline gap-3">
              <span className="w-5 font-mono text-xs text-muted">{index + 1}</span>
              <Link href={appHref(row.id)} className="truncate font-medium hover:text-accent">
                {row.name}
              </Link>
            </span>
            <span className="flex items-baseline gap-3 font-mono text-sm">
              <Delta value={row.delta} />
              <span className="text-xs text-muted">{row.growth ?? "—"}</span>
              <span className="hidden text-xs text-muted sm:inline">
                {formatCount(row.previous)}→{formatCount(row.current)}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default async function MoversPage({ searchParams }: { searchParams: Promise<{ shot?: string }> }) {
  const agg = loadAggregate();
  const { shot: shotFlag } = await searchParams;
  const shot = shotFlag === "1";
  const use = movers(agg, { window: "7d", metric: "use_count", limit: MOVERS_PER_SIDE });
  const stars = movers(agg, { window: "7d", metric: "stars", limit: MOVERS_PER_SIDE });
  const split = (rows: typeof use) => ({
    up: [...rows].filter((row) => row.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, MOVERS_PER_SIDE),
    down: [...rows].filter((row) => row.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, MOVERS_PER_SIDE),
  });
  const useSplit = split(use);
  const starSplit = split(stars);

  return (
    <Shell shot={shot}>
      <div className="surface rounded-2xl p-6 md:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-accent">Weekly movers</p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight">AgentStore Radar</h1>
            <p className="mt-2 text-sm text-muted">
              {formatDate(agg.meta.weekAgoDate)} → {formatDate(agg.meta.latestDate)}
              {agg.meta.origin === "fixture" ? " · demo data" : ""}
            </p>
          </div>
          {!shot ? (
            <Link href="/movers?shot=1" className="text-xs text-muted hover:text-ink">
              Screenshot layout
            </Link>
          ) : null}
        </div>

        <div className="mt-8 grid gap-5 md:grid-cols-2">
          <Column title={`${METRIC_LABELS.use_count as string} · gainers`} rows={useSplit.up} />
          <Column title={`${METRIC_LABELS.use_count as string} · losers`} rows={useSplit.down} />
          <Column title={`${METRIC_LABELS.stars} · gainers`} rows={starSplit.up} />
          <Column title={`${METRIC_LABELS.stars} · losers`} rows={starSplit.down} />
        </div>

        <p className="mt-6 text-xs text-muted">
          Absolute change over the weekly window. Public aggregates only — not a bulk history dump.{" "}
          {(Object.keys(METRIC_LABELS) as MetricKey[]).length} tracked metrics.
        </p>
      </div>
    </Shell>
  );
}
