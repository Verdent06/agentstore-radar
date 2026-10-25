import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { LeaderTable } from "@/components/table";
import { CHART_IDS, CHART_META } from "@/lib/types";
import { PUBLIC_TOP_N, isChartId, sparkValues, topChart } from "@/lib/query";
import { loadAggregate } from "@/lib/store";

export function generateStaticParams() {
  return CHART_IDS.map((chart) => ({ chart }));
}

export async function generateMetadata({ params }: { params: Promise<{ chart: string }> }) {
  const { chart } = await params;
  const meta = isChartId(chart) ? CHART_META[chart] : null;
  return {
    title: meta?.title ?? "Chart",
    description: meta?.blurb,
    openGraph: { title: meta?.title, description: meta?.blurb },
  };
}

export default async function ChartPage({ params }: { params: Promise<{ chart: string }> }) {
  const { chart } = await params;
  if (!isChartId(chart)) notFound();
  const agg = loadAggregate();
  const spec = CHART_META[chart];
  const rows = topChart(agg, chart, PUBLIC_TOP_N);
  const sparks = new Map(rows.map((row) => [row.app.id, sparkValues(agg, row.app.id, spec.metric)]));

  return (
    <Shell>
      <p className="text-xs uppercase tracking-[0.2em] text-muted">Leaderboard</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">{spec.title}</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">{spec.blurb}</p>
      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        {CHART_IDS.map((id) => (
          <Link
            key={id}
            href={`/charts/${id}`}
            className={`rounded-md border px-3 py-1 ${id === chart ? "border-accent text-ink" : "border-line text-muted hover:text-ink"}`}
          >
            {CHART_META[id].title}
          </Link>
        ))}
      </div>
      <div className="mt-6">
        <LeaderTable rows={rows} valueLabel={spec.unit} sparks={sparks} />
      </div>
    </Shell>
  );
}
