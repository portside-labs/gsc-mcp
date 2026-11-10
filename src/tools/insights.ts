import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { findCannibalization } from '../analysis/cannibalization.js';
import { comparePeriods, type Change } from '../analysis/compare.js';
import { buildCtrCurve, type CtrCurve } from '../analysis/ctr.js';
import { findCtrOpportunities, findQuickWins, topQueriesByPage } from '../analysis/opportunities.js';
import { buildFilters, fetchRows, fetchTotals, type Row } from '../analysis/query.js';
import { filterFields, limitField, rangeFields, resolveScope, siteField, type ToolContext } from './context.js';
import { change, jsonResult, metrics, noDataNote, pct, round, safe, signed, totalsComparison } from './format.js';

/** One API request's worth. Rows come back sorted by clicks, so anything cut is the low-click tail. */
const MAX_ROWS = 25_000;

export function registerInsightTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'find_quick_wins',
    {
      title: 'Find striking-distance keywords',
      description:
        'Finds "striking distance" queries: ones a page already ranks for just below the top results (position 4-20 by default) with meaningful impressions. ' +
        'Ranked by the extra clicks the page would get at the target position, using the site\'s own CTR-by-position curve. ' +
        'These are usually the fastest SEO wins: improve the ranking page\'s title, headings, content depth and internal links for the query.',
      inputSchema: z.object({
        site: siteField,
        ...rangeFields,
        ...filterFields,
        minPosition: z.number().min(1).max(100).optional().describe('Default 4.'),
        maxPosition: z.number().min(1).max(100).optional().describe('Default 20.'),
        minImpressions: z.number().int().min(1).optional().describe('Default 20.'),
        targetPosition: z.number().min(1).max(10).optional().describe('Position used to estimate the upside. Default 3.'),
        limit: limitField(25),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const { site, range } = await resolveScope(ctx, args);
      const base = { searchType: args.searchType, filters: buildFilters(args) };
      const [pairs, queries] = await Promise.all([
        fetchRows(ctx.api, site, range, { ...base, dimensions: ['query', 'page'], maxRows: MAX_ROWS }),
        fetchRows(ctx.api, site, range, { ...base, dimensions: ['query'], maxRows: MAX_ROWS }),
      ]);
      const curve = buildCtrCurve(queries.rows);
      const targetPosition = args.targetPosition ?? 3;
      const wins = findQuickWins(pairs.rows, curve, {
        minPosition: args.minPosition ?? 4,
        maxPosition: args.maxPosition ?? 20,
        minImpressions: args.minImpressions ?? 20,
        targetPosition,
        limit: args.limit ?? 25,
      });
      return jsonResult({
        site,
        period: range,
        targetPosition,
        ctrModel: describeCurve(curve),
        quickWins: wins.map((w) => ({
          query: w.query,
          page: w.page,
          position: round(w.position),
          impressions: Math.round(w.impressions),
          clicks: Math.round(w.clicks),
          ctr: pct(w.ctr),
          potentialExtraClicks: Math.round(w.potentialExtraClicks),
        })),
        ...(pairs.rows.length === 0 ? noDataNote(range) : truncationNote(pairs.truncated || queries.truncated)),
      });
    }),
  );

  server.registerTool(
    'find_ctr_opportunities',
    {
      title: 'Find low-CTR pages or queries',
      description:
        'Finds pages (or queries) that rank well but get fewer clicks than expected for their position, compared with the site\'s own CTR-by-position curve. ' +
        'These are candidates for rewriting the title tag and meta description, or adding structured data for rich results. ' +
        'Each page comes with the queries it gets the most impressions for, so new titles can target them. Exclude branded queries with excludeQueryRegex for cleaner results.',
      inputSchema: z.object({
        site: siteField,
        ...rangeFields,
        ...filterFields,
        by: z.enum(['page', 'query']).optional().describe('Default "page".'),
        maxPosition: z.number().min(1).max(50).optional().describe('Only rows with average position at or above this. Default 10 (page one).'),
        minImpressions: z.number().int().min(1).optional().describe('Default 100.'),
        threshold: z.number().min(0.05).max(1).optional().describe('Flag rows whose CTR is below this fraction of the expected CTR. Default 0.7 (30% or more under).'),
        limit: limitField(20),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const { site, range } = await resolveScope(ctx, args);
      const base = { searchType: args.searchType, filters: buildFilters(args) };
      const by = args.by ?? 'page';
      const [main, queries, pairs] = await Promise.all([
        by === 'page' ? fetchRows(ctx.api, site, range, { ...base, dimensions: ['page'], maxRows: MAX_ROWS }) : undefined,
        fetchRows(ctx.api, site, range, { ...base, dimensions: ['query'], maxRows: MAX_ROWS }),
        fetchRows(ctx.api, site, range, { ...base, dimensions: ['query', 'page'], maxRows: MAX_ROWS }),
      ]);
      const curve = buildCtrCurve(queries.rows);
      const options = {
        maxPosition: args.maxPosition ?? 10,
        minImpressions: args.minImpressions ?? 100,
        threshold: args.threshold ?? 0.7,
        limit: args.limit ?? 20,
      };

      const opportunities =
        by === 'page'
          ? attachQueries(findCtrOpportunities(main!.rows, (r) => r.page, curve, options), topQueriesByPage(pairs.rows, 5))
          : attachPages(findCtrOpportunities(queries.rows, (r) => r.query, curve, options), pairs.rows);

      return jsonResult({
        site,
        period: range,
        by,
        ctrModel: describeCurve(curve),
        opportunities,
        ...(queries.rows.length === 0 ? noDataNote(range) : truncationNote(!!main?.truncated || queries.truncated || pairs.truncated)),
      });
    }),
  );

  server.registerTool(
    'compare_periods',
    {
      title: 'Compare two periods (winners and losers)',
      description:
        'Compares pages or queries between the current period and the previous period (or the same period last year) and lists the biggest declines, gains, new entries and lost entries. ' +
        'Use it to investigate traffic drops, find decaying content to refresh, and confirm the effect of changes.',
      inputSchema: z.object({
        site: siteField,
        ...rangeFields,
        ...filterFields,
        dimension: z.enum(['page', 'query']).optional().describe('Default "page".'),
        compareTo: z.enum(['previous', 'year']).optional().describe('Default "previous".'),
        metric: z.enum(['clicks', 'impressions']).optional().describe('Rank changes by this metric. Default "clicks".'),
        limit: limitField(15, 100),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const { site, range, comparison } = await resolveScope(ctx, args, { compareTo: args.compareTo ?? 'previous' });
      const dimension = args.dimension ?? 'page';
      const base = { searchType: args.searchType, filters: buildFilters(args) };
      const [currentTotals, previousTotals, current, previous] = await Promise.all([
        fetchTotals(ctx.api, site, range, base),
        fetchTotals(ctx.api, site, comparison!, base),
        fetchRows(ctx.api, site, range, { ...base, dimensions: [dimension], maxRows: MAX_ROWS }),
        fetchRows(ctx.api, site, comparison!, { ...base, dimensions: [dimension], maxRows: MAX_ROWS }),
      ]);
      const result = comparePeriods(current.rows, previous.rows, (r) => r[dimension], args.metric ?? 'clicks', args.limit ?? 15, {
        currentComplete: !current.truncated,
        previousComplete: !previous.truncated,
      });
      const shape = (c: Change) => ({
        [dimension]: c.key,
        clicks: `${Math.round(c.previous.clicks)} → ${Math.round(c.current.clicks)} (${signed(c.clicksChange)})`,
        impressions: `${Math.round(c.previous.impressions)} → ${Math.round(c.current.impressions)} (${change(c.current.impressions, c.previous.impressions)})`,
        position: c.positionChange === null ? undefined : `${round(c.previous.position)} → ${round(c.current.position)}`,
        ctr: `${pct(c.previous.ctr)} → ${pct(c.current.ctr)}`,
      });
      return jsonResult({
        site,
        period: range,
        comparisonPeriod: comparison,
        totals: totalsComparison(currentTotals, previousTotals),
        declining: result.declining.map(shape),
        improving: result.improving.map(shape),
        new: result.new.map(shape),
        lost: result.lost.map(shape),
        ...(currentTotals.impressions === 0 && previousTotals.impressions === 0
          ? noDataNote(range)
          : current.truncated || previous.truncated
          ? {
              note: `Compared the top ${MAX_ROWS} ${dimension}s by clicks in each period. "new" and "lost" are left out where a period was cut off, since a missing row may just be below the cutoff. Narrow with pageRegex or queryRegex for a complete comparison.`,
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    'find_cannibalization',
    {
      title: 'Find keyword cannibalization',
      description:
        'Finds queries where two or more of the site\'s pages compete for the same search, splitting impressions and often ranking each other down. ' +
        'For each query it lists the competing pages with their share of impressions and position. Typical fixes: consolidate or redirect the weaker page, differentiate intent, or adjust internal links and canonicals.',
      inputSchema: z.object({
        site: siteField,
        ...rangeFields,
        ...filterFields,
        minImpressions: z.number().int().min(1).optional().describe('Ignore queries with fewer total impressions. Default 50.'),
        minShare: z.number().min(0.01).max(0.5).optional().describe('A page counts as competing above this share of the query\'s impressions. Default 0.1.'),
        limit: limitField(20, 100),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const { site, range } = await resolveScope(ctx, args);
      const pairs = await fetchRows(ctx.api, site, range, {
        searchType: args.searchType,
        filters: buildFilters(args),
        dimensions: ['query', 'page'],
        maxRows: MAX_ROWS,
      });
      const found = findCannibalization(pairs.rows, {
        minImpressions: args.minImpressions ?? 50,
        minShare: args.minShare ?? 0.1,
        limit: args.limit ?? 20,
      });
      return jsonResult({
        site,
        period: range,
        ...(pairs.rows.length === 0 ? noDataNote(range) : truncationNote(pairs.truncated)),
        queries: found.map((q) => ({
          query: q.query,
          impressions: Math.round(q.impressions),
          clicks: Math.round(q.clicks),
          pages: q.pages.map((p) => ({
            page: p.page,
            impressionShare: pct(p.impressionShare, 0),
            impressions: Math.round(p.impressions),
            clicks: Math.round(p.clicks),
            position: round(p.position),
          })),
        })),
      });
    }),
  );
}

function truncationNote(truncated: boolean) {
  return truncated
    ? { note: `This property has more than ${MAX_ROWS.toLocaleString('en-US')} rows for the period, so only the top rows by clicks were analysed. Narrow with pageRegex, queryRegex or a shorter period for full coverage.` }
    : {};
}

function describeCurve(curve: CtrCurve) {
  const fromSite = curve.fromSite.slice(0, 10).filter(Boolean).length;
  return {
    source: fromSite >= 5 ? 'site' : fromSite > 0 ? 'site + benchmark' : 'benchmark',
    expectedCtrByPosition: Object.fromEntries(curve.values.slice(0, 10).map((v, i) => [String(i + 1), pct(v, 1)])),
  };
}

function attachQueries(opportunities: ReturnType<typeof findCtrOpportunities>, byPage: Map<string, Row[]>) {
  return opportunities.map((o) => ({
    page: o.key,
    ...metrics(o),
    expectedCtr: pct(o.expectedCtr),
    missedClicks: Math.round(o.missedClicks),
    topQueries: (byPage.get(o.key) ?? []).map((q) => ({ query: q.query, impressions: Math.round(q.impressions), position: round(q.position), ctr: pct(q.ctr) })),
  }));
}

function attachPages(opportunities: ReturnType<typeof findCtrOpportunities>, pairs: Row[]) {
  return opportunities.map((o) => ({
    query: o.key,
    ...metrics(o),
    expectedCtr: pct(o.expectedCtr),
    missedClicks: Math.round(o.missedClicks),
    rankingPages: pairs
      .filter((p) => p.query === o.key)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 3)
      .map((p) => ({ page: p.page, impressions: Math.round(p.impressions), position: round(p.position) })),
  }));
}
