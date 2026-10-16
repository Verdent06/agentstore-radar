import { Shell } from "@/components/shell";
import { AppTable } from "@/components/table";
import { formatDate } from "@/lib/format";
import { newArrivals } from "@/lib/query";
import { loadAggregate } from "@/lib/store";

export const metadata = {
  title: "New arrivals",
  description: "Apps first seen in the latest snapshot.",
};

export default function NewPage() {
  const agg = loadAggregate();
  const apps = newArrivals(agg);
  return (
    <Shell>
      <h1 className="text-3xl font-semibold tracking-tight">New arrivals</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        First seen on {formatDate(agg.meta.latestDate)}. Earlier snapshots are required to tell “new” from “already tracked”.
      </p>
      <p className="mb-4 mt-3 text-xs text-muted">{apps.length} apps</p>
      <AppTable apps={apps} extra={(app) => app.firstSeen} />
    </Shell>
  );
}
