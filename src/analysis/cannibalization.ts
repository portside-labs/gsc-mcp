import { sumRows, type Row } from './query.js';

export interface CannibalizationOptions {
  /** Ignore queries with fewer total impressions. */
  minImpressions: number;
  /** A page counts as competing when it gets at least this share of the query's impressions. */
  minShare: number;
  limit: number;
}

export interface CompetingPage {
  page: string;
  impressions: number;
  clicks: number;
  position: number;
  impressionShare: number;
}

export interface CannibalizedQuery {
  query: string;
  impressions: number;
  clicks: number;
  pages: CompetingPage[];
}

/**
 * Queries where two or more of the site's pages split the impressions. Fragment variants
 * (#section, #:~:text=) are merged into their page first since they are the same document.
 */
export function findCannibalization(rows: Row[], options: CannibalizationOptions): CannibalizedQuery[] {
  const byQuery = new Map<string, Map<string, Row[]>>();
  for (const r of rows) {
    if (!r.query || !r.page) continue;
    const page = stripFragment(r.page);
    const pages = byQuery.get(r.query) ?? new Map<string, Row[]>();
    pages.set(page, [...(pages.get(page) ?? []), r]);
    byQuery.set(r.query, pages);
  }

  const results: CannibalizedQuery[] = [];
  for (const [query, pages] of byQuery) {
    const perPage = [...pages].map(([page, pageRows]) => ({ page, ...sumRows(pageRows) }));
    const total = sumRows(perPage);
    if (total.impressions < options.minImpressions) continue;
    const competing = perPage
      .map((p) => ({
        page: p.page,
        impressions: p.impressions,
        clicks: p.clicks,
        position: p.position,
        impressionShare: p.impressions / total.impressions,
      }))
      .filter((p) => p.impressionShare >= options.minShare)
      .sort((a, b) => b.impressions - a.impressions);
    if (competing.length < 2) continue;
    results.push({ query, impressions: total.impressions, clicks: total.clicks, pages: competing });
  }
  return results.sort((a, b) => b.impressions - a.impressions).slice(0, options.limit);
}

export function stripFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}
