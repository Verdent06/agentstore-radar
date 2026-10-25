import Link from "next/link";
import { Shell } from "@/components/shell";
import { formatCount, formatDate, formatPct } from "@/lib/format";
import { findApp } from "@/lib/query";
import { appHref, loadAggregate } from "@/lib/store";
import type { Aggregate, AnswerShareRowPublic } from "@/lib/types";

export const metadata = {
  title: "Answer share",
  description: "Which apps frontier assistants recommend, from the weekly official-API probe.",
};

function ShareTable({ rows, agg }: { rows: AnswerShareRowPublic[]; agg: Aggregate }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted">No rows for this slice.</p>;
  }
  return (
    <div className="surface overflow-hidden rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-[color:var(--bg-row)] text-[11px] uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 text-left font-medium">#</th>
            <th className="px-3 py-2 text-left font-medium">Name</th>
            <th className="px-3 py-2 text-right font-medium">Share</th>
            <th className="px-3 py-2 text-right font-medium">Mentions</th>
            <th className="hidden px-3 py-2 text-right font-medium md:table-cell">Run share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.appId ?? row.name}-${index}`} className="border-t border-line">
              <td className="px-3 py-2 font-mono text-xs text-muted">{index + 1}</td>
              <td className="px-3 py-2">
                {row.appId && findApp(agg, row.appId) ? (
                  <Link href={appHref(row.appId)} className="font-medium hover:text-accent">
                    {row.name}
                  </Link>
                ) : (
                  <span>
                    {row.name} {row.appId ? <span className="text-xs text-muted">(not in public top 10)</span> : <span className="text-xs text-muted">(unmatched)</span>}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular">{formatPct(row.answerShare)}</td>
              <td className="px-3 py-2 text-right font-mono tabular">{formatCount(row.mentionCount)}</td>
              <td className="hidden px-3 py-2 text-right font-mono tabular text-muted md:table-cell">{formatPct(row.runShare)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AnswerSharePage() {
  const agg = loadAggregate();
  const share = agg.answerShare;
  if (!share) {
    return (
      <Shell>
        <h1 className="text-3xl font-semibold tracking-tight">Answer share</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Weekly probe of which apps OpenAI, Anthropic, Gemini, and xAI recommend (official APIs + web search). No
          probe snapshot is in this aggregate yet — run <code className="font-mono">npm run answer-share</code> into the
          private data repo, then rebuild.
        </p>
        <div className="surface mt-6 rounded-lg px-4 py-8 text-sm text-muted">No answer-share shares.json found.</div>
      </Shell>
    );
  }

  const providers = Object.keys(share.byProvider).sort();
  return (
    <Shell>
      <p className="text-xs uppercase tracking-[0.2em] text-muted">Assistant recommendations</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Answer share</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Fraction of mentions in the latest weekly probe ({formatDate(share.probeDate)}, prompt {share.promptVersion}).
        Raw responses stay private.
      </p>
      <p className="mt-2 text-xs text-muted">
        Mean pairwise Jaccard {share.meanJaccard == null ? "—" : share.meanJaccard.toFixed(2)}
      </p>
      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">Overall</h2>
        <ShareTable rows={share.overall} agg={agg} />
      </section>
      {providers.map((provider) => (
        <section key={provider} className="mt-8">
          <h2 className="mb-3 text-lg font-semibold capitalize">{provider}</h2>
          <ShareTable rows={share.byProvider[provider] ?? []} agg={agg} />
        </section>
      ))}
    </Shell>
  );
}
