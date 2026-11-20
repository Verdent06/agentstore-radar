/**
 * Shared popularity-window guard. /web and /mcp both import this module.
 * Core-clean is decided from one day's snapshot manifest. There is no list of clean dates.
 */

/** Single global floor. Windows that start before this day are refused. */
export const verified_from = "2026-11-04";

/**
 * Minimum share of existing rows refetched (`refetchedExisting / existingCount`)
 * for a core source to count as clean.
 */
export const REFETCH_SHARE_FLOOR = 0.9;

export const CORE_SOURCES = ["mcp-registry", "github", "npm"] as const;
export type CoreSource = (typeof CORE_SOURCES)[number];

/** Frozen or paused catalogs. Kept out of combined scores and growth. */
export const FROZEN_SOURCES = ["smithery", "gemini-cli", "pypi"] as const;

const DAY_MS = 86_400_000;

export type CoreCleanResult = {
  clean: boolean;
  reasons: string[];
};

export type PopularityWindow = {
  allowed: boolean;
  /** Set only when the window may show numbers. Never "1d" unless the span is one calendar day. */
  label: string | null;
  dayCount: number;
  missingDates: string[];
  reasons: string[];
  start: string;
  end: string;
};

export type ScoreMetrics = {
  github?: number | null;
  npm?: number | null;
  mcp?: number | null;
  smithery?: number | null;
  gemini?: number | null;
  pypi?: number | null;
  pypiMonthly?: number | null;
};

const PYPI_MONTHLY_KEYS = new Set([
  "pypi_last_month_downloads",
  "pypiLastMonthDownloads",
  "pypiLastMonth",
  "pypi_last_month",
]);

