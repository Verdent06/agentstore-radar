export function utcDateString(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function isValidDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function compareDateStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Shift a `YYYY-MM-DD` date by a number of UTC days. */
export function addUtcDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}
