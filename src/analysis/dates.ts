/** Search Console reports days in Pacific Time, so "today" means today in Los Angeles. */
export function todayPT(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive number of days from start to end. */
export function dayCount(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // Date rolls 2026-02-30 over to March 2nd, so compare the round trip.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface RangeInput {
  startDate?: string;
  endDate?: string;
  days?: number;
}

/**
 * Explicit dates win. Otherwise the range is the last `days` days (default 28) ending on the latest
 * day Search Console has final data for, which matches the "Last 28 days" view in the UI.
 */
export function resolveRange(input: RangeInput, latestDate: string): DateRange {
  const days = input.days ?? 28;
  if (input.startDate && input.endDate) return validated({ startDate: input.startDate, endDate: input.endDate });
  if (input.startDate) return validated({ startDate: input.startDate, endDate: latestDate < input.startDate ? input.startDate : latestDate });
  if (input.endDate) return validated({ startDate: addDays(input.endDate, -(days - 1)), endDate: input.endDate });
  return { startDate: addDays(latestDate, -(days - 1)), endDate: latestDate };
}

function validated(range: DateRange): DateRange {
  for (const value of [range.startDate, range.endDate]) {
    if (!isIsoDate(value)) throw new Error(`"${value}" is not a valid date. Use YYYY-MM-DD.`);
  }
  if (range.startDate > range.endDate) throw new Error(`startDate ${range.startDate} is after endDate ${range.endDate}.`);
  return range;
}

export type Comparison = 'previous' | 'year';

/**
 * The period to compare against: the same number of days immediately before, or 52 weeks earlier
 * (364 days, so weekdays line up) for year-over-year.
 */
export function comparisonRange(range: DateRange, compareTo: Comparison): DateRange {
  if (compareTo === 'year') {
    return { startDate: addDays(range.startDate, -364), endDate: addDays(range.endDate, -364) };
  }
  const length = dayCount(range.startDate, range.endDate);
  return { startDate: addDays(range.startDate, -length), endDate: addDays(range.startDate, -1) };
}