export function addUtcDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function calendarDayCount(start: string, end: string): number {
  const span = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(span)) {
    return Number.NaN;
  }
  return Math.round(span / DAY_MS);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readNumber(record: Record<string, unknown>, field: string): number | null {
  if (!(field in record)) {
    return null;
  }
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function formatShare(value: number): string {
  return (Math.round(value * 10_000) / 10_000).toString();
}

function sourceEntry(sources: unknown[], name: CoreSource): Record<string, unknown> | null {
  for (const entry of sources) {
    const record = asRecord(entry);
    if (record?.source === name) {
      return record;
    }
  }
  return null;
}

function checkSource(record: Record<string, unknown>, source: CoreSource): string[] {
  const reasons: string[] = [];
  if (!("skipped" in record)) {
    reasons.push(`${source}: missing field skipped`);
  } else if (record.skipped !== false) {
    reasons.push(`${source}: skipped`);
  }
  if (record.failed === true) {
    reasons.push(`${source}: failed`);
  }
  if (!("truncated" in record)) {
    reasons.push(`${source}: missing field truncated`);
  } else if (record.truncated !== false) {
    reasons.push(`${source}: truncated`);
  }

  const mismatch = readNumber(record, "A");
  if (mismatch == null) {
    reasons.push(`${source}: missing field A`);
  } else if (mismatch !== 0) {
    reasons.push(`${source}: A is ${mismatch}`);
  }

  const refetched = readNumber(record, "refetchedExisting");
  if (refetched == null) {
    reasons.push(`${source}: missing field refetchedExisting`);
  }
  const existing = readNumber(record, "existingCount");
  if (existing == null) {
    reasons.push(`${source}: missing field existingCount`);
  }
  if (refetched != null && existing != null) {
    if (existing <= 0) {
      reasons.push(`${source}: existingCount is ${existing}`);
    } else {
      const share = refetched / existing;
      if (share < REFETCH_SHARE_FLOOR) {
        reasons.push(`${source}: refetch share ${formatShare(share)} is below ${REFETCH_SHARE_FLOOR}`);
      }
    }
  }
  return reasons;
}

/**
 * A day is core-clean only when every core source is complete, `truncated` is false,
 * `A` is 0, and `refetchedExisting / existingCount` is at least {@link REFETCH_SHARE_FLOOR}.
 * `existingCount` is the stored existing-row count. `rowCount` and `eligibleCount` are not
 * that count (they include new ids), so a manifest without `existingCount` fails closed.
 */
export function coreClean(manifest: unknown): CoreCleanResult {
  const record = asRecord(manifest);
  const sources = record?.sources;
  if (!Array.isArray(sources)) {
    return { clean: false, reasons: ["missing field sources"] };
  }
  const reasons: string[] = [];
  for (const source of CORE_SOURCES) {
    const entry = sourceEntry(sources, source);
    if (!entry) {
      reasons.push(`${source}: missing source`);
      continue;
    }
    reasons.push(...checkSource(entry, source));
  }
  return { clean: reasons.length === 0, reasons };
}

function datesStrictlyBetween(start: string, end: string): string[] {
  const span = calendarDayCount(start, end);
  if (!Number.isFinite(span) || span <= 1) {
    return [];
  }
  const dates: string[] = [];
  for (let offset = 1; offset < span; offset += 1) {
    dates.push(addUtcDays(start, offset));
  }
  return dates;
}

function endpointReasons(
  which: "start" | "end",
  date: string,
  present: ReadonlySet<string>,
  cleanByDate: Readonly<Record<string, CoreCleanResult | undefined>> | undefined,
): string[] {
  if (!present.has(date)) {
    return [`${which} ${date} is missing`];
  }
  const result = cleanByDate?.[date];
  if (!result) {
    return [`${which} ${date} is not core-clean`];
  }
  if (!result.clean) {
    return result.reasons.map((reason) => `${date}: ${reason}`);
  }
  return [];
}

export function popularityWindow(input: {
  start: string;
  end: string;
  presentDates: readonly string[];
  cleanByDate?: Readonly<Record<string, CoreCleanResult | undefined>>;
  requested?: "1d" | "7d";
}): PopularityWindow {
  const { start, end } = input;
  const dayCount = calendarDayCount(start, end);
  const present = new Set(input.presentDates);
  const missingDates = datesStrictlyBetween(start, end).filter((date) => !present.has(date));
  if (!present.has(start)) {
    missingDates.unshift(start);
  }
  if (!present.has(end) && end !== start) {
    missingDates.push(end);
  }
  const reasons: string[] = [];
  if (!Number.isFinite(dayCount) || dayCount <= 0) {
    reasons.push("window end is not after start");
  }
  if (start < verified_from) {
    reasons.push(`start ${start} is before verified_from ${verified_from}`);
  }
  if (end < verified_from) {
    reasons.push(`end ${end} is before verified_from ${verified_from}`);
  }
  reasons.push(...endpointReasons("start", start, present, input.cleanByDate));
  reasons.push(...endpointReasons("end", end, present, input.cleanByDate));
  if (input.requested === "1d" && (dayCount !== 1 || missingDates.length > 0)) {
    const named = missingDates.length > 0 ? missingDates.join(", ") : "none";
    reasons.push(`1-day window refused: span is ${dayCount}d; missing ${named}`);
  }
  const allowed = reasons.length === 0 && dayCount > 0;
  const label = allowed ? `${dayCount}d` : null;
  return {
    allowed,
    label: label === "1d" && dayCount !== 1 ? null : label,
    dayCount: Number.isFinite(dayCount) ? dayCount : 0,
    missingDates,
    reasons,
    start,
    end,
  };
}

/** Endpoints for a movers request. A 1d request that skips a day keeps the real previous snapshot. */
export function moverEndpoints(
  requested: "1d" | "7d",
  presentDates: readonly string[],
  completeDates: readonly string[],
): { start: string; end: string } | null {
  const end = completeDates.at(-1);
  if (!end) {
    return null;
  }
  if (requested === "7d") {
    return { start: addUtcDays(end, -7), end };
  }
  const yesterday = addUtcDays(end, -1);
  if (presentDates.includes(yesterday)) {
    return { start: yesterday, end };
  }
  const previous = presentDates.filter((date) => date < end).at(-1);
  return { start: previous ?? yesterday, end };
}

export function evaluateMoversWindow(
  requested: "1d" | "7d",
  presentDates: readonly string[],
  completeDates: readonly string[],
  cleanByDate: Readonly<Record<string, CoreCleanResult | undefined>> = {},
): PopularityWindow | null {
  const ends = moverEndpoints(requested, presentDates, completeDates);
  if (!ends) {
    return null;
  }
  return popularityWindow({
    start: ends.start,
    end: ends.end,
    presentDates,
    cleanByDate,
    requested,
  });
}

/** Point-to-point growth is shown only for an allowed 1-calendar-day window. */
export function pointGrowthAllowed(
  start: string,
  end: string,
  presentDates: readonly string[],
  cleanByDate: Readonly<Record<string, CoreCleanResult | undefined>> | undefined,
): boolean {
  const verdict = popularityWindow({
    start,
    end,
    presentDates,
    cleanByDate,
    requested: "1d",
  });
  return verdict.allowed && verdict.label === "1d" && verdict.dayCount === 1;
}

export function growthMetricEnabled(metric: string): boolean {
  return metric !== "pypi_last_week_downloads" && metric !== "gemini_stars" && metric !== "use_count";
}

function finite(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Sum of core-source metrics. Smithery, Gemini, and PyPI do not contribute. */
export function combinedScore(metrics: ScoreMetrics): number {
  return finite(metrics.github) + finite(metrics.npm) + finite(metrics.mcp);
}

/** Store membership. Frozen sources still count. */
export function membershipCount(stores: readonly string[]): number {
  return stores.length;
}

export function pausedSourceText(source: "smithery" | "gemini-cli"): string {
  return source === "smithery" ? "Listed on Smithery" : "Listed in the Gemini CLI gallery";
}

export function omitPypiMonthly(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => omitPypiMonthly(item));
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (PYPI_MONTHLY_KEYS.has(key)) {
      continue;
    }
    out[key] = omitPypiMonthly(child);
  }
  return out;
}
