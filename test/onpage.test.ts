import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { auditHtml, googleDirectives, queryCoverage, terms } from '../src/onpage/audit.js';
import { fetchPage, guardedLookup, isPrivateAddress, nodeTransport, type RawResponse, type Transport } from '../src/onpage/fetch.js';
import { htmlPage } from './fakes.js';

const GOOD = `<!doctype html>
<html lang="en">
<head>
  <title>SEO Audit Tool for Landing Pages &amp; Websites | Acme</title>
  <meta name="description" content="Run a free SEO audit on any landing page. Find title, meta description, canonical and indexing problems in seconds, then fix them.">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="canonical" href="/features">
  <link rel="alternate" hreflang="de" href="https://example.com/de/features">
  <meta property="og:title" content="Acme SEO Audit">
  <meta property="og:image" content="https://example.com/og.png">
  <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["SoftwareApplication","Product"]}]}</script>
  <script type="application/ld+json">{ not json </script>
</head>
<body>
  <h1>SEO audit tool</h1>
  <h2>Why audit landing pages?</h2>
  <p>${'Search engines reward pages that answer intent clearly. '.repeat(40)}</p>
  <img src="a.png" alt="Dashboard"><img src="b.png">
  <a href="/pricing">Pricing</a> <a href="https://www.example.com/blog">Blog</a>
  <a href="https://twitter.com/acme" rel="nofollow noopener">Twitter</a> <a href="#top">Top</a> <a href="mailto:hi@example.com">Mail</a>
  <script>console.log("not counted as words")</script>
</body>
</html>`;

describe('auditHtml', () => {
  const audit = auditHtml(htmlPage('https://example.com/features', GOOD));

  it('extracts the main SEO elements', () => {
    expect(audit.title).toBe('SEO Audit Tool for Landing Pages & Websites | Acme');
    expect(audit.titleLength).toBe(50);
    expect(audit.metaDescription).toMatch(/^Run a free SEO audit/);
    expect(audit.canonical).toBe('https://example.com/features');
    expect(audit.lang).toBe('en');
    expect(audit.hasViewport).toBe(true);
    expect(audit.h1).toEqual(['SEO audit tool']);
    expect(audit.h2).toEqual(['Why audit landing pages?']);
    expect(audit.hreflang).toEqual([{ lang: 'de', href: 'https://example.com/de/features' }]);
    expect(audit.openGraph).toMatchObject({ title: 'Acme SEO Audit', image: 'https://example.com/og.png' });
    expect(audit.structuredData).toEqual({ types: ['Organization', 'SoftwareApplication', 'Product'], invalidBlocks: 1 });
    expect(audit.images).toEqual({ total: 2, missingAlt: 1 });
    expect(audit.links).toEqual({ internal: 2, external: 1, nofollow: 1 });
    expect(audit.wordCount).toBeGreaterThan(300);
  });

  it('reports only the real problems', () => {
    expect(audit.issues.map((i) => i.message)).toEqual([
      '1 of 2 images have no alt attribute.',
      '1 JSON-LD block(s) failed to parse.',
    ]);
  });

  it('flags indexing blockers and missing basics', () => {
    const bad = auditHtml(
      htmlPage(
        'https://example.com/old',
        '<html><head><meta name="robots" content="noindex, nofollow"><link rel="canonical" href="https://example.com/new"></head><body><div id="root"></div>' +
          '<script src=1></script><script src=2></script><script src=3></script><script src=4></script><script src=5></script><script src=6></script></body></html>',
        { redirects: [{ url: 'http://example.com/old', status: 301 }], headers: { 'x-robots-tag': 'noindex' } },
      ),
    );
    const messages = bad.issues.map((i) => `${i.severity}: ${i.message}`);
    expect(messages).toContain('error: Missing <title>.');
    expect(messages).toContain('error: X-Robots-Tag header blocks indexing: "noindex".');
    expect(messages).toContain('error: Meta robots blocks indexing: "noindex, nofollow".');
    expect(messages.some((m) => m.startsWith('warning: Canonical points to a different URL'))).toBe(true);
    expect(messages.some((m) => m.includes('rendered client-side'))).toBe(true);
    expect(messages).toContain('info: URL redirects (301) to https://example.com/old.');
  });
});

describe('query coverage', () => {
  it('normalizes words, drops stopwords and handles plurals', () => {
    expect(terms('Best SEO tools for Landing-Pages')).toEqual(['seo', 'tool', 'landing', 'page']);
  });

  it('measures how many query words appear in each element', () => {
    const audit = auditHtml(htmlPage('https://example.com/features', GOOD));
    const [full, partial] = queryCoverage(['seo audit tools', 'landing page checker'], audit);
    expect(full).toMatchObject({ title: 1, h1: 1 });
    expect(full!.metaDescription).toBeCloseTo(2 / 3);
    expect(partial!.title).toBeCloseTo(2 / 3);
    expect(partial!.h1).toBe(0);
  });
});

