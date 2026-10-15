import { z } from "zod";
import { NPM_BULK_LIMIT, NPM_DOWNLOADS_BASE } from "../lib/config.ts";
import { HttpError } from "../lib/http.ts";
import { appIdFromIdentity, normalizePackageName } from "../lib/matching.ts";
import { emptySourceRow, type SourceRow } from "../lib/schema.ts";
import type { CollectContext, SourceAdapter, SourceResult } from "./types.ts";

const PointSchema = z.object({
  downloads: z.number(),
  start: z.string().optional(),
  end: z.string().optional(),
  package: z.string().optional(),
});

export type NpmRawSnapshot = {
  endpoint: string;
  fetchedAt: string;
  packages: Record<string, unknown>;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function normalizeNpmPoint(snapshotDate: string, name: string, item: unknown): SourceRow | null {
  const parsed = PointSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const pkg = normalizePackageName(parsed.data.package ?? name, "npm");
  return emptySourceRow({
    snapshot_date: snapshotDate,
    source: "npm",
    source_id: pkg,
    name: pkg,
    npm_package: pkg,
    npm_weekly_downloads: parsed.data.downloads,
    app_id: appIdFromIdentity({
      npmPackage: pkg,
      source: "npm",
      sourceId: pkg,
    }),
  });
}

export const npmAdapter: SourceAdapter = {
  name: "npm",
  kind: "enrichment",
  async collect(ctx: CollectContext): Promise<SourceResult> {
    const names = [...ctx.discovered.npmPackages].sort();
    const packages: Record<string, unknown> = {};
    if (names.length === 0) {
      return {
        source: "npm",
        collectedAt: ctx.collectedAt,
        rowCount: 0,
        skipped: false,
        raw: { endpoint: NPM_DOWNLOADS_BASE, fetchedAt: ctx.collectedAt, packages },
        records: [],
      };
    }

    const scoped: string[] = [];
    const unscoped: string[] = [];
    for (const name of names) {
      if (name.startsWith("@")) {
        scoped.push(name);
      } else {
        unscoped.push(name);
      }
    }

    try {
      const batches = chunk(unscoped, NPM_BULK_LIMIT);
      for (const [index, batch] of batches.entries()) {
        const url = `${NPM_DOWNLOADS_BASE}/${batch.join(",")}`;
        const payload = await ctx.http.fetchJson<unknown>(url);
        if (batch.length === 1) {
          packages[batch[0]!] = payload;
        } else if (payload && typeof payload === "object") {
          Object.assign(packages, payload as Record<string, unknown>);
        }
        if ((index + 1) % 20 === 0 || index + 1 === batches.length) {
          ctx.log.info("npm bulk progress", { batch: index + 1, batches: batches.length, resolved: Object.keys(packages).length });
        }
      }

      for (const name of scoped) {
        const encoded = name.replace("/", "%2F");
        const url = `${NPM_DOWNLOADS_BASE}/${encoded}`;
        try {
          packages[name] = await ctx.http.fetchJson<unknown>(url);
        } catch (error) {
          ctx.log.warn("npm scoped package fetch failed", { name, error: String(error) });
        }
      }
    } catch (error) {
      if (error instanceof HttpError && (error.status === 429 || error.status === 403) && Object.keys(packages).length > 0) {
        ctx.log.warn("npm stopped early after rate limit; keeping partial snapshot", {
          resolved: Object.keys(packages).length,
          requested: names.length,
        });
      } else {
        throw error;
      }
    }

    const records: SourceRow[] = [];
    for (const [name, item] of Object.entries(packages)) {
      if (item == null) {
        continue;
      }
      const row = normalizeNpmPoint(ctx.snapshotDate, name, item);
      if (row) {
        records.push(row);
      }
    }

    ctx.log.info("npm collected", { requested: names.length, rows: records.length });
    const raw: NpmRawSnapshot = {
      endpoint: NPM_DOWNLOADS_BASE,
      fetchedAt: ctx.collectedAt,
      packages,
    };
    return {
      source: "npm",
      collectedAt: ctx.collectedAt,
      rowCount: records.length,
      skipped: false,
      raw,
      records,
    };
  },
};
