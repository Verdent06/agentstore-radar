import Link from "next/link";
import { notFound } from "next/navigation";
import { LineChart } from "@/components/sparkline";
import { Shell } from "@/components/shell";
import { Delta, StorePills } from "@/components/table";
import { formatDate, formatNumber } from "@/lib/format";
import { findApp, seriesToPoints } from "@/lib/query";
import { loadAggregate } from "@/lib/store";
import { CATEGORY_LABELS } from "@/lib/types";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agg = loadAggregate();
  const app = findApp(agg, id);
  return {
    title: app?.displayName ?? "App",
    description: app?.description ?? "Per-app public summary",
  };
}

export default async function AppPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agg = loadAggregate();
  const app = findApp(agg, id);
  if (!app) notFound();
  const history = seriesToPoints(agg, app.id);
  const similar = agg.apps
    .filter((other) => other.id !== app.id && other.category === app.category)
    .sort((a, b) => (b.useCount ?? -1) - (a.useCount ?? -1))
    .slice(0, 6);

  return (
    <Shell>
      <p className="text-xs uppercase tracking-[0.2em] text-muted">{app.id}</p>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{app.displayName}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">{app.description}</p>
        </div>
        <StorePills stores={app.stores} />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ["Use count", app.useCount],
          ["Stars", app.stars],
          ["npm / week", app.npmWeeklyDownloads],
          ["PyPI / week", app.pypiLastWeekDownloads],
          ["Gemini stars", app.geminiStars],
        ].map(([label, value]) => (
          <div key={String(label)} className="surface rounded-lg px-3 py-2">
            <div className="text-[11px] uppercase text-muted">{label}</div>
            <div className="font-mono text-lg tabular">{formatNumber(value as number | null)}</div>
          </div>
        ))}
      </div>

      <section className="surface mt-8 rounded-lg p-4">
        <h2 className="text-sm font-medium">History</h2>
        <LineChart
          labels={history.map((point) => point.date)}
          series={[
            { name: "use", color: "var(--accent)", values: history.map((point) => point.useCount) },
            { name: "stars", color: "var(--up)", values: history.map((point) => point.stars) },
            { name: "npm", color: "var(--warn)", values: history.map((point) => point.npmWeeklyDownloads) },
          ]}
        />
        <table className="mt-4 w-full text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 text-left font-medium">Date</th>
              <th className="py-1 text-right font-medium">Use</th>
              <th className="py-1 text-right font-medium">Stars</th>
              <th className="py-1 text-right font-medium">npm</th>
              <th className="py-1 text-right font-medium">Gemini</th>
            </tr>
          </thead>
          <tbody>
            {history.map((point, index) => {
              const prev = history[index - 1];
              return (
                <tr key={point.date} className="border-t border-line">
                  <td className="py-1">{formatDate(point.date)}</td>
                  <td className="py-1 text-right font-mono">
                    {formatNumber(point.useCount)} <Delta value={prev && point.useCount != null && prev.useCount != null ? point.useCount - prev.useCount : null} />
                  </td>
                  <td className="py-1 text-right font-mono">{formatNumber(point.stars)}</td>
                  <td className="py-1 text-right font-mono">{formatNumber(point.npmWeeklyDownloads)}</td>
                  <td className="py-1 text-right font-mono">{formatNumber(point.geminiStars)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <dl className="mt-6 grid gap-2 text-sm md:grid-cols-2">
        <div>
          <dt className="text-muted">Category</dt>
          <dd>
            <Link className="text-accent hover:underline" href={`/categories/${app.category}`}>
              {CATEGORY_LABELS[app.category]}
            </Link>
          </dd>
        </div>
        <div>
          <dt className="text-muted">First / last seen</dt>
          <dd>
            {formatDate(app.firstSeen)} → {formatDate(app.lastSeen)}
          </dd>
        </div>
        {app.repoUrl ? (
          <div>
            <dt className="text-muted">Repository</dt>
            <dd>
              <a className="text-accent hover:underline" href={app.repoUrl}>
                {app.repoUrl}
              </a>
            </dd>
          </div>
        ) : null}
        {app.homepage ? (
          <div>
            <dt className="text-muted">Homepage</dt>
            <dd>
              <a className="text-accent hover:underline" href={app.homepage}>
                {app.homepage}
              </a>
            </dd>
          </div>
        ) : null}
      </dl>

      {similar.length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">Same category</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {similar.map((other) => (
              <Link key={other.id} href={`/apps/${encodeURIComponent(other.id)}`} className="surface rounded-lg px-4 py-3 hover:border-accent">
                <div className="font-medium">{other.displayName}</div>
                <div className="text-xs text-muted">{other.description}</div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </Shell>
  );
}
