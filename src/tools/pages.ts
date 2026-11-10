import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildCtrCurve, expectedCtr } from '../analysis/ctr.js';
import { fetchRows, fetchTotals } from '../analysis/query.js';
import { auditHtml, queryCoverage, type PageAudit } from '../onpage/audit.js';
import { compareField, rangeFields, resolveScope, siteField, type ToolContext } from './context.js';
import { errorResult, jsonResult, metrics, pct, round, safe, totalsComparison } from './format.js';
import { inspectMany, sitemapUrls, summarizeInspection } from './inspection.js';

export function registerPageTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'analyze_page',
    {
      title: 'Analyze one page for SEO',
      description:
        'Deep dive on a single URL, such as a landing page: its search performance versus the previous period, every query it ranks for with position and CTR, ' +
        'striking-distance queries, Google\'s index status (URL Inspection), and a live on-page audit (title, meta description, headings, canonical, structured data) ' +
        'with a check of whether the top queries appear in the title, H1 and description. Use the result to rewrite titles and descriptions and to plan content changes.',
      inputSchema: z.object({
        url: z.string().url().describe('Full page URL as it appears in Google, e.g. "https://www.example.com/pricing".'),
        site: siteField,
        ...rangeFields,
        compareTo: compareField,
        queryLimit: z.number().int().min(1).max(500).optional().describe('How many of the page\'s queries to list. Default 30.'),
        includeInspection: z.boolean().optional().describe('Include Google index status (uses 1 of 2,000 daily inspections). Default true.'),
        includeOnPage: z.boolean().optional().describe('Fetch the live page and audit its HTML. Default true.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (input) => {
      // Search Console stores normalized URLs ("https://example.com/"), so normalize before filtering.
      const args = { ...input, url: new URL(input.url).href };
      const { site, range, comparison } = await resolveScope(ctx, { ...args, site: args.site ?? args.url }, { compareTo: args.compareTo ?? 'previous' });
      const pageFilter = [{ dimension: 'page' as const, operator: 'equals' as const, expression: args.url }];

      const [current, previous, queries, siteQueries] = await Promise.all([
        fetchTotals(ctx.api, site, range, { filters: pageFilter }),
        comparison ? fetchTotals(ctx.api, site, comparison, { filters: pageFilter }) : undefined,
        fetchRows(ctx.api, site, range, { dimensions: ['query'], filters: pageFilter, maxRows: 25_000 }),
        fetchRows(ctx.api, site, range, { dimensions: ['query'], maxRows: 25_000 }),
      ]);

      const [inspection, audit] = await Promise.all([
        args.includeInspection === false ? undefined : ctx.api.inspectUrl(site, args.url).then((r) => summarizeInspection(args.url, r), (e: Error) => ({ error: e.message })),
        args.includeOnPage === false ? undefined : runAudit(ctx, args.url).catch((e: Error) => ({ error: e.message })),
      ]);

      const curve = buildCtrCurve(siteQueries.rows);
      const queryLimit = args.queryLimit ?? 30;
      const pageQueries = queries.rows.sort((a, b) => b.impressions - a.impressions);
      const coverage = audit && !('error' in audit) ? new Map(queryCoverage(pageQueries.slice(0, 15).map((q) => q.query!), audit).map((c) => [c.query, c])) : undefined;

      let similarPages: string[] | undefined;
      if (current.impressions === 0) similarPages = await findSimilarPages(ctx, site, range, args.url);

      return jsonResult({
        site,
        url: args.url,
        period: range,
        ...(comparison && previous ? { comparisonPeriod: comparison, totals: totalsComparison(current, previous) } : { totals: metrics(current) }),
        ...(similarPages
          ? {
              note: similarPages.length
                ? 'No search data for this exact URL. Search Console reports the canonical URL; did you mean one of similarPages?'
                : 'No final search data for this URL in the period. It may be new, not indexed, or not ranking yet (check indexStatus). Final data lags 2-3 days; search_analytics with dataState "all" and a page filter shows the freshest numbers.',
              similarPages,
            }
          : {}),
        queryCount: pageQueries.length,
        ...(queries.truncated ? { queriesNote: 'The page has more than 25,000 queries; the lowest-click ones were not analysed.' } : {}),
        queries: pageQueries.slice(0, queryLimit).map((q) => {
          const c = coverage?.get(q.query!);
          return {
            query: q.query,
            ...metrics(q),
            expectedCtr: pct(expectedCtr(q.position, curve)),
            ...(c ? { inTitle: share(c.title), inH1: share(c.h1), inDescription: share(c.metaDescription) } : {}),
          };
        }),
        strikingDistance: pageQueries
          .filter((q) => q.position >= 4 && q.position <= 20 && q.impressions >= 10)
          .slice(0, 10)
          .map((q) => ({ query: q.query, position: round(q.position), impressions: Math.round(q.impressions) })),
        ...(inspection ? { indexStatus: inspection } : {}),
        ...(audit ? { onPage: 'error' in audit ? audit : compactAudit(audit) } : {}),
      });
    }),
  );

  server.registerTool(
    'audit_page',
    {
      title: 'On-page SEO audit',
      description:
        'Fetches a live URL and audits its HTML: status and redirects, title and meta description length, headings, canonical, robots directives, hreflang, Open Graph, JSON-LD types, word count, image alt text and links, with a list of issues. ' +
        'Works for any public URL and does not need Search Console access. Note it reads the raw HTML, so content rendered by JavaScript is not seen.',
      inputSchema: z.object({
        url: z.string().url(),
        targetQueries: z.array(z.string()).max(30).optional().describe('Optional queries to check against the title, H1 and meta description.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ url, targetQueries }) => {
      const audit = await runAudit(ctx, url);
      return jsonResult({
        ...compactAudit(audit),
        ...(targetQueries?.length
          ? {
              queryCoverage: queryCoverage(targetQueries, audit).map((c) => ({
                query: c.query,
                inTitle: share(c.title),
                inH1: share(c.h1),
                inDescription: share(c.metaDescription),
              })),
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    'inspect_urls',
    {
      title: 'Check Google index status (URL Inspection)',
      description:
        'Checks how Google sees one or more URLs using the URL Inspection API: indexed or not, coverage state (e.g. "Crawled - currently not indexed"), last crawl, robots and noindex status, ' +
        'Google-selected versus declared canonical, and rich result issues. Pass `urls`, or `sitemapUrl` to check the URLs in a sitemap. ' +
        'Quota: 2,000 inspections per property per day, so keep batches focused. This reports the indexed version, not a live test.',
      inputSchema: z.object({
        site: siteField,
        urls: z.array(z.string().url()).max(200).optional(),
        sitemapUrl: z.string().url().optional().describe('Inspect URLs listed in this sitemap (follows sitemap indexes).'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum URLs to inspect. Default 25.'),
        languageCode: z.string().optional().describe('BCP-47 language for issue messages. Default "en-US".'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      if (!args.urls?.length && !args.sitemapUrl) return errorResult('Provide `urls` or `sitemapUrl`.');
      const limit = args.limit ?? 25;
      const site = await ctx.sites.resolve(args.site ?? args.urls?.[0] ?? args.sitemapUrl);
      const urls = args.urls?.length
        ? args.urls.slice(0, limit)
        : await sitemapUrls(ctx.fetchPage, args.sitemapUrl!, limit, { allowPrivate: ctx.settings.allowPrivateUrls });
      if (urls.length === 0) {
        return errorResult(`No <loc> URLs found in ${args.sitemapUrl}. Check that it is a valid XML sitemap (gzipped sitemaps are supported).`);
      }
      const results = await inspectMany(ctx.api, site, [...new Set(urls)], args.languageCode);

      const byCoverage: Record<string, number> = {};
      for (const r of results) {
        const key = r.error ? 'Error' : (r.coverageState ?? r.verdict ?? 'Unknown');
        byCoverage[key] = (byCoverage[key] ?? 0) + 1;
      }
      return jsonResult({
        site,
        inspected: results.length,
        summary: {
          indexed: results.filter((r) => r.verdict === 'PASS').length,
          notIndexed: results.filter((r) => r.verdict && r.verdict !== 'PASS').length,
          errors: results.filter((r) => r.error).length,
          byCoverageState: byCoverage,
        },
        results,
      });
    }),
  );
}

async function runAudit(ctx: ToolContext, url: string): Promise<PageAudit> {
  const page = await ctx.fetchPage(url, { allowPrivate: ctx.settings.allowPrivateUrls });
  return auditHtml(page);
}

function compactAudit(a: PageAudit) {
  return {
    url: a.url,
    ...(a.finalUrl !== a.url ? { finalUrl: a.finalUrl } : {}),
    status: a.status,
    ...(a.redirects.length ? { redirects: a.redirects } : {}),
    responseTimeMs: a.responseTimeMs,
    title: a.title,
    titleLength: a.titleLength,
    metaDescription: a.metaDescription,
    metaDescriptionLength: a.metaDescriptionLength,
    canonical: a.canonical,
    metaRobots: a.metaRobots,
    xRobotsTag: a.xRobotsTag,
    lang: a.lang,
    h1: a.h1,
    h2: a.h2,
    wordCount: a.wordCount,
    images: a.images,
    links: a.links,
    ...(a.hreflang.length ? { hreflang: a.hreflang } : {}),
    openGraph: a.openGraph,
    twitterCard: a.twitterCard,
    structuredDataTypes: a.structuredData.types,
    issues: a.issues.map((i) => `${i.severity.toUpperCase()}: ${i.message}`),
  };
}

function share(value: number): string {
  return value === 1 ? 'all words' : value === 0 ? 'none' : `${Math.round(value * 100)}% of words`;
}

/** Search Console keys data by canonical URL, so suggest close variants when an exact URL has no data. */
async function findSimilarPages(ctx: ToolContext, site: string, range: { startDate: string; endDate: string }, url: string): Promise<string[]> {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/$/, '');
  // For a homepage, match on the host instead (catches http/https and www variants).
  const expression = path || parsed.hostname.replace(/^www\./, '');
  const { rows } = await fetchRows(ctx.api, site, range, {
    dimensions: ['page'],
    filters: [{ dimension: 'page', operator: 'contains', expression }],
    maxRows: 10,
  });
  return rows.map((r) => r.page!).filter((p) => p !== url);
}
