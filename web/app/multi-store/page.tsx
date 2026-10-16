import { Shell } from "@/components/shell";
import { AppTable } from "@/components/table";
import { multiStoreApps } from "@/lib/query";
import { loadAggregate } from "@/lib/store";

export const metadata = {
  title: "Multi-store apps",
  description: "Apps listed on two or more public catalogs or package registries.",
};

export default function MultiStorePage() {
  const agg = loadAggregate();
  const apps = multiStoreApps(agg);
  return (
    <Shell>
      <h1 className="text-3xl font-semibold tracking-tight">Multi-store apps</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Same entity on 2+ of MCP Registry, Smithery, Gemini CLI, npm, or PyPI. GitHub stats alone do not count as a store.
      </p>
      <p className="mb-4 mt-3 text-xs text-muted">{apps.length} apps</p>
      <AppTable apps={apps} extra={(app) => `${app.stores.length} stores`} />
    </Shell>
  );
}
