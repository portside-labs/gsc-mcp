import { parse, type HTMLElement } from 'node-html-parser';
import type { FetchedPage } from './fetch.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: Severity;
  message: string;
}

export interface PageAudit {
  url: string;
  finalUrl: string;
  status: number;
  redirects: { url: string; status: number }[];
  responseTimeMs: number;
  contentType?: string;
  xRobotsTag?: string;
  title?: string;
  titleLength: number;
  metaDescription?: string;
  metaDescriptionLength: number;
  canonical?: string;
  metaRobots?: string;
  lang?: string;
  hasViewport: boolean;
  h1: string[];
  h2: string[];
  wordCount: number;
  images: { total: number; missingAlt: number };
  links: { internal: number; external: number; nofollow: number };
  hreflang: { lang: string; href: string }[];
  openGraph: { title?: string; description?: string; image?: string; type?: string };
  twitterCard?: string;
  structuredData: { types: string[]; invalidBlocks: number };
  issues: Issue[];
}

const MAX_HEADINGS = 15;

export function auditHtml(page: FetchedPage): PageAudit {
  const root = parse(page.body, {
    comment: false,
    blockTextElements: { script: true, style: true, noscript: true, pre: true, template: true },
  });
  const base = new URL(page.finalUrl);
  const attr = (selector: string, name: string) => clean(root.querySelector(selector)?.getAttribute(name));
  const meta = (key: string) =>
    clean(
      root
        .querySelectorAll('meta')
        .find((m) => (m.getAttribute('name') ?? m.getAttribute('property'))?.toLowerCase() === key)
        ?.getAttribute('content'),
    );

  const title = clean(root.querySelector('title')?.text);
  const metaDescription = meta('description');
  const canonicals = root.querySelectorAll('link').filter((l) => relIncludes(l, 'canonical'));
  const canonicalHref = clean(canonicals[0]?.getAttribute('href'));
  const canonical = canonicalHref ? absolute(canonicalHref, base) : undefined;
  const metaRobots =
    root
      .querySelectorAll('meta')
      .filter((m) => ['robots', 'googlebot'].includes((m.getAttribute('name') ?? '').toLowerCase()))
      .map((m) => clean(m.getAttribute('content')))
      .filter(Boolean)
      .join(', ') || undefined;

  const structuredData = readJsonLd(root);
  const images = root.querySelectorAll('img');
  const links = readLinks(root, base);
  const scriptCount = root.querySelectorAll('script').length;

  for (const el of root.querySelectorAll('script, style, noscript, template, svg')) el.remove();
  // structuredText puts block elements on separate lines; .text would run "<p>a</p><p>b</p>" together.
  const bodyText = (root.querySelector('body') ?? root).structuredText.replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(' ').length : 0;

  const audit: PageAudit = {
    url: page.requestedUrl,
    finalUrl: page.finalUrl,
    status: page.status,
    redirects: page.redirects,
    responseTimeMs: page.responseTimeMs,
    contentType: page.headers['content-type'],
    xRobotsTag: page.headers['x-robots-tag'],
    title,
    titleLength: title?.length ?? 0,
    metaDescription,
    metaDescriptionLength: metaDescription?.length ?? 0,
    canonical,
    metaRobots,
    lang: attr('html', 'lang'),
    hasViewport: !!meta('viewport'),
    h1: headings(root, 'h1'),
    h2: headings(root, 'h2'),
    wordCount,
    images: { total: images.length, missingAlt: images.filter((img) => img.getAttribute('alt') === undefined).length },
    links,
    hreflang: root
      .querySelectorAll('link')
      .filter((l) => relIncludes(l, 'alternate') && l.getAttribute('hreflang'))
      .map((l) => ({ lang: l.getAttribute('hreflang')!, href: absolute(l.getAttribute('href') ?? '', base) })),
    openGraph: { title: meta('og:title'), description: meta('og:description'), image: meta('og:image'), type: meta('og:type') },
    twitterCard: meta('twitter:card'),
    structuredData,
    issues: [],
  };
  audit.issues = findIssues(audit, { canonicalCount: canonicals.length, scriptCount, truncated: page.truncated });
  return audit;
}

