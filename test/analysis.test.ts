import { describe, expect, it } from 'vitest';
import { findCannibalization } from '../src/analysis/cannibalization.js';
import { comparePeriods } from '../src/analysis/compare.js';
import { BENCHMARK_CTR, benchmarkCurve, buildCtrCurve, expectedCtr } from '../src/analysis/ctr.js';
import { findCtrOpportunities, findQuickWins } from '../src/analysis/opportunities.js';
import { buildFilters, fetchRows, sumRows, type Row } from '../src/analysis/query.js';
import type { GscApi, SearchAnalyticsRequest } from '../src/gsc/types.js';

const row = (r: Partial<Row>): Row => ({ clicks: 0, impressions: 0, ctr: 0, position: 1, ...r });

describe('CTR curve', () => {
  it('falls back to the benchmark without enough data', () => {
    const curve = buildCtrCurve([row({ query: 'a', impressions: 100, clicks: 50, ctr: 0.5, position: 1 })]);
    expect(curve.values).toEqual(BENCHMARK_CTR);
    expect(curve.fromSite.every((x) => !x)).toBe(true);
  });

  it('uses the median CTR of the site queries at a position', () => {
    const rows = Array.from({ length: 9 }, (_, i) => row({ query: `q${i}`, impressions: 100, ctr: (i + 1) / 100, position: 2.2 }));
    const curve = buildCtrCurve(rows);
    expect(curve.fromSite[1]).toBe(true);
    expect(expectedCtr(2, curve)).toBeCloseTo(0.05);
    expect(expectedCtr(1, curve)).toBe(BENCHMARK_CTR[0]);
    expect(expectedCtr(55, curve)).toBe(BENCHMARK_CTR[20]);
  });
});

describe('opportunities', () => {
  const curve = benchmarkCurve();

  it('ranks striking-distance queries by potential clicks', () => {
    const rows = [
      row({ query: 'top', page: '/a', position: 1.5, impressions: 9000, clicks: 2000 }),
      row({ query: 'small', page: '/b', position: 6, impressions: 100, clicks: 2 }),
      row({ query: 'big', page: '/c', position: 9, impressions: 5000, clicks: 50 }),
      row({ query: 'too-few', page: '/d', position: 7, impressions: 5, clicks: 0 }),
      row({ query: 'too-deep', page: '/e', position: 40, impressions: 5000, clicks: 0 }),
    ];
    const wins = findQuickWins(rows, curve, { minPosition: 4, maxPosition: 20, minImpressions: 20, targetPosition: 3, limit: 10 });
    expect(wins.map((w) => w.query)).toEqual(['big', 'small']);
    expect(wins[0]!.potentialExtraClicks).toBeCloseTo(5000 * 0.1 - 50);
  });

  it('flags pages with CTR well below the expected CTR', () => {
    const rows = [
      row({ page: '/good', position: 2, impressions: 1000, clicks: 160, ctr: 0.16 }),
      row({ page: '/bad', position: 2, impressions: 1000, clicks: 20, ctr: 0.02 }),
      row({ page: '/page-two', position: 14, impressions: 1000, clicks: 0, ctr: 0 }),
    ];
    const found = findCtrOpportunities(rows, (r) => r.page, curve, { maxPosition: 10, minImpressions: 100, threshold: 0.7, limit: 10 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ key: '/bad', expectedCtr: 0.15 });
    expect(found[0]!.missedClicks).toBeCloseTo(130);
  });
});

describe('comparePeriods', () => {
  it('splits changes into declining, improving, new and lost', () => {
    const current = [
      row({ page: '/up', clicks: 50, impressions: 500 }),
      row({ page: '/down', clicks: 10, impressions: 300 }),
      row({ page: '/new', clicks: 5, impressions: 40 }),
    ];
    const previous = [
      row({ page: '/up', clicks: 20, impressions: 400 }),
      row({ page: '/down', clicks: 40, impressions: 600 }),
      row({ page: '/gone', clicks: 8, impressions: 90 }),
    ];
    const result = comparePeriods(current, previous, (r) => r.page, 'clicks', 10);
    expect(result.declining.map((c) => c.key)).toEqual(['/down']);
    expect(result.improving.map((c) => c.key)).toEqual(['/up']);
    expect(result.new.map((c) => c.key)).toEqual(['/new']);
    expect(result.lost.map((c) => c.key)).toEqual(['/gone']);
    expect(result.declining[0]!.clicksChange).toBe(-30);
    expect(result.new[0]!.positionChange).toBeNull();

    // When the earlier period was cut off, absence there proves nothing.
    const partial = comparePeriods(current, previous, (r) => r.page, 'clicks', 10, { currentComplete: true, previousComplete: false });
    expect(partial.new).toEqual([]);
    expect(partial.lost.map((c) => c.key)).toEqual(['/gone']);
  });
});

