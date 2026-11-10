import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildFilters, fetchRows, fetchTotals, sumRows, type Row } from '../analysis/query.js';
import { DIMENSIONS, FILTER_DIMENSIONS, FILTER_OPERATORS, SEARCH_TYPES } from '../gsc/types.js';
import { compareField, filterFields, rangeFields, resolveScope, siteField, type ToolContext } from './context.js';
import { jsonResult, metrics, noDataNote, round, pct, safe, totalsComparison } from './format.js';

const MAX_OUTPUT_ROWS = 5000;

export function registerAnalyticsTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_analytics',
    {
      title: 'Query Search Analytics',
      description:
        'Raw Google Search performance data (clicks, impressions, CTR, average position) grouped by any dimensions, with filters. ' +
        'Use for custom questions the other tools do not answer, e.g. clicks by date for one page, queries containing a word, or country breakdowns. ' +
        'Rows are sorted by clicks (or by date when grouped by date). Final data lags 2-3 days; with dataState "all" the default range ends today and includes fresh, still-changing data.',
      inputSchema: z.object({
        site: siteField,
        ...rangeFields,
        dimensions: z.array(z.enum(DIMENSIONS)).max(4).optional().describe('Group by these dimensions, e.g. ["query"], ["page","query"], ["date"]. "hour" switches to hourly data (last 10 days by default). Omit for totals.'),
        searchType: z.enum(SEARCH_TYPES).optional().describe('Default "web".'),
        filters: z
          .array(
            z.object({
              dimension: z.enum(FILTER_DIMENSIONS),
              operator: z.enum(FILTER_OPERATORS).optional().describe('Default "equals". Regex operators use RE2 syntax.'),
              expression: z.string().max(4096),
            }),
          )
          .optional()
          .describe('All filters must match (AND). Country uses alpha-3 codes ("usa"); device is DESKTOP, MOBILE or TABLET.'),
        aggregationType: z.enum(['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel']).optional(),
        dataState: z.enum(['final', 'all', 'hourly_all']).optional().describe('"final" (default) or "all" to include fresh, still-changing data.'),
        rowLimit: z.number().int().min(1).max(MAX_OUTPUT_ROWS).optional().describe('Rows to return. Default 100.'),
        startRow: z.number().int().min(0).optional().describe('Zero-based offset for paging.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const dimensions = args.dimensions ?? [];
      const hourly = dimensions.includes('hour');
      const dataState = hourly ? 'hourly_all' : args.dataState;
      const fresh = dataState === 'all' || dataState === 'hourly_all';
      // Hourly data only covers roughly the last 10 days.
      const { site, range } = await resolveScope(ctx, { ...args, days: args.days ?? (hourly ? 10 : undefined) }, { fresh });
      const result = await fetchRows(ctx.api, site, range, {
        dimensions,
        searchType: args.searchType,
        filters: args.filters,
        aggregationType: args.aggregationType,
        dataState,
        maxRows: args.rowLimit ?? 100,
        startRow: args.startRow,
      });
      return jsonResult({
        site,
        ...range,
        searchType: args.searchType ?? 'web',
        dimensions,
        rowCount: result.rows.length,
        ...(result.truncated ? { moreRowsAvailable: true, nextStartRow: (args.startRow ?? 0) + result.rows.length } : {}),
        ...(result.firstIncompleteDate ? { firstIncompleteDate: result.firstIncompleteDate } : {}),
        rows: result.rows.map(formatRow),
      });
    }),
  );

  server.registerTool(
    'performance_summary',
    {
      title: 'Search performance summary',
      description:
        'One-call overview of a property: total clicks, impressions, CTR and position versus the comparison period, the trend over time, top queries, top pages, device split and top countries. Good starting point for any SEO review.',
      inputSchema: z.object({
        site: siteField,
        ...rangeFields,
        compareTo: compareField,
        ...filterFields,
        top: z.number().int().min(1).max(50).optional().describe('How many top queries and pages to list. Default 10.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const { site, range, comparison } = await resolveScope(ctx, args, { compareTo: args.compareTo ?? 'previous' });
      const filters = buildFilters(args);
      const base = { searchType: args.searchType, filters };
      const top = args.top ?? 10;
      const [current, previous, trend, queries, pages, devices, countries] = await Promise.all([
        fetchTotals(ctx.api, site, range, base),
        comparison ? fetchTotals(ctx.api, site, comparison, base) : undefined,
        fetchRows(ctx.api, site, range, { ...base, dimensions: ['date'], maxRows: 500 }),
        fetchRows(ctx.api, site, range, { ...base, dimensions: ['query'], maxRows: top }),
        fetchRows(ctx.api, site, range, { ...base, dimensions: ['page'], maxRows: top }),
        fetchRows(ctx.api, site, range, { ...base, dimensions: ['device'], maxRows: 5 }),
        fetchRows(ctx.api, site, range, { ...base, dimensions: ['country'], maxRows: 5 }),
      ]);
      return jsonResult({
        site,
        period: range,
        ...(comparison ? { comparisonPeriod: comparison, totals: totalsComparison(current, previous!) } : { totals: metrics(current) }),
        trend: bucketTrend(trend.rows),
        topQueries: queries.rows.map((r) => ({ query: r.query, ...metrics(r) })),
        topPages: pages.rows.map((r) => ({ page: r.page, ...metrics(r) })),
        devices: devices.rows.map((r) => ({ device: r.device, ...metrics(r), clickShare: current.clicks ? pct(r.clicks / current.clicks, 1) : '0%' })),
        topCountries: countries.rows.map((r) => ({ country: r.country, ...metrics(r) })),
        ...(current.impressions === 0 ? noDataNote(range) : { note: 'Top queries exclude anonymized queries, so they add up to less than the totals.' }),
      });
    }),
  );
}

export function formatRow(row: Row) {
  const { clicks, impressions, ctr, position, ...dims } = row;
  return { ...dims, clicks: Math.round(clicks), impressions: Math.round(impressions), ctr: pct(ctr), position: round(position) };
}

/** Daily points for up to 35 days, weekly buckets beyond that to keep the output small. */
function bucketTrend(rows: Row[]) {
  const sorted = [...rows].sort((a, b) => a.date!.localeCompare(b.date!));
  if (sorted.length <= 35) return { granularity: 'day', points: sorted.map((r) => ({ date: r.date, ...metrics(r) })) };
  const points = [];
  for (let i = 0; i < sorted.length; i += 7) {
    const week = sorted.slice(i, i + 7);
    points.push({ weekStarting: week[0]!.date, days: week.length, ...metrics(sumRows(week)) });
  }
  return { granularity: 'week', points };
}
