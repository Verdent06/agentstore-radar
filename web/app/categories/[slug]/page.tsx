import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { AppTable } from "@/components/table";
import { CATEGORY_LABELS, type CategorySlug } from "@/lib/types";
import { appsInCategory, isCategorySlug } from "@/lib/query";
import { loadAggregate } from "@/lib/store";

export function generateStaticParams() {
  return Object.keys(CATEGORY_LABELS).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const label = isCategorySlug(slug) ? CATEGORY_LABELS[slug] : "Category";
  return { title: label };
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: raw } = await params;
  if (!isCategorySlug(raw)) notFound();
  const agg = loadAggregate();
  const slug = raw as CategorySlug;
  const apps = appsInCategory(agg, slug);
  return (
    <Shell>
      <p className="text-xs uppercase tracking-[0.2em] text-muted">Category</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">{CATEGORY_LABELS[slug]}</h1>
      <p className="mb-4 mt-2 text-sm text-muted">{apps.length} apps · keyword heuristic, not embeddings</p>
      <AppTable apps={apps} />
    </Shell>
  );
}
