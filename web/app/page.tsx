import Link from "next/link";
import { DemoBanner, KpiGrid, formatKpis } from "@/components/kpis";
import { Shell } from "@/components/shell";
import { LeaderTable } from "@/components/table";
import { formatDate } from "@/lib/format";
import { homeRows, newArrivals, sparkValues, topChart } from "@/lib/query";
import { loadAggregate } from "@/lib/store";

export const dynamic = "force-static";

export default function HomePage() {
  const agg = loadAggregate();
  const hasMovers = agg.meta.snapshotDates.length >= 2;
  const rows = homeRows(agg, 12);
  const sparks = new Map(rows.map((row) => [row.app.id, sparkValues(agg, row.app.id, "use_count")]));
  const arrivals = newArrivals(agg).slice(0, 5);
  const charts = [
    { href: "/charts/smithery", label: "Smithery", row: topChart(agg, "smithery", 1)[0] },
    { href: "/charts/npm", label: "npm", row: topChart(agg, "npm", 1)[0] },
    { href: "/charts/github", label: "GitHub", row: topChart(agg, "github", 1)[0] },
    { href: "/charts/gemini", label: "Gemini CLI", row: topChart(agg, "gemini", 1)[0] },
  ];

  return (
    <Shell>
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-muted">Cross-store intelligence</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Agent store leaderboards</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Daily snapshots of sanctioned public catalogs — MCP Registry, Smithery, npm, GitHub, Gemini CLI, PyPI.
            This site publishes chosen aggregates only.
          </p>
        </div>
        <DemoBanner origin={agg.meta.origin} latestDate={agg.meta.latestDate} />
      </div>

      <KpiGrid items={formatKpis(agg.stats)} />

      <div className="mt-8 grid gap-3 md:grid-cols-4">
        {charts.map((card) => (
          <Link key={card.href} href={card.href} className="surface rounded-lg px-4 py-3 hover:border-accent">
            <div className="text-[11px] uppercase tracking-wide text-muted">{card.label}</div>
            <div className="mt-1 truncate font-medium">{card.row?.app.displayName ?? "—"}</div>
            <div className="font-mono text-xs text-muted">{card.row ? `#1 · ${card.row.value.toLocaleString()}` : "No rows"}</div>
          </Link>
        ))}
      </div>

      <section className="mt-10">
        <div className="mb-3 flex items-end justify-between">
          <div>
            <h2 className="text-lg font-semibold">{hasMovers ? "Top movers (use count)" : "Top by Smithery use count"}</h2>
            <p className="text-sm text-muted">
              {hasMovers
                ? `${formatDate(agg.meta.previousDate)} → ${formatDate(agg.meta.latestDate)}`
                : "Need two snapshot days before movers appear."}
            </p>
          </div>
          <Link href="/movers" className="text-sm text-accent hover:underline">
            Weekly card
          </Link>
        </div>
        <LeaderTable rows={rows} valueLabel={hasMovers ? "Current" : "Use count"} sparks={sparks} />
      </section>

      {agg.answerShare ? (
        <section className="mt-10">
          <div className="mb-3 flex items-end justify-between">
            <div>
              <h2 className="text-lg font-semibold">Answer share</h2>
              <p className="text-sm text-muted">Latest assistant-recommendation probe · {agg.answerShare.probeDate}</p>
            </div>
            <Link href="/answer-share" className="text-sm text-accent hover:underline">
              Full table
            </Link>
          </div>
          <div className="surface overflow-hidden rounded-lg">
            <table className="w-full text-sm">
              <tbody>
                {agg.answerShare.overall.slice(0, 5).map((row, index) => (
                  <tr key={`${row.appId ?? row.name}-${index}`} className="border-t border-line first:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-muted">{index + 1}</td>
                    <td className="px-3 py-2 font-medium">{row.name}</td>
                    <td className="px-3 py-2 text-right font-mono tabular">{(row.answerShare * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Answer share</h2>
          <p className="mt-2 text-sm text-muted">
            No weekly assistant probe in this aggregate yet. The page stays empty until{" "}
            <code className="font-mono">normalized/answer-share/&lt;date&gt;/shares.json</code> exists.
          </p>
        </section>
      )}

      {arrivals.length > 0 ? (
        <section className="mt-10">
          <div className="mb-3 flex items-end justify-between">
            <h2 className="text-lg font-semibold">New this snapshot</h2>
            <Link href="/new" className="text-sm text-accent hover:underline">
              All arrivals
            </Link>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {arrivals.map((app) => (
              <Link key={app.id} href={`/apps/${encodeURIComponent(app.id)}`} className="surface rounded-lg px-4 py-3 hover:border-accent">
                <div className="font-medium">{app.displayName}</div>
                <div className="text-xs text-muted">{app.description}</div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </Shell>
  );
}
