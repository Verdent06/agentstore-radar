import Link from "next/link";
import { Shell } from "@/components/shell";
import { formatCount } from "@/lib/format";
import { categorySummaries } from "@/lib/query";
import { loadAggregate } from "@/lib/store";

export const metadata = {
  title: "Categories",
  description: "Keyword heuristic categories from names and descriptions — no embeddings.",
};

export default function CategoriesPage() {
  const agg = loadAggregate();
  const rows = categorySummaries(agg);
  return (
    <Shell>
      <h1 className="text-3xl font-semibold tracking-tight">Categories</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Embedding-free classifier: scored keyword rules over name + description. Transparent and stable enough for leaderboards.
      </p>
      <div className="mt-6 grid gap-3 md:grid-cols-3">
        {rows.map((row) => (
          <Link key={row.slug} href={`/categories/${row.slug}`} className="surface rounded-lg px-4 py-3 hover:border-accent">
            <div className="font-medium">{row.label}</div>
            <div className="mt-1 font-mono text-xs text-muted">
              {row.appCount} apps · {formatCount(row.useCount)} use · {row.newThisSnapshot} new
            </div>
          </Link>
        ))}
      </div>
    </Shell>
  );
}