describe('fetchPage', () => {
  it('detects private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0', '64:ff9b::7f00:1', '192.0.0.8', '250.1.1.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.215.14', '8.8.8.8', '2606:4700::6810:84e5']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('blocks local URLs unless allowed', async () => {
    await expect(fetchPage('http://localhost:3000/')).rejects.toThrow(/private or local/);
    await expect(fetchPage('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private or local/);
    await expect(fetchPage('file:///etc/passwd')).rejects.toThrow(/Only http and https/);
  });

  it('follows redirects manually and records the chain', async () => {
    const seen: string[] = [];
    const transport: Transport = async (url) => {
      seen.push(url.href);
      if (url.pathname === '/a') return raw(301, '', { location: '/b' });
      if (url.pathname === '/b') return raw(302, '', { location: 'http://127.0.0.1/c' });
      return raw(200, '<title>C</title>', { 'content-type': 'text/html' });
    };
    const page = await fetchPage('http://127.0.0.1/a', { transport, allowPrivate: true });
    expect(seen).toEqual(['http://127.0.0.1/a', 'http://127.0.0.1/b', 'http://127.0.0.1/c']);
    expect(page.finalUrl).toBe('http://127.0.0.1/c');
    expect(page.redirects).toEqual([
      { url: 'http://127.0.0.1/a', status: 301 },
      { url: 'http://127.0.0.1/b', status: 302 },
    ]);
    expect(page.body).toBe('<title>C</title>');
  });

  it('re-checks every redirect hop against the private network block', async () => {
    const transport: Transport = async () => raw(302, '', { location: 'http://169.254.169.254/latest/meta-data' });
    await expect(fetchPage('https://93.184.215.14/', { transport })).rejects.toThrow(/private or local/);
  });

  it('truncates very large bodies', async () => {
    const page = await fetchPage('http://127.0.0.1/', { transport: async () => raw(200, 'x'.repeat(5000)), allowPrivate: true, maxBytes: 1000 });
    expect(page.truncated).toBe(true);
    expect(page.body).toHaveLength(1000);
  });

  it('refuses private DNS answers at connect time (DNS rebinding)', async () => {
    const error = await new Promise<Error | null>((resolve) => guardedLookup('localhost', {}, (e) => resolve(e)));
    expect(error?.message).toMatch(/private or local network address/);
  });

  it('decodes gzip, deflate and non-UTF-8 pages over real HTTP', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/gzip') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
        res.end(gzipSync('<title>Grüße</title>'));
      } else if (req.url === '/latin1') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(Buffer.concat([Buffer.from('<meta charset="windows-1252"><title>Caf'), Buffer.from([0xe9]), Buffer.from('</title>')]));
      } else if (req.url === '/sitemap.xml.gz') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(gzipSync('<urlset><url><loc>https://example.com/</loc></url></urlset>'));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetchPage(`${base}/gzip`, { allowPrivate: true })).body).toBe('<title>Grüße</title>');
      expect((await fetchPage(`${base}/latin1`, { allowPrivate: true })).body).toContain('Café');
      expect((await fetchPage(`${base}/sitemap.xml.gz`, { allowPrivate: true })).body).toContain('<loc>https://example.com/</loc>');
      await expect(fetchPage(`${base}/gzip`)).rejects.toThrow(/private or local/);
      // Skip fetchPage's up-front check: the connection itself must still refuse a private answer.
      const viaHostname = new URL(`${base}/gzip`.replace('127.0.0.1', 'localhost'));
      await expect(nodeTransport(viaHostname, { allowPrivate: false, signal: AbortSignal.timeout(5000), headers: {} })).rejects.toThrow(/private or local/);
    } finally {
      server.close();
    }
  });
});

describe('robots directives', () => {
  it('only applies directives meant for Googlebot', () => {
    expect([...googleDirectives('noindex, nofollow')]).toEqual(['noindex', 'nofollow']);
    expect(googleDirectives('otherbot: noindex, nofollow').size).toBe(0);
    expect([...googleDirectives('otherbot: noindex, googlebot: nofollow')]).toEqual(['nofollow']);
    expect([...googleDirectives('max-snippet: 20, noindex')]).toEqual(['max-snippet', 'noindex']);
  });

  it('reads every robots meta tag and counts words across minified blocks', () => {
    const body = Array.from({ length: 300 }, (_, i) => `<p>word${i}</p>`).join('');
    const audit = auditHtml(
      htmlPage('https://example.com/', `<html><head><meta name="robots" content="index"><meta name="robots" content="noindex"></head><body>${body}</body></html>`, {
        headers: { 'x-robots-tag': 'otherbot: noindex' },
      }),
    );
    expect(audit.wordCount).toBe(300);
    const messages = audit.issues.map((i) => i.message);
    expect(messages).toContain('Meta robots blocks indexing: "index, noindex".');
    expect(messages.some((m) => m.startsWith('X-Robots-Tag'))).toBe(false);
  });
});

function raw(status: number, body: string, headers: Record<string, string> = {}): RawResponse {
  return {
    status,
    headers,
    body: (async function* () {
      yield new TextEncoder().encode(body);
    })(),
    destroy: () => {},
  };
}
