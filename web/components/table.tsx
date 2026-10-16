import Link from "next/link";
import { formatNumber, formatSigned, rankDelta } from "@/lib/format";
import { appHref } from "@/lib/store";
import { STORE_LABELS, type AppSummary, type RankedApp } from "@/lib/types";
import { Sparkline } from "./sparkline";

export function StorePills({ stores }: { stores: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {stores.map((store) => (
        <span key={store} className="rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          {STORE_LABELS[store] ?? store}
        </span>
      ))}
    </div>
  );
}

export function Delta({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-muted">—</span>;
  const cls = value > 0 ? "rank-up" : value < 0 ? "rank-down" : "text-muted";
  return <span className={`tabular font-mono text-xs ${cls}`}>{formatSigned(value)}</span>;
}

export function LeaderTable({
  rows,
  valueLabel,
  sparks,
}: {
  rows: RankedApp[];
  valueLabel: string;
  sparks?: Map<string, Array<number | null>>;
}) {
  return (
    <div className="surface overflow-hidden rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-[color:var(--bg-row)] text-[11px] uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 text-left font-medium">#</th>
            <th className="px-3 py-2 text-left font-medium">App</th>
            <th className="px-3 py-2 text-right font-medium">{valueLabel}</th>
            <th className="px-3 py-2 text-right font-medium">Δ</th>
            <th className="hidden px-3 py-2 text-right font-medium md:table-cell">Trend</th>
            <th className="hidden px-3 py-2 text-left font-medium lg:table-cell">Stores</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const move = rankDelta(row.rank, row.previousRank);
            return (
              <tr key={row.app.id} className="border-t border-line hover:bg-[color:var(--bg-row)]">
                <td className="px-3 py-2 font-mono text-xs text-muted">
                  {row.rank}
                  {move != null && move !== 0 ? (
                    <span className={`ml-1 ${move > 0 ? "rank-up" : "rank-down"}`}>{move > 0 ? `▲${move}` : `▼${Math.abs(move)}`}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <Link href={appHref(row.app.id)} className="font-medium hover:text-accent">
                    {row.app.displayName}
                  </Link>
                  <div className="max-w-md truncate text-xs text-muted">{row.app.description}</div>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular">{formatNumber(row.value)}</td>
                <td className="px-3 py-2 text-right">
                  <Delta value={row.delta} />
                </td>
                <td className="hidden px-3 py-2 text-right md:table-cell">
                  <Sparkline values={sparks?.get(row.app.id) ?? []} />
                </td>
                <td className="hidden px-3 py-2 lg:table-cell">
                  <StorePills stores={row.app.stores} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AppTable({
  apps,
  extra,
}: {
  apps: AppSummary[];
  extra?: (app: AppSummary) => React.ReactNode;
}) {
  return (
    <div className="surface overflow-hidden rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-[color:var(--bg-row)] text-[11px] uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 text-left font-medium">App</th>
            <th className="px-3 py-2 text-left font-medium">Category</th>
            <th className="px-3 py-2 text-right font-medium">Use</th>
            <th className="px-3 py-2 text-right font-medium">Stars</th>
            <th className="hidden px-3 py-2 text-left font-medium md:table-cell">Stores</th>
            {extra ? <th className="px-3 py-2 text-right font-medium" /> : null}
          </tr>
        </thead>
        <tbody>
          {apps.map((app) => (
            <tr key={app.id} className="border-t border-line hover:bg-[color:var(--bg-row)]">
              <td className="px-3 py-2">
                <Link href={appHref(app.id)} className="font-medium hover:text-accent">
                  {app.displayName}
                </Link>
                <div className="max-w-xl truncate text-xs text-muted">{app.description}</div>
              </td>
              <td className="px-3 py-2 text-xs text-muted">{app.category}</td>
              <td className="px-3 py-2 text-right font-mono tabular">{formatNumber(app.useCount)}</td>
              <td className="px-3 py-2 text-right font-mono tabular">{formatNumber(app.stars)}</td>
              <td className="hidden px-3 py-2 md:table-cell">
                <StorePills stores={app.stores} />
              </td>
              {extra ? <td className="px-3 py-2 text-right text-xs text-muted">{extra(app)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
