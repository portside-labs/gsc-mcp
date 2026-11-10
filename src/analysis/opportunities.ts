import { expectedCtr, type CtrCurve } from './ctr.js';
import type { Row } from './query.js';

export interface QuickWinOptions {
  minPosition: number;
  maxPosition: number;
  minImpressions: number;
  /** Position used to estimate the upside, e.g. 3 = "if this reached position 3". */
  targetPosition: number;
  limit: number;
}

export interface QuickWin {
  query: string;
  page?: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  /** Extra clicks per period if the query reached targetPosition at the expected CTR. */
  potentialExtraClicks: number;
}

/** "Striking distance" queries: already ranking just off the top spots with real demand behind them. */
export function findQuickWins(rows: Row[], curve: CtrCurve, options: QuickWinOptions): QuickWin[] {
  const targetCtr = expectedCtr(options.targetPosition, curve);
  return rows
    .filter(
      (r) =>
        r.query !== undefined &&
        r.position >= options.minPosition &&
        r.position <= options.maxPosition &&
        r.impressions >= options.minImpressions,
    )
    .map((r) => ({
      query: r.query!,
      ...(r.page !== undefined ? { page: r.page } : {}),
      position: r.position,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
      potentialExtraClicks: Math.max(0, r.impressions * targetCtr - r.clicks),
    }))
    .sort((a, b) => b.potentialExtraClicks - a.potentialExtraClicks)
    .slice(0, options.limit);
}

export interface CtrOpportunityOptions {
  maxPosition: number;
  minImpressions: number;
  /** Flag rows whose CTR is below this fraction of the expected CTR (0.7 = 30% under). */
  threshold: number;
  limit: number;
}

export interface CtrOpportunity {
  key: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  expectedCtr: number;
  /** Clicks lost versus the expected CTR at the current position. */
  missedClicks: number;
}

/** Rows that rank well but get clicked less than they should: usually a title or meta description problem. */
export function findCtrOpportunities(rows: Row[], keyOf: (r: Row) => string | undefined, curve: CtrCurve, options: CtrOpportunityOptions): CtrOpportunity[] {
  const out: CtrOpportunity[] = [];
  for (const r of rows) {
    const key = keyOf(r);
    if (key === undefined || r.position > options.maxPosition || r.impressions < options.minImpressions) continue;
    const expected = expectedCtr(r.position, curve);
    if (r.ctr >= expected * options.threshold) continue;
    out.push({
      key,
      position: r.position,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
      expectedCtr: expected,
      missedClicks: r.impressions * expected - r.clicks,
    });
  }
  return out.sort((a, b) => b.missedClicks - a.missedClicks).slice(0, options.limit);
}

/** Groups query+page rows into each page's top queries by impressions. */
export function topQueriesByPage(rows: Row[], perPage: number): Map<string, Row[]> {
  const byPage = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.page || !r.query) continue;
    const list = byPage.get(r.page) ?? [];
    list.push(r);
    byPage.set(r.page, list);
  }
  for (const [page, list] of byPage) {
    byPage.set(page, list.sort((a, b) => b.impressions - a.impressions).slice(0, perPage));
  }
  return byPage;
}
