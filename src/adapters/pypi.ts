import { z } from "zod";
import { PYPISTATS_BASE } from "../lib/config.ts";
import { HttpError } from "../lib/http.ts";
import { appIdFromIdentity, normalizePackageName } from "../lib/matching.ts";
import { emptySourceRow, type SourceRow } from "../lib/schema.ts";
import type { CollectContext, SourceAdapter, SourceResult } from "./types.ts";

const RecentSchema = z.object({
  data: z.object({
    last_day: z.number().nullable().optional(),
    last_week: z.number().nullable().optional(),
    last_month: z.number().nullable().optional(),
  }),
  package: z.string().optional(),
  type: z.string().optional(),
});

export type PypiRawSnapshot = {
  endpoint: string;
  fetchedAt: string;
  packages: Record<string, unknown>;
};

export function normalizePypiRecent(snapshotDate: string, name: string, item: unknown): SourceRow | null {
  const parsed = RecentSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const pkg = normalizePackageName(parsed.data.package ?? name, "pypi");
  return emptySourceRow({
    snapshot_date: snapshotDate,
    source: "pypi",
    source_id: pkg,
    name: pkg,
    pypi_package: pkg,
    pypi_last_week_downloads: parsed.data.data.last_week ?? null,
    pypi_last_month_downloads: parsed.data.data.last_month ?? null,
    app_id: appIdFromIdentity({
      pypiPackage: pkg,
      source: "pypi",
      sourceId: pkg,
    }),
  });
}

export const pypiAdapter: SourceAdapter = {
  name: "pypi",
  kind: "enrichment",
  async collect(ctx: CollectContext): Promise<SourceResult> {
    const names = [...ctx.discovered.pypiPackages].sort();
    const packages: Record<string, unknown> = {};
    if (names.length === 0) {
      return {
        source: "pypi",
        collectedAt: ctx.collectedAt,
        rowCount: 0,
        skipped: false,
        raw: { endpoint: PYPISTATS_BASE, fetchedAt: ctx.collectedAt, packages },
        records: [],
      };
    }

    for (const name of names) {
      const url = `${PYPISTATS_BASE}/${encodeURIComponent(name)}/recent`;
      try {
        packages[name] = await ctx.http.fetchJson<unknown>(url);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          continue;
        }
        ctx.log.warn("pypi package fetch failed", { name, error: String(error) });
      }
    }

    const records: SourceRow[] = [];
    for (const [name, item] of Object.entries(packages)) {
      const row = normalizePypiRecent(ctx.snapshotDate, name, item);
      if (row) {
        records.push(row);
      }
    }

    ctx.log.info("pypi collected", { requested: names.length, rows: records.length });
    const raw: PypiRawSnapshot = {
      endpoint: PYPISTATS_BASE,
      fetchedAt: ctx.collectedAt,
      packages,
    };
    return {
      source: "pypi",
      collectedAt: ctx.collectedAt,
      rowCount: records.length,
      skipped: false,
      raw,
      records,
    };
  },
};
