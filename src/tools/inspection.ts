import type { GscApi, UrlInspectionResult } from '../gsc/types.js';
import type { FetchPageOptions, PageFetcher } from '../onpage/fetch.js';

export interface InspectionSummary {
  url: string;
  verdict?: string;
  coverageState?: string;
  indexingState?: string;
  robotsTxtState?: string;
  pageFetchState?: string;
  lastCrawlTime?: string;
  crawledAs?: string;
  googleCanonical?: string;
  userCanonical?: string;
  canonicalMismatch?: boolean;
  inSitemaps?: string[];
  richResults?: { type?: string; items: number; issues: string[] }[];
  link?: string;
  error?: string;
}

export function summarizeInspection(url: string, result: UrlInspectionResult): InspectionSummary {
  const index = result.indexStatusResult ?? {};
  const mismatch = index.googleCanonical && index.userCanonical ? index.googleCanonical !== index.userCanonical : undefined;
  return {
    url,
    verdict: index.verdict,
    coverageState: index.coverageState,
    indexingState: index.indexingState,
    robotsTxtState: index.robotsTxtState,
    pageFetchState: index.pageFetchState,
    lastCrawlTime: index.lastCrawlTime,
    crawledAs: index.crawledAs,
    googleCanonical: index.googleCanonical,
    userCanonical: index.userCanonical,
    ...(mismatch !== undefined ? { canonicalMismatch: mismatch } : {}),
    ...(index.sitemap?.length ? { inSitemaps: index.sitemap } : {}),
    ...(result.richResultsResult?.detectedItems?.length
      ? {
          richResults: result.richResultsResult.detectedItems.map((d) => ({
            type: d.richResultType,
            items: d.items?.length ?? 0,
            issues: (d.items ?? []).flatMap((i) => (i.issues ?? []).map((x) => `${x.severity ?? ''} ${x.issueMessage ?? ''}`.trim())),
          })),
        }
      : {}),
    link: result.inspectionResultLink,
  };
}

/** Runs inspections with limited concurrency; per-URL failures are reported inline rather than failing the batch. */
export async function inspectMany(api: GscApi, site: string, urls: string[], languageCode?: string, concurrency = 4): Promise<InspectionSummary[]> {
  const results: InspectionSummary[] = new Array(urls.length);
  let next = 0;
  let quotaHit: string | undefined;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      const url = urls[i]!;
      if (quotaHit) {
        results[i] = { url, error: quotaHit };
        continue;
      }
      try {
        results[i] = summarizeInspection(url, await api.inspectUrl(site, url, languageCode));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/quota/i.test(message)) quotaHit = message;
        results[i] = { url, error: message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}

/** Reads <loc> URLs from a sitemap, following up to a few child sitemaps of a sitemap index. */
export async function sitemapUrls(fetchPage: PageFetcher, sitemapUrl: string, limit: number, options: FetchPageOptions): Promise<string[]> {
  const urls: string[] = [];
  const queue = [sitemapUrl];
  let fetched = 0;
  while (queue.length && urls.length < limit && fetched < 10) {
    const page = await fetchPage(queue.shift()!, options);
    fetched++;
    if (page.status >= 400) throw new Error(`Sitemap ${page.finalUrl} returned HTTP ${page.status}.`);
    const locs = [...page.body.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeXml(m[1]!));
    if (/<sitemapindex[\s>]/i.test(page.body)) queue.push(...locs);
    else urls.push(...locs);
  }
  return urls.slice(0, limit);
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
