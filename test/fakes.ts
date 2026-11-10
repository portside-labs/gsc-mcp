import { addDays, todayPT } from '../src/analysis/dates.js';
import type {
  Dimension,
  DimensionFilter,
  GscApi,
  SearchAnalyticsRequest,
  SearchAnalyticsResponse,
  Site,
  Sitemap,
  UrlInspectionResult,
} from '../src/gsc/types.js';
import type { FetchedPage, PageFetcher } from '../src/onpage/fetch.js';

export interface Fact {
  date: string;
  query: string;
  page: string;
  country: string;
  device: string;
  clicks: number;
  impressions: number;
  position: number;
}

/** In-memory Search Console: aggregates facts the way the real API does for the dimensions and filters used here. */
export class FakeGsc implements GscApi {
  calls: { method: string; args: unknown[] }[] = [];
  submitted: string[] = [];
  deleted: string[] = [];

  constructor(
    public facts: Fact[],
    public sites: Site[] = [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }],
    public sitemaps: Sitemap[] = [],
    public inspections: Record<string, UrlInspectionResult> = {},
  ) {}

  async listSites(): Promise<Site[]> {
    this.calls.push({ method: 'listSites', args: [] });
    return this.sites;
  }

  async searchAnalytics(siteUrl: string, request: SearchAnalyticsRequest): Promise<SearchAnalyticsResponse> {
    this.calls.push({ method: 'searchAnalytics', args: [siteUrl, request] });
    const filters = request.dimensionFilterGroups?.flatMap((g) => g.filters) ?? [];
    const dims = request.dimensions ?? [];
    const groups = new Map<string, { keys: string[]; clicks: number; impressions: number; weighted: number }>();
    for (const fact of this.facts) {
      if (fact.date < request.startDate || fact.date > request.endDate) continue;
      if (!filters.every((f) => matches(fact, f))) continue;
      const keys = dims.map((d) => String(fact[d as keyof Fact]));
      const id = keys.join('\u0000');
      const group = groups.get(id) ?? { keys, clicks: 0, impressions: 0, weighted: 0 };
      group.clicks += fact.clicks;
      group.impressions += fact.impressions;
      group.weighted += fact.position * fact.impressions;
      groups.set(id, group);
    }
    let rows = [...groups.values()]
      .filter((g) => g.impressions > 0)
      .map((g) => ({
        ...(dims.length ? { keys: g.keys } : {}),
        clicks: g.clicks,
        impressions: g.impressions,
        ctr: g.clicks / g.impressions,
        position: g.weighted / g.impressions,
      }));
    rows = dims.includes('date' as Dimension)
      ? rows.sort((a, b) => a.keys![0]!.localeCompare(b.keys![0]!))
      : rows.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    const start = request.startRow ?? 0;
    return { rows: rows.slice(start, start + (request.rowLimit ?? 1000)), responseAggregationType: 'byProperty' };
  }

  async inspectUrl(siteUrl: string, inspectionUrl: string): Promise<UrlInspectionResult> {
    this.calls.push({ method: 'inspectUrl', args: [siteUrl, inspectionUrl] });
    return (
      this.inspections[inspectionUrl] ?? {
        inspectionResultLink: `https://search.google.com/search-console/inspect?url=${encodeURIComponent(inspectionUrl)}`,
        indexStatusResult: {
          verdict: 'PASS',
          coverageState: 'Submitted and indexed',
          robotsTxtState: 'ALLOWED',
          indexingState: 'INDEXING_ALLOWED',
          pageFetchState: 'SUCCESSFUL',
          googleCanonical: inspectionUrl,
          userCanonical: inspectionUrl,
          crawledAs: 'MOBILE',
          lastCrawlTime: '2026-11-01T10:00:00Z',
        },
      }
    );
  }

  async listSitemaps(siteUrl: string): Promise<Sitemap[]> {
    this.calls.push({ method: 'listSitemaps', args: [siteUrl] });
    return this.sitemaps;
  }

  async submitSitemap(siteUrl: string, feedpath: string): Promise<void> {
    this.calls.push({ method: 'submitSitemap', args: [siteUrl, feedpath] });
    this.submitted.push(feedpath);
  }

  async deleteSitemap(siteUrl: string, feedpath: string): Promise<void> {
    this.calls.push({ method: 'deleteSitemap', args: [siteUrl, feedpath] });
    this.deleted.push(feedpath);
  }
}

