import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Aggregate } from "./types.ts";

export function writeAggregateJson(agg: Aggregate, path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(agg)}\n`);
  return path;
}

export function writeAggregateSqlite(agg: Aggregate, path: string): string | null {
  let DatabaseSync: SqliteModule["DatabaseSync"];
  try {
    ({ DatabaseSync } = requireSqlite());
  } catch {
    return null;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    unlinkSync(path);
  }
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA journal_mode = OFF;
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT,
        homepage TEXT,
        repo_url TEXT,
        npm_package TEXT,
        pypi_package TEXT,
        sources TEXT NOT NULL,
        stores TEXT NOT NULL,
        category TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        stars INTEGER,
        forks INTEGER,
        open_issues INTEGER,
        pushed_at TEXT,
        npm_weekly_downloads INTEGER,
        pypi_last_week_downloads INTEGER,
        gemini_stars INTEGER,
        verified INTEGER
      );
      CREATE TABLE history (
        app_id TEXT NOT NULL,
        date TEXT NOT NULL,
        stars INTEGER,
        npm_weekly_downloads INTEGER,
        pypi_last_week_downloads INTEGER,
        gemini_stars INTEGER,
        PRIMARY KEY (app_id, date)
      );
      CREATE INDEX history_date ON history(date);
    `);
    const insertMeta = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    insertMeta.run("built_at", agg.meta.builtAt);
    insertMeta.run("origin", agg.meta.origin);
    insertMeta.run("source", agg.meta.source);
    insertMeta.run("snapshot_dates", JSON.stringify(agg.meta.snapshotDates));
    insertMeta.run("stats", JSON.stringify(agg.stats));
    insertMeta.run("coverage", JSON.stringify(agg.meta.coverage));

    const insertApp = db.prepare(`
      INSERT INTO apps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertHistory = db.prepare(`
      INSERT INTO history VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const app of agg.apps) {
      insertApp.run(
        app.id,
        app.name,
        app.displayName,
        app.description,
        app.homepage,
        app.repoUrl,
        app.npmPackage,
        app.pypiPackage,
        app.sources.join("|"),
        app.stores.join("|"),
        app.category,
        app.firstSeen,
        app.lastSeen,
        app.stars,
        app.forks,
        app.openIssues,
        app.pushedAt,
        app.npmWeeklyDownloads,
        app.pypiLastWeekDownloads,
        app.geminiStars,
        app.verified == null ? null : app.verified ? 1 : 0,
      );
      const series = agg.series[app.id];
      if (!series) {
        continue;
      }
      agg.meta.snapshotDates.forEach((date, index) => {
        insertHistory.run(
          app.id,
          date,
          series.s?.[index] ?? null,
          series.n?.[index] ?? null,
          series.p?.[index] ?? null,
          series.g?.[index] ?? null,
        );
      });
    }
  } finally {
    db.close();
  }
  return path;
}

type SqliteModule = {
  DatabaseSync: new (path: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { run: (...values: unknown[]) => void };
    close: () => void;
  };
};

function requireSqlite(): SqliteModule {
  const loader = (process as NodeJS.Process & { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule;
  if (!loader) {
    throw new Error("node:sqlite is not available on this Node version");
  }
  return loader("node:sqlite") as SqliteModule;
}

export function writeAggregateFiles(agg: Aggregate, outDir: string): { json: string; sqlite: string | null } {
  mkdirSync(outDir, { recursive: true });
  const json = writeAggregateJson(agg, join(outDir, "radar.json"));
  let sqlite: string | null = null;
  try {
    sqlite = writeAggregateSqlite(agg, join(outDir, "radar.sqlite"));
  } catch (error) {
    console.warn(`[aggregate] sqlite write skipped: ${error instanceof Error ? error.message : error}`);
  }
  return { json, sqlite };
}
