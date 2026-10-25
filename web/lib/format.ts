export function round2sf(value: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const sign = Math.sign(value);
  const abs = Math.abs(value);
  const exp = Math.floor(Math.log10(abs));
  const factor = 10 ** (exp - 1);
  return sign * Math.round(abs / factor) * factor;
}

export function growthBucket(pct: number | null | undefined): string | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  const abs = Math.abs(pct);
  let label = ">100%";
  if (abs < 0.01) label = "<1%";
  else if (abs < 0.05) label = "1–5%";
  else if (abs < 0.1) label = "5–10%";
  else if (abs < 0.25) label = "10–25%";
  else if (abs < 0.5) label = "25–50%";
  else if (abs < 1) label = "50–100%";
  return pct < 0 ? `−${label}` : label;
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatCompact(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** Public count display: 12,345 → "12K", 987 → "990" (values are already 2-sf rounded). */
export function formatCount(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  if (Math.abs(value) >= 1000) {
    return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0 }).format(value);
  }
  return formatNumber(value);
}

export function formatSigned(value: number | null | undefined): string {
  if (value == null) return "—";
  const abs = formatNumber(Math.abs(value));
  if (value > 0) return `+${abs}`;
  if (value < 0) return `−${abs}`;
  return "0";
}

export function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const pct = value * 100;
  const body = `${Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`;
  if (pct > 0) return `+${body}`;
  if (pct < 0) return `−${body}`;
  return "0%";
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function rankDelta(rank: number, previous: number | null): number | null {
  if (previous == null) return null;
  return previous - rank;
}
