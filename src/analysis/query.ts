import type { DataState, Dimension, DimensionFilter, GscApi, SearchAnalyticsRequest, SearchType } from '../gsc/types.js';
import { addDays, todayPT, type DateRange } from './dates.js';

/** One Search Analytics row with its dimension values pulled out by name. */
export interface Row {
  query?: string;
  page?: string;
  country?: string;
  device?: string;
  date?: string;
  searchAppearance?: string;
  hour?: string;
  clicks: number;
  impressions: number;
  /** 0..1 */
  ctr: number;
  position: number;
}

export interface Totals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Filters shared by the analysis tools. Regexes use RE2 syntax and are applied by Google. */
export interface CommonFilters {
  queryRegex?: string;
  excludeQueryRegex?: string;
  pageRegex?: string;
  excludePageRegex?: string;
  /** ISO 3166-1 alpha-3, e.g. USA, GBR. */
  country?: string;
  device?: 'DESKTOP' | 'MOBILE' | 'TABLET';
  searchType?: SearchType;
}

export function buildFilters(f: CommonFilters, extra: DimensionFilter[] = []): DimensionFilter[] {
  const filters: DimensionFilter[] = [...extra];
  if (f.queryRegex) filters.push({ dimension: 'query', operator: 'includingRegex', expression: f.queryRegex });
  if (f.excludeQueryRegex) filters.push({ dimension: 'query', operator: 'excludingRegex', expression: f.excludeQueryRegex });
  if (f.pageRegex) filters.push({ dimension: 'page', operator: 'includingRegex', expression: f.pageRegex });
  if (f.excludePageRegex) filters.push({ dimension: 'page', operator: 'excludingRegex', expression: f.excludePageRegex });
  if (f.country) filters.push({ dimension: 'country', operator: 'equals', expression: f.country.toLowerCase() });
  if (f.device) filters.push({ dimension: 'device', operator: 'equals', expression: f.device });
  return filters;
}

export interface FetchOptions {
  dimensions?: Dimension[];
  filters?: DimensionFilter[];
  searchType?: SearchType;
  dataState?: DataState;
  aggregationType?: SearchAnalyticsRequest['aggregationType'];
  /** Stop after this many rows (pages through the API 25,000 at a time). */
  maxRows?: number;
  startRow?: number;
}

export interface FetchResult {
  rows: Row[];
  /** True when more rows were available than maxRows. */
  truncated: boolean;
  firstIncompleteDate?: string;
  responseAggregationType?: string;
}

const API_PAGE_SIZE = 25_000;

export async function fetchRows(api: GscApi, site: string, range: DateRange, options: FetchOptions = {}): Promise<FetchResult> {
  const dimensions = options.dimensions ?? [];
  const maxRows = options.maxRows ?? 1000;
  const rows: Row[] = [];
  let startRow = options.startRow ?? 0;
  let truncated = false;
  let firstIncompleteDate: string | undefined;
  let responseAggregationType: string | undefined;

  const request = async (startRow: number, rowLimit: number) => {
    const response = await api.searchAnalytics(site, {
      startDate: range.startDate,
      endDate: range.endDate,
      ...(dimensions.length ? { dimensions } : {}),
      ...(options.searchType && options.searchType !== 'web' ? { type: options.searchType } : {}),
      ...(options.filters?.length ? { dimensionFilterGroups: [{ groupType: 'and' as const, filters: options.filters }] } : {}),
      ...(options.dataState ? { dataState: options.dataState } : {}),
      ...(options.aggregationType ? { aggregationType: options.aggregationType } : {}),
      rowLimit,
      startRow,
    });
    firstIncompleteDate ??= response.metadata?.first_incomplete_date;
    responseAggregationType ??= response.responseAggregationType;
    return response.rows ?? [];
  };

  // Ask for one row more than needed so "exactly maxRows" and "more available" can be told apart.
  for (;;) {
    const wanted = maxRows - rows.length;
    if (wanted <= 0) {
      truncated = (await request(startRow, 1)).length > 0;
      break;
    }
    const rowLimit = Math.min(API_PAGE_SIZE, wanted + 1);
    const page = await request(startRow, rowLimit);
    for (const raw of page.slice(0, wanted)) rows.push(toRow(dimensions, raw.keys ?? [], raw));
    if (page.length > wanted) {
      truncated = true;
      break;
    }
    if (page.length < rowLimit) break;
    startRow += page.length;
  }
  return { rows, truncated, firstIncompleteDate, responseAggregationType };
}

function toRow(dimensions: Dimension[], keys: string[], metrics: Totals): Row {
  const row: Row = { clicks: metrics.clicks, impressions: metrics.impressions, ctr: metrics.ctr, position: metrics.position };
  dimensions.forEach((dimension, i) => {
    row[dimension] = keys[i];
  });
  return row;
}

/** Property-level totals for a range (a query with no dimensions). */
export async function fetchTotals(api: GscApi, site: string, range: DateRange, options: Omit<FetchOptions, 'dimensions' | 'maxRows'> = {}): Promise<Totals> {
  const { rows } = await fetchRows(api, site, range, { ...options, dimensions: [], maxRows: 1 });
  const row = rows[0];
  return row ? { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position } : { clicks: 0, impressions: 0, ctr: 0, position: 0 };
}

/** Impression-weighted totals of a set of rows. Position is weighted by impressions, as in Search Console. */
export function sumRows(rows: Row[]): Totals {
  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;
  for (const row of rows) {
    clicks += row.clicks;
    impressions += row.impressions;
    weightedPosition += row.position * row.impressions;
  }
  return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: impressions ? weightedPosition / impressions : 0 };
}

const FRESHNESS_TTL_MS = 60 * 60_000;

/** Finds the most recent day with final data per property (usually 2-3 days ago), cached for an hour. */
export class DataFreshness {
  private cache = new Map<string, { at: number; date: string }>();

  constructor(private readonly api: GscApi) {}

  async latestDate(site: string, searchType?: SearchType): Promise<string> {
    const key = `${site}|${searchType ?? 'web'}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < FRESHNESS_TTL_MS) return hit.date;
    const today = todayPT();
    const { rows } = await fetchRows(this.api, site, { startDate: addDays(today, -10), endDate: today }, {
      dimensions: ['date'],
      searchType,
      dataState: 'final',
      maxRows: 20,
    });
    const latest = rows.map((r) => r.date!).sort().at(-1) ?? addDays(today, -3);
    this.cache.set(key, { at: Date.now(), date: latest });
    return latest;
  }
}
