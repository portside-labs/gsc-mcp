import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthManager } from '../src/auth/provider.js';
import { addDays, todayPT } from '../src/analysis/dates.js';
import { createContext, createServer } from '../src/server.js';
import { buildFacts, fakeFetcher, FakeGsc, htmlPage, SITE } from './fakes.js';

const LATEST = addDays(todayPT(), -3);

const fakeAuth = {
  credentialsPath: '/tmp/credentials.json',
  status: async () => ({ method: 'oauth' as const, account: 'me@example.com', canWrite: true, source: '/tmp/credentials.json' }),
  oauthClientConfig: async () => ({ clientId: 'cid' }),
  startLogin: async () => {
    throw new Error('not in tests');
  },
} as unknown as AuthManager;

const LANDING = `<!doctype html><html lang="en"><head>
<title>Features | Acme</title>
<meta name="description" content="Everything Acme does.">
<link rel="canonical" href="${SITE}/features">
<meta name="viewport" content="width=device-width">
</head><body><h1>Features</h1><p>${'Acme helps teams rank. '.repeat(80)}</p></body></html>`;

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(options: { env?: NodeJS.ProcessEnv; api?: FakeGsc } = {}) {
  const api = options.api ?? new FakeGsc(buildFacts(), undefined, [
    {
      path: `${SITE}/sitemap.xml`,
      type: 'sitemap',
      lastSubmitted: '2026-11-01T00:00:00Z',
      lastDownloaded: '2026-11-08T00:00:00Z',
      isPending: false,
      errors: '0',
      warnings: '2',
      contents: [{ type: 'web', submitted: '42', indexed: '0' }],
    },
  ]);
  const context = createContext({
    env: options.env ?? {},
    api,
    auth: fakeAuth,
    fetchPage: fakeFetcher({
      [`${SITE}/features`]: LANDING,
      [`${SITE}/sitemap.xml`]: htmlPage(
        `${SITE}/sitemap.xml`,
        `<?xml version="1.0"?><sitemapindex><sitemap><loc>${SITE}/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
      ),
      [`${SITE}/robots.txt`]: htmlPage(`${SITE}/robots.txt`, `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\nsitemap: ${SITE}/sitemap-news.xml\n`),
      [`${SITE}/sitemap-pages.xml`]: htmlPage(
        `${SITE}/sitemap-pages.xml`,
        `<urlset><url><loc>${SITE}/</loc></url><url><loc><![CDATA[${SITE}/pricing]]></loc></url><url><loc>${SITE}/a?x=1&amp;y=2</loc></url></urlset>`,
      ),
    }),
  });
  const server = createServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, api };
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await c.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]!.text;
  if (result.isError) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe('MCP server', () => {
  it('lists tools with annotations and prompts', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'analyze_page',
        'audit_page',
        'auth_status',
        'compare_periods',
        'delete_sitemap',
        'find_cannibalization',
        'find_ctr_opportunities',
        'find_quick_wins',
        'inspect_urls',
        'list_sitemaps',
        'list_sites',
        'login',
        'performance_summary',
        'search_analytics',
        'submit_sitemap',
      ].sort(),
    );
    expect(tools.find((t) => t.name === 'delete_sitemap')!.annotations).toMatchObject({ destructiveHint: true });
    expect(tools.find((t) => t.name === 'find_quick_wins')!.annotations).toMatchObject({ readOnlyHint: true });
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['seo_audit', 'optimize_page', 'investigate_traffic_drop']);
    const prompt = await client.getPrompt({ name: 'optimize_page', arguments: { url: `${SITE}/features` } });
    expect((prompt.messages[0]!.content as { text: string }).text).toContain('analyze_page');
  });

  it('hides write tools in read-only mode', async () => {
    const { client } = await connect({ env: { GSC_MCP_READ_ONLY: '1' } });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('submit_sitemap');
    expect(names).not.toContain('delete_sitemap');
    expect(names).toContain('list_sitemaps');
  });

  it('reports auth status and sites', async () => {
    const { client } = await connect();
    expect(await call(client, 'auth_status')).toMatchObject({ signedIn: true, account: 'me@example.com', canWrite: true });
    expect(await call(client, 'list_sites')).toEqual({ sites: [{ site: 'sc-domain:example.com', type: 'domain', permission: 'siteOwner' }] });
  });

  it('runs raw search analytics queries with the latest final date', async () => {
    const { client, api } = await connect();
    const result = await call(client, 'search_analytics', {
      site: 'example.com',
      dimensions: ['query'],
      filters: [{ dimension: 'query', operator: 'contains', expression: 'seo' }],
      rowLimit: 3,
    });
    expect(result).toMatchObject({ site: 'sc-domain:example.com', endDate: LATEST, startDate: addDays(LATEST, -27), rowCount: 3, moreRowsAvailable: true });
    expect(result.rows[0]).toEqual({ query: 'free seo checker', clicks: 140, impressions: 11200, ctr: '1.25%', position: 2.4 });
    const request = api.calls.filter((c) => c.method === 'searchAnalytics').at(-1)!.args[1] as Record<string, unknown>;
    expect(request.dimensionFilterGroups).toEqual([{ groupType: 'and', filters: [{ dimension: 'query', operator: 'contains', expression: 'seo' }] }]);
  });

  it('summarizes performance against the previous period', async () => {
    const { client } = await connect();
    const summary = await call(client, 'performance_summary', { top: 3 });
    expect(summary.period).toEqual({ startDate: addDays(LATEST, -27), endDate: LATEST });
    expect(summary.comparisonPeriod).toEqual({ startDate: addDays(LATEST, -55), endDate: addDays(LATEST, -28) });
    expect(summary.totals.current.clicks).toBeGreaterThan(summary.totals.previous.clicks - 200);
    expect(summary.trend).toMatchObject({ granularity: 'day' });
    expect(summary.trend.points).toHaveLength(28);
    expect(summary.topQueries.map((q: { query: string }) => q.query)).toEqual(['acme', 'acme pricing', 'free seo checker']);
    expect(summary.devices[0]).toMatchObject({ device: 'MOBILE', clickShare: '100%' });
  });

  it('finds striking-distance quick wins, excluding brand terms', async () => {
    const { client } = await connect();
    const result = await call(client, 'find_quick_wins', { excludeQueryRegex: '(?i)acme', limit: 5 });
    expect(result.quickWins[0]).toMatchObject({ query: 'seo audit tool', page: `${SITE}/features`, position: 8.4 });
    expect(result.quickWins.every((w: { position: number }) => w.position >= 4 && w.position <= 20)).toBe(true);
    expect(result.ctrModel.source).toMatch(/site|benchmark/);
  });

  it('finds pages with poor CTR for their position', async () => {
    const { client } = await connect();
    const result = await call(client, 'find_ctr_opportunities', { excludeQueryRegex: '(?i)acme' });
    const checker = result.opportunities.find((o: { page: string }) => o.page === `${SITE}/tools/checker`);
    expect(checker).toMatchObject({ position: 2.4, ctr: '1.25%' });
    expect(checker.topQueries[0].query).toBe('free seo checker');

    const byQuery = await call(client, 'find_ctr_opportunities', { by: 'query', excludeQueryRegex: '(?i)acme' });
    expect(byQuery.opportunities[0]).toMatchObject({ query: 'free seo checker', rankingPages: [{ page: `${SITE}/tools/checker` }] });
  });

  it('compares periods', async () => {
    const { client } = await connect();
    const result = await call(client, 'compare_periods', { dimension: 'page' });
    expect(result.declining[0].page).toBe(`${SITE}/blog/technical-seo`);
    expect(result.declining[0].clicks).toMatch(/168 → 56 \(-112\)/);
    expect(result.new.map((n: { page: string }) => n.page)).toContain(`${SITE}/blog/ai-overviews`);
  });

  it('finds keyword cannibalization', async () => {
    const { client } = await connect();
    const result = await call(client, 'find_cannibalization');
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0].query).toBe('seo tips');
    expect(result.queries[0].pages.map((p: { page: string }) => p.page)).toEqual([`${SITE}/blog/seo-tips`, `${SITE}/blog/seo-guide`]);
  });

  it('analyzes a landing page end to end', async () => {
    const { client, api } = await connect();
    const result = await call(client, 'analyze_page', { url: `${SITE}/features` });
    expect(result.site).toBe('sc-domain:example.com');
    expect(result.totals.current).toMatchObject({ clicks: 140, impressions: 11200 });
    expect(result.queries.map((q: { query: string }) => q.query)).toEqual(['seo audit tool', 'keyword tracker']);
    expect(result.queries[0]).toMatchObject({ inTitle: 'none', inH1: 'none' });
    expect(result.strikingDistance).toHaveLength(2);
    expect(result.indexStatus).toMatchObject({ verdict: 'PASS', coverageState: 'Submitted and indexed' });
    expect(result.onPage.issues).toContain('WARNING: Title is short (15 chars). Aim for roughly 30-60 characters that include the main query.');
    expect(api.calls.filter((c) => c.method === 'inspectUrl')).toHaveLength(1);
  });

  it('normalizes page URLs before matching Search Console data', async () => {
    const { client } = await connect();
    const result = await call(client, 'analyze_page', { url: 'https://EXAMPLE.com', includeInspection: false, includeOnPage: false });
    expect(result.url).toBe(`${SITE}/`);
    expect(result.totals.current.impressions).toBeGreaterThan(0);
  });

  it('ends the default range today when fresh data is requested', async () => {
    const { client } = await connect();
    const fresh = await call(client, 'search_analytics', { dataState: 'all' });
    expect(fresh.endDate).toBe(todayPT());
    const hourly = await call(client, 'search_analytics', { dimensions: ['hour'] });
    expect(hourly).toMatchObject({ startDate: addDays(todayPT(), -9), endDate: todayPT() });
  });

  it('suggests the canonical URL when a page has no data', async () => {
    const { client } = await connect();
    const result = await call(client, 'analyze_page', { url: 'https://www.example.com/features', includeInspection: false, includeOnPage: false });
    expect(result.similarPages).toEqual([`${SITE}/features`]);
  });

  it('inspects URLs from a sitemap index', async () => {
    const api = new FakeGsc(buildFacts(), undefined, [], {
      [`${SITE}/pricing`]: {
        indexStatusResult: {
          verdict: 'NEUTRAL',
          coverageState: 'Crawled - currently not indexed',
          googleCanonical: `${SITE}/plans`,
          userCanonical: `${SITE}/pricing`,
        },
      },
    });
    const { client } = await connect({ api });
    const result = await call(client, 'inspect_urls', { sitemapUrl: `${SITE}/sitemap.xml` });
    expect(result.inspected).toBe(3);
    expect(result.results.map((r: { url: string }) => r.url)).toEqual([`${SITE}/`, `${SITE}/pricing`, `${SITE}/a?x=1&y=2`]);
    expect(result.summary).toMatchObject({ indexed: 2, notIndexed: 1, byCoverageState: { 'Submitted and indexed': 2, 'Crawled - currently not indexed': 1 } });
    expect(result.results[1]).toMatchObject({ canonicalMismatch: true });
  });

  it('reports a sitemap with no URLs instead of inspecting nothing', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'inspect_urls', arguments: { sitemapUrl: `${SITE}/features` } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/No <loc> URLs found/);
  });

  it('lists, submits and deletes sitemaps', async () => {
    const { client, api } = await connect();
    const list = await call(client, 'list_sitemaps');
    expect(list.sitemaps[0]).toMatchObject({ path: `${SITE}/sitemap.xml`, warnings: 2, submittedUrls: [{ type: 'web', submitted: 42 }] });
    expect(list.notSubmitted).toEqual([`${SITE}/sitemap-news.xml`]);
    expect(await call(client, 'submit_sitemap', { sitemapUrl: `${SITE}/sitemap-new.xml` })).toContain('Submitted');
    expect(api.submitted).toEqual([`${SITE}/sitemap-new.xml`]);
    await call(client, 'delete_sitemap', { sitemapUrl: `${SITE}/sitemap.xml` });
    expect(api.deleted).toEqual([`${SITE}/sitemap.xml`]);
  });

  it('explains an empty period instead of just reporting zeros', async () => {
    const { client } = await connect({ api: new FakeGsc([]) });
    const summary = await call(client, 'performance_summary');
    expect(summary.note).toMatch(/No final search data .* dataState "all"/);
    expect((await call(client, 'find_quick_wins')).note).toMatch(/No final search data/);
    expect((await call(client, 'compare_periods')).note).toMatch(/No final search data/);
  });

  it('returns readable tool errors', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'performance_summary', arguments: { site: 'unknown.org' } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/No Search Console property matches "unknown.org".*sc-domain:example.com/);
  });
});