describe('findCannibalization', () => {
  it('finds queries split across pages and merges fragment URLs', () => {
    const rows = [
      row({ query: 'seo tips', page: 'https://x.com/a', impressions: 600, clicks: 20, position: 5 }),
      row({ query: 'seo tips', page: 'https://x.com/b', impressions: 300, clicks: 5, position: 9 }),
      row({ query: 'seo tips', page: 'https://x.com/b#:~:text=tips', impressions: 100, clicks: 0, position: 10 }),
      row({ query: 'solo', page: 'https://x.com/a', impressions: 900, clicks: 90, position: 2 }),
      row({ query: 'solo', page: 'https://x.com/c', impressions: 20, clicks: 0, position: 30 }),
    ];
    const found = findCannibalization(rows, { minImpressions: 50, minShare: 0.1, limit: 10 });
    expect(found).toHaveLength(1);
    expect(found[0]!.query).toBe('seo tips');
    expect(found[0]!.pages.map((p) => p.page)).toEqual(['https://x.com/a', 'https://x.com/b']);
    expect(found[0]!.pages[1]!.impressions).toBe(400);
    expect(found[0]!.pages[1]!.position).toBeCloseTo(9.25);
  });
});

describe('query helpers', () => {
  it('builds Search Console filters', () => {
    expect(buildFilters({ excludeQueryRegex: '(?i)acme', pageRegex: '/blog/', country: 'USA', device: 'MOBILE' })).toEqual([
      { dimension: 'query', operator: 'excludingRegex', expression: '(?i)acme' },
      { dimension: 'page', operator: 'includingRegex', expression: '/blog/' },
      { dimension: 'country', operator: 'equals', expression: 'usa' },
      { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
    ]);
  });

  it('weights position by impressions when summing', () => {
    const totals = sumRows([row({ clicks: 10, impressions: 100, position: 2 }), row({ clicks: 0, impressions: 300, position: 10 })]);
    expect(totals).toEqual({ clicks: 10, impressions: 400, ctr: 0.025, position: 8 });
  });

  it('pages through the API 25,000 rows at a time and stops at maxRows', async () => {
    const requests: SearchAnalyticsRequest[] = [];
    const api = {
      async searchAnalytics(_site: string, request: SearchAnalyticsRequest) {
        requests.push(request);
        const total = 60_000;
        const start = request.startRow ?? 0;
        const count = Math.max(0, Math.min(request.rowLimit ?? 1000, total - start));
        return { rows: Array.from({ length: count }, (_, i) => ({ keys: [`q${start + i}`], clicks: 1, impressions: 1, ctr: 1, position: 1 })) };
      },
    } as unknown as GscApi;

    const all = await fetchRows(api, 's', { startDate: '2026-01-01', endDate: '2026-01-02' }, { dimensions: ['query'], maxRows: 100_000 });
    expect(all.rows).toHaveLength(60_000);
    expect(all.truncated).toBe(false);
    expect(requests.map((r) => [r.startRow, r.rowLimit])).toEqual([
      [0, 25_000],
      [25_000, 25_000],
      [50_000, 25_000],
    ]);
    expect(all.rows[59_999]!.query).toBe('q59999');

    requests.length = 0;
    const some = await fetchRows(api, 's', { startDate: '2026-01-01', endDate: '2026-01-02' }, { dimensions: ['query'], maxRows: 30_000 });
    expect(some.rows).toHaveLength(30_000);
    expect(some.truncated).toBe(true);
    expect(requests.map((r) => [r.startRow, r.rowLimit])).toEqual([
      [0, 25_000],
      [25_000, 5_001],
    ]);

    // Exactly maxRows available: not truncated.
    requests.length = 0;
    const exact = await fetchRows(api, 's', { startDate: '2026-01-01', endDate: '2026-01-02' }, { dimensions: ['query'], maxRows: 60_000 });
    expect(exact.rows).toHaveLength(60_000);
    expect(exact.truncated).toBe(false);
    expect(requests.at(-1)).toMatchObject({ startRow: 50_000, rowLimit: 10_001 });

    // maxRows lands on a full API page: probe one more row.
    requests.length = 0;
    const page = await fetchRows(api, 's', { startDate: '2026-01-01', endDate: '2026-01-02' }, { dimensions: ['query'], maxRows: 25_000 });
    expect(page.truncated).toBe(true);
    expect(requests.map((r) => [r.startRow, r.rowLimit])).toEqual([
      [0, 25_000],
      [25_000, 1],
    ]);
  });
});