function findIssues(a: PageAudit, extra: { canonicalCount: number; scriptCount: number; truncated: boolean }): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Severity, message: string) => issues.push({ severity, message });

  if (a.status >= 400) add('error', `Page returned HTTP ${a.status}.`);
  else if (a.status !== 200) add('warning', `Page returned HTTP ${a.status}.`);
  if (a.redirects.length > 1) add('warning', `Redirect chain of ${a.redirects.length} hops before the final URL. Link to ${a.finalUrl} directly.`);
  else if (a.redirects.length === 1) add('info', `URL redirects (${a.redirects[0]!.status}) to ${a.finalUrl}.`);

  const header = googleDirectives(a.xRobotsTag);
  const metaDirectives = googleDirectives(a.metaRobots);
  if (header.has('noindex') || header.has('none')) add('error', `X-Robots-Tag header blocks indexing: "${a.xRobotsTag}".`);
  if (metaDirectives.has('noindex') || metaDirectives.has('none')) add('error', `Meta robots blocks indexing: "${a.metaRobots}".`);
  if (metaDirectives.has('nofollow') || header.has('nofollow')) add('warning', 'Robots directives include nofollow, so links on this page pass no signals.');

  if (!a.title) add('error', 'Missing <title>.');
  else if (a.titleLength < 30) add('warning', `Title is short (${a.titleLength} chars). Aim for roughly 30-60 characters that include the main query.`);
  else if (a.titleLength > 60) add('warning', `Title is ${a.titleLength} chars and will likely be truncated in results (about 60 fit).`);

  if (!a.metaDescription) add('warning', 'Missing meta description. Google will pick a snippet from the page.');
  else if (a.metaDescriptionLength < 70) add('info', `Meta description is short (${a.metaDescriptionLength} chars).`);
  else if (a.metaDescriptionLength > 160) add('info', `Meta description is ${a.metaDescriptionLength} chars and may be truncated (about 155-160 fit).`);

  if (a.h1.length === 0) add('warning', 'No <h1> heading.');
  else if (a.h1.length > 1) add('info', `${a.h1.length} <h1> headings. One clear H1 is usually best.`);

  if (extra.canonicalCount > 1) add('error', `${extra.canonicalCount} canonical tags. Google may ignore all of them.`);
  if (!a.canonical) add('warning', 'No canonical tag.');
  else if (stripTrailing(a.canonical) !== stripTrailing(a.finalUrl)) {
    add('warning', `Canonical points to a different URL (${a.canonical}), so this URL is unlikely to be indexed itself.`);
  }

  if (!a.hasViewport) add('warning', 'No viewport meta tag, so the page may not be mobile-friendly.');
  if (!a.lang) add('info', 'No lang attribute on <html>.');

  if (a.wordCount < 50 && extra.scriptCount > 5) {
    add('warning', `Only ${a.wordCount} words in the HTML but ${extra.scriptCount} scripts: content is probably rendered client-side. Check the rendered HTML with URL Inspection.`);
  } else if (a.wordCount < 250) {
    add('warning', `Thin content: about ${a.wordCount} words of visible text.`);
  }

  if (a.images.missingAlt > 0) add('warning', `${a.images.missingAlt} of ${a.images.total} images have no alt attribute.`);
  if (a.structuredData.invalidBlocks > 0) add('warning', `${a.structuredData.invalidBlocks} JSON-LD block(s) failed to parse.`);
  if (a.structuredData.types.length === 0) add('info', 'No JSON-LD structured data found.');
  if (!a.openGraph.title || !a.openGraph.image) add('info', 'Missing og:title or og:image, so shared links will look plain.');
  if (extra.truncated) add('info', 'Page HTML was larger than 5 MB; only the first 5 MB was analysed.');
  return issues;
}

const VALUED_DIRECTIVES = new Set(['max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after']);

/**
 * Robots directives that apply to Googlebot. X-Robots-Tag values can be scoped to a crawler
 * ("otherbot: noindex, nofollow"), and the scope carries over to the following directives.
 */
export function googleDirectives(value: string | undefined): Set<string> {
  const applies = new Set<string>();
  let agent: string | undefined;
  for (const raw of (value ?? '').split(',')) {
    let token = raw.trim().toLowerCase();
    const scoped = token.match(/^([a-z0-9_-]+)\s*:\s*(.*)$/);
    if (scoped && !VALUED_DIRECTIVES.has(scoped[1]!)) {
      agent = scoped[1];
      token = scoped[2]!.trim();
    }
    if (token && (agent === undefined || agent === 'googlebot')) applies.add(token.split(':')[0]!.trim());
  }
  return applies;
}

function readJsonLd(root: HTMLElement): PageAudit['structuredData'] {
  const types = new Set<string>();
  let invalidBlocks = 0;
  for (const script of root.querySelectorAll('script')) {
    if (script.getAttribute('type')?.toLowerCase() !== 'application/ld+json') continue;
    try {
      collectTypes(JSON.parse(script.rawText), types);
    } catch {
      invalidBlocks++;
    }
  }
  return { types: [...types], invalidBlocks };
}

function collectTypes(node: unknown, types: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, types);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const type = obj['@type'];
  if (typeof type === 'string') types.add(type);
  else if (Array.isArray(type)) for (const t of type) if (typeof t === 'string') types.add(t);
  if (obj['@graph']) collectTypes(obj['@graph'], types);
}

function readLinks(root: HTMLElement, base: URL): PageAudit['links'] {
  let internal = 0;
  let external = 0;
  let nofollow = 0;
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')!.trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    let target: URL;
    try {
      target = new URL(href, base);
    } catch {
      continue;
    }
    if (target.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '')) internal++;
    else external++;
    if (/nofollow/i.test(a.getAttribute('rel') ?? '')) nofollow++;
  }
  return { internal, external, nofollow };
}

function headings(root: HTMLElement, tag: string): string[] {
  return root
    .querySelectorAll(tag)
    .map((h) => clean(h.text))
    .filter((t): t is string => !!t)
    .slice(0, MAX_HEADINGS);
}

function relIncludes(el: HTMLElement, value: string): boolean {
  return (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes(value);
}

function absolute(href: string, base: URL): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/** node-html-parser already decodes entities in .text and getAttribute(). */
function clean(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function stripTrailing(url: string): string {
  return url.replace(/#.*$/, '').replace(/\/$/, '');
}

const STOPWORDS = new Set(
  'a an and are as at be by for from how i in is it of on or the to vs what when where which who why with your you my me do does can best near'.split(' '),
);

export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

export interface QueryCoverage {
  query: string;
  /** Share of the query's meaningful words found in each element (0..1). */
  title: number;
  h1: number;
  metaDescription: number;
}

/** How well the page's key elements mention the words of each query it ranks for. */
export function queryCoverage(queries: string[], audit: PageAudit): QueryCoverage[] {
  const titleTerms = new Set(terms(audit.title ?? ''));
  const h1Terms = new Set(terms(audit.h1.join(' ')));
  const descTerms = new Set(terms(audit.metaDescription ?? ''));
  return queries.map((query) => {
    const words = [...new Set(terms(query))];
    const share = (set: Set<string>) => (words.length ? words.filter((w) => set.has(w)).length / words.length : 1);
    return { query, title: share(titleTerms), h1: share(h1Terms), metaDescription: share(descTerms) };
  });
}
