import { Shell } from "@/components/shell";
import { AppTable } from "@/components/table";
import { searchApps } from "@/lib/query";
import { loadAggregate } from "@/lib/store";

export const metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const agg = loadAggregate();
  const apps = searchApps(agg, q, 50);
  return (
    <Shell>
      <h1 className="text-3xl font-semibold tracking-tight">Search</h1>
      <form action="/search" className="mt-4 max-w-xl">
        <input
          name="q"
          defaultValue={q}
          placeholder="Name, description, or app id"
          className="w-full rounded-md border border-line bg-elev px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </form>
      <p className="mb-4 mt-3 text-xs text-muted">
        {q ? `${apps.length} matches for “${q}”` : "Type a query. Results are capped; this is not a bulk export."}
      </p>
      <AppTable apps={apps} />
    </Shell>
  );
}
