import { describe, expect, it } from 'vitest';
import type { TokenSource } from '../src/auth/provider.js';
import { GscApiError, GscClient } from '../src/gsc/client.js';

const tokenSource: TokenSource = {
  info: { method: 'oauth', account: 'me@example.com', canWrite: false, source: 'test' },
  getRequestHeaders: async () => ({ authorization: 'Bearer token-123' }),
};

function client(responses: Response[], calls: { url: string; init: RequestInit }[] = []) {
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  }) as unknown as typeof fetch;
  return new GscClient({ getTokenSource: async () => tokenSource, fetch: fakeFetch, retryDelayMs: 1 });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('GscClient', () => {
  it('encodes the property in the path and sends the bearer token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = client([json({ rows: [{ keys: ['a'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }] })], calls);
    const result = await api.searchAnalytics('sc-domain:example.com', { startDate: '2026-01-01', endDate: '2026-01-31', dimensions: ['query'] });
    expect(result.rows).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer token-123');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ dimensions: ['query'] });
  });

  it('handles empty bodies and list endpoints', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = client([json({}), new Response(null, { status: 204 }), json({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } })], calls);
    expect(await api.listSites()).toEqual([]);
    await api.submitSitemap('https://www.example.com/', 'https://www.example.com/sitemap.xml');
    expect(calls[1]!.url).toBe(
      'https://searchconsole.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F/sitemaps/https%3A%2F%2Fwww.example.com%2Fsitemap.xml',
    );
    expect(calls[1]!.init.method).toBe('PUT');
    const inspection = await api.inspectUrl('sc-domain:example.com', 'https://example.com/a');
    expect(inspection.indexStatusResult?.verdict).toBe('PASS');
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ inspectionUrl: 'https://example.com/a', siteUrl: 'sc-domain:example.com' });
  });

  it('names the right quota in rate-limit errors', async () => {
    const api = new GscClient({
      getTokenSource: async () => tokenSource,
      fetch: (async () => json({ error: { message: 'Quota exceeded' } }, 429)) as unknown as typeof fetch,
      maxRetries: 0,
    });
    await expect(api.searchAnalytics('s', { startDate: '2026-01-01', endDate: '2026-01-02' })).rejects.toThrow(/Search Analytics allows/);
    await expect(api.inspectUrl('s', 'https://x.com/')).rejects.toThrow(/2,000 inspections/);
  });

  it('retries network failures and then gives a clear error', async () => {
    let calls = 0;
    const api = new GscClient({
      getTokenSource: async () => tokenSource,
      fetch: (async () => {
        calls++;
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      retryDelayMs: 1,
      maxRetries: 2,
    });
    await expect(api.listSites()).rejects.toThrow(/Could not reach the Search Console API/);
    expect(calls).toBe(3);
  });

  it('retries rate limits and server errors', async () => {
    const api = client([json({ error: { message: 'busy' } }, 429), json({ error: { message: 'oops' } }, 503), json({ siteEntry: [{ siteUrl: 'x', permissionLevel: 'siteOwner' }] })]);
    expect(await api.listSites()).toHaveLength(1);
  });

  it('explains common API errors', async () => {
    const disabled = client([
      json(
        {
          error: {
            code: 403,
            message: 'Google Search Console API has not been used in project 123 before or it is disabled.',
            status: 'PERMISSION_DENIED',
            details: [{ reason: 'SERVICE_DISABLED', metadata: { activationUrl: 'https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=123' } }],
          },
        },
        403,
      ),
    ]);
    await expect(disabled.listSites()).rejects.toThrow(/not enabled.*project=123/);

    const noAccess = client([json({ error: { code: 403, message: "User does not have sufficient permission for site 'sc-domain:x.com'." } }, 403)]);
    const error = await noAccess.listSitemaps('sc-domain:x.com').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GscApiError);
    expect((error as GscApiError).message).toMatch(/me@example.com.*does not have sufficient access to "sc-domain:x.com".*list_sites/);

    const scope = client([json({ error: { code: 403, message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, 403)]);
    await expect(scope.submitSitemap('sc-domain:x.com', 'https://x.com/s.xml')).rejects.toThrow(/write=true|--write/);

    const readScope = client([json({ error: { code: 403, message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, 403)]);
    await expect(readScope.listSites()).rejects.toThrow(/do not grant Search Console access/);
  });
});