function matches(fact: Fact, filter: DimensionFilter): boolean {
  const value = String(fact[filter.dimension as keyof Fact]);
  const expression = filter.expression;
  switch (filter.operator ?? 'equals') {
    case 'equals':
      return value === expression;
    case 'notEquals':
      return value !== expression;
    case 'contains':
      return value.includes(expression);
    case 'notContains':
      return !value.includes(expression);
    case 'includingRegex':
      return re2(expression).test(value);
    case 'excludingRegex':
      return !re2(expression).test(value);
  }
}

function re2(expression: string): RegExp {
  return expression.startsWith('(?i)') ? new RegExp(expression.slice(4), 'i') : new RegExp(expression);
}

export const SITE = 'https://example.com';

interface Spec {
  query: string;
  page: string;
  impressions: number;
  clicks: number;
  position: number;
  /** Multiplier applied in the previous period (default 1). */
  previous?: number;
  device?: string;
}

/** 28 days of current data ending on the latest final day, plus 28 previous days and a year-ago copy. */
export function buildFacts(specs: Spec[] = DEFAULT_SPECS, latest = addDays(todayPT(), -3)): Fact[] {
  const facts: Fact[] = [];
  const periods: { offset: number; factor: (s: Spec) => number }[] = [
    { offset: 0, factor: () => 1 },
    { offset: -28, factor: (s) => s.previous ?? 1 },
    { offset: -364, factor: (s) => s.previous ?? 1 },
  ];
  for (const { offset, factor } of periods) {
    for (let day = 0; day < 28; day++) {
      const date = addDays(latest, offset - day);
      for (const spec of specs) {
        const f = factor(spec);
        if (f === 0) continue;
        facts.push({
          date,
          query: spec.query,
          page: spec.page,
          country: 'usa',
          device: spec.device ?? 'MOBILE',
          clicks: Math.round((spec.clicks * f) / 28),
          impressions: Math.round((spec.impressions * f) / 28),
          position: spec.position,
        });
      }
    }
  }
  return facts;
}

export const DEFAULT_SPECS: Spec[] = [
  // Branded, ranking first.
  { query: 'acme', page: `${SITE}/`, impressions: 5600, clicks: 2800, position: 1.1 },
  { query: 'acme pricing', page: `${SITE}/pricing`, impressions: 1400, clicks: 560, position: 1.3 },
  // Striking distance.
  { query: 'seo audit tool', page: `${SITE}/features`, impressions: 8400, clicks: 112, position: 8.4 },
  { query: 'keyword tracker', page: `${SITE}/features`, impressions: 2800, clicks: 28, position: 12.2 },
  // Ranks well, poor CTR.
  { query: 'free seo checker', page: `${SITE}/tools/checker`, impressions: 11200, clicks: 140, position: 2.4 },
  // Cannibalized between two blog posts.
  { query: 'seo tips', page: `${SITE}/blog/seo-tips`, impressions: 2800, clicks: 56, position: 6.2 },
  { query: 'seo tips', page: `${SITE}/blog/seo-guide`, impressions: 2240, clicks: 28, position: 9.1 },
  { query: 'seo tips', page: `${SITE}/blog/seo-guide#:~:text=tips`, impressions: 560, clicks: 0, position: 9.5 },
  // Declining page.
  { query: 'technical seo checklist', page: `${SITE}/blog/technical-seo`, impressions: 1400, clicks: 56, position: 7.5, previous: 3 },
  // New page this period.
  { query: 'ai overviews seo', page: `${SITE}/blog/ai-overviews`, impressions: 840, clicks: 28, position: 5.5, previous: 0 },
  // Filler queries so the site CTR curve has enough samples.
  ...Array.from({ length: 30 }, (_, i) => ({
    query: `long tail ${i}`,
    page: `${SITE}/blog/post-${i % 5}`,
    impressions: 280 + i * 28,
    clicks: Math.max(0, Math.round((280 + i * 28) * (0.12 / (1 + (i % 10))))),
    position: 1 + (i % 10),
  })),
];

export function htmlPage(url: string, body: string, init: Partial<FetchedPage> = {}): FetchedPage {
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    redirects: [],
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body,
    truncated: false,
    responseTimeMs: 42,
    ...init,
  };
}

export function fakeFetcher(pages: Record<string, FetchedPage | string>): PageFetcher {
  return async (url) => {
    const page = pages[url];
    if (page === undefined) throw new Error(`No fixture for ${url}`);
    return typeof page === 'string' ? htmlPage(url, page) : page;
  };
}
