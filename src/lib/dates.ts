export function utcDateString(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function isValidDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function compareDateStrings(a: string, b: string): number {
  return a.localeCompare(b);
}
