import type { GscApi, Site } from './types.js';

const SITE_TTL_MS = 5 * 60_000;

/** Caches the property list and turns loose input ("example.com", a page URL) into an exact property name. */
export class SiteDirectory {
  private cache?: { at: number; sites: Site[] };

  constructor(
    private readonly api: GscApi,
    private readonly defaultSite?: string,
  ) {}

  async list(refresh = false): Promise<Site[]> {
    if (!refresh && this.cache && Date.now() - this.cache.at < SITE_TTL_MS) return this.cache.sites;
    const sites = await this.api.listSites();
    this.cache = { at: Date.now(), sites };
    return sites;
  }

  async resolve(input: string | undefined): Promise<string> {
    const sites = await this.list();
    try {
      return resolveSite(input, sites, this.defaultSite);
    } catch (error) {
      // The property may have been added since the list was cached.
      if (this.cache && Date.now() - this.cache.at > 10_000) return resolveSite(input, await this.list(true), this.defaultSite);
      throw error;
    }
  }
}

export function resolveSite(input: string | undefined, sites: Site[], defaultSite?: string): string {
  const usable = sites.filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
  const wanted = input?.trim() || defaultSite;

  if (!wanted) {
    if (usable.length === 1) return usable[0]!.siteUrl;
    throw new Error(
      usable.length === 0
        ? 'This Google account has no verified Search Console properties.'
        : `Specify which property to use with \`site\`. Available: ${usable.map((s) => s.siteUrl).join(', ')}`,
    );
  }

  const exact = usable.find((s) => s.siteUrl === wanted);
  if (exact) return exact.siteUrl;

  if (wanted.toLowerCase().startsWith('sc-domain:')) {
    const domain = usable.find((s) => s.siteUrl.toLowerCase() === wanted.toLowerCase());
    if (domain) return domain.siteUrl;
    throw notFound(wanted, usable);
  }

  const hasScheme = /^https?:\/\//i.test(wanted);
  let url: URL;
  try {
    url = new URL(hasScheme ? wanted : `https://${wanted}`);
  } catch {
    throw notFound(wanted, usable);
  }
  const host = url.hostname.toLowerCase();
  const bareHost = host.replace(/^www\./, '');

  // Domain properties cover every protocol and subdomain, so prefer the most specific one that matches.
  const domainMatches = usable
    .filter((s) => s.siteUrl.startsWith('sc-domain:'))
    .map((s) => ({ site: s, domain: s.siteUrl.slice('sc-domain:'.length).toLowerCase() }))
    .filter(({ domain }) => host === domain || host.endsWith(`.${domain}`))
    .sort((a, b) => b.domain.length - a.domain.length);
  if (domainMatches[0]) return domainMatches[0].site.siteUrl;

  // URL-prefix properties: the longest prefix of the requested URL wins.
  const path = url.pathname || '/';
  const prefixMatches = usable
    .filter((s) => /^https?:\/\//i.test(s.siteUrl))
    .filter((s) => {
      const prop = new URL(s.siteUrl);
      const propHost = prop.hostname.toLowerCase();
      const hostOk = hasScheme
        ? prop.protocol === url.protocol && propHost === host
        : propHost === host || propHost.replace(/^www\./, '') === bareHost;
      return hostOk && path.startsWith(prop.pathname);
    })
    .sort((a, b) => scorePrefix(b.siteUrl, url, hasScheme) - scorePrefix(a.siteUrl, url, hasScheme));
  if (prefixMatches[0]) return prefixMatches[0].siteUrl;

  throw notFound(wanted, usable);
}

function scorePrefix(siteUrl: string, wanted: URL, hasScheme: boolean): number {
  const prop = new URL(siteUrl);
  let score = prop.pathname.length * 10;
  if (!hasScheme && prop.protocol === 'https:') score += 2;
  if (prop.hostname.toLowerCase() === wanted.hostname.toLowerCase()) score += 1;
  return score;
}

function notFound(wanted: string, usable: Site[]): Error {
  return new Error(
    `No Search Console property matches "${wanted}". ${
      usable.length ? `Available properties: ${usable.map((s) => s.siteUrl).join(', ')}` : 'This account has no verified properties.'
    }`,
  );
}
