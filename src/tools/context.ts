import * as z from 'zod';
import type { AuthManager } from '../auth/provider.js';
import type { RuntimeSettings } from '../config.js';
import { comparisonRange, resolveRange, todayPT, type Comparison, type DateRange } from '../analysis/dates.js';
import type { CommonFilters, DataFreshness } from '../analysis/query.js';
import type { SiteDirectory } from '../gsc/sites.js';
import { SEARCH_TYPES, type GscApi } from '../gsc/types.js';
import type { PageFetcher } from '../onpage/fetch.js';

export interface ToolContext {
  api: GscApi;
  sites: SiteDirectory;
  freshness: DataFreshness;
  auth: Pick<AuthManager, 'status' | 'startLogin' | 'credentialsPath' | 'oauthClientConfig'>;
  settings: RuntimeSettings;
  fetchPage: PageFetcher;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const siteField = z
  .string()
  .optional()
  .describe(
    'Search Console property, e.g. "sc-domain:example.com", "https://www.example.com/", or just "example.com" (matched to your properties). Optional when you have one property or GSC_DEFAULT_SITE is set.',
  );

export const rangeFields = {
  days: z.number().int().min(1).max(486).optional().describe('Length of the period in days, ending on the latest day with final data. Default 28.'),
  startDate: isoDate.optional().describe('Start date (YYYY-MM-DD, Pacific Time). Overrides days. Data goes back about 16 months.'),
  endDate: isoDate.optional().describe('End date (YYYY-MM-DD, Pacific Time). Defaults to the latest day with final data (usually 2-3 days ago).'),
};

export const compareField = z
  .enum(['previous', 'year', 'none'])
  .optional()
  .describe('Compare with the previous period of equal length (default), the same period a year earlier (52 weeks, weekdays aligned), or nothing.');

export const filterFields = {
  searchType: z.enum(SEARCH_TYPES).optional().describe('Result type. Default "web".'),
  queryRegex: z.string().optional().describe('Only queries matching this RE2 regex, e.g. "(?i)pricing|cost".'),
  excludeQueryRegex: z.string().optional().describe('Drop queries matching this RE2 regex. Use it to exclude branded queries, e.g. "(?i)acme|acmecorp".'),
  pageRegex: z.string().optional().describe('Only pages whose URL matches this RE2 regex, e.g. "/landing/".'),
  excludePageRegex: z.string().optional().describe('Drop pages whose URL matches this RE2 regex.'),
  country: z.string().length(3).optional().describe('ISO 3166-1 alpha-3 country code, e.g. "USA", "GBR".'),
  device: z.enum(['DESKTOP', 'MOBILE', 'TABLET']).optional(),
};

export const limitField = (defaultValue: number, max = 200) =>
  z.number().int().min(1).max(max).optional().describe(`Maximum rows to return. Default ${defaultValue}.`);

export interface RangeArgs {
  site?: string;
  days?: number;
  startDate?: string;
  endDate?: string;
}

export interface Scope {
  site: string;
  range: DateRange;
  comparison?: DateRange;
}

export interface ScopeOptions {
  compareTo?: Comparison | 'none';
  /** End the default range today instead of on the latest final day (for dataState "all"/"hourly_all"). */
  fresh?: boolean;
}

export async function resolveScope(ctx: ToolContext, args: RangeArgs & { searchType?: CommonFilters['searchType'] }, options: ScopeOptions = {}): Promise<Scope> {
  const site = await ctx.sites.resolve(args.site);
  const latest = args.endDate ?? (options.fresh ? todayPT() : await ctx.freshness.latestDate(site, args.searchType));
  const range = resolveRange(args, latest);
  const mode = options.compareTo ?? 'none';
  return { site, range, comparison: mode === 'none' ? undefined : comparisonRange(range, mode) };
}
