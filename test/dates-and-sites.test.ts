import { describe, expect, it } from 'vitest';
import { addDays, comparisonRange, dayCount, resolveRange, todayPT } from '../src/analysis/dates.js';
import { resolveSite } from '../src/gsc/sites.js';
import type { Site } from '../src/gsc/types.js';

describe('dates', () => {
  it('uses Pacific Time for today', () => {
    // 2026-03-02 05:00 UTC is still March 1st in Los Angeles.
    expect(todayPT(new Date('2026-03-02T05:00:00Z'))).toBe('2026-03-01');
    expect(todayPT(new Date('2026-03-02T09:00:00Z'))).toBe('2026-03-02');
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(dayCount('2026-01-01', '2026-01-28')).toBe(28);
  });

  it('defaults to the last 28 days ending on the latest data day', () => {
    expect(resolveRange({}, '2026-11-07')).toEqual({ startDate: '2026-10-11', endDate: '2026-11-07' });
    expect(resolveRange({ days: 7 }, '2026-11-07')).toEqual({ startDate: '2026-11-01', endDate: '2026-11-07' });
    expect(resolveRange({ startDate: '2026-10-01', endDate: '2026-10-31' }, '2026-11-07')).toEqual({ startDate: '2026-10-01', endDate: '2026-10-31' });
    expect(resolveRange({ endDate: '2026-10-31', days: 3 }, '2026-11-07')).toEqual({ startDate: '2026-10-29', endDate: '2026-10-31' });
  });

  it('rejects bad ranges', () => {
    expect(() => resolveRange({ startDate: '2026-11-05', endDate: '2026-11-01' }, '2026-11-07')).toThrow(/after/);
    expect(() => resolveRange({ startDate: '2026-13-45', endDate: '2026-11-01' }, '2026-11-07')).toThrow(/valid date/);
    expect(() => resolveRange({ startDate: '2026-02-30', endDate: '2026-03-05' }, '2026-11-07')).toThrow(/valid date/);
    expect(resolveRange({ startDate: '2028-02-29', endDate: '2028-03-01' }, '2028-03-05')).toEqual({ startDate: '2028-02-29', endDate: '2028-03-01' });
  });

  it('computes comparison periods', () => {
    const range = { startDate: '2026-10-11', endDate: '2026-11-07' };
    expect(comparisonRange(range, 'previous')).toEqual({ startDate: '2026-09-13', endDate: '2026-10-10' });
    expect(comparisonRange(range, 'year')).toEqual({ startDate: '2025-10-12', endDate: '2025-11-08' });
  });
});

describe('resolveSite', () => {
  const sites: Site[] = [
    { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
    { siteUrl: 'sc-domain:blog.example.com', permissionLevel: 'siteFullUser' },
    { siteUrl: 'https://www.other.io/', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://www.other.io/shop/', permissionLevel: 'siteRestrictedUser' },
    { siteUrl: 'http://legacy.net/', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://unverified.dev/', permissionLevel: 'siteUnverifiedUser' },
  ];

  it('returns exact property names unchanged', () => {
    expect(resolveSite('https://www.other.io/', sites)).toBe('https://www.other.io/');
    expect(resolveSite('SC-DOMAIN:example.com', sites)).toBe('sc-domain:example.com');
  });

  it('matches bare domains and page URLs to domain properties', () => {
    expect(resolveSite('example.com', sites)).toBe('sc-domain:example.com');
    expect(resolveSite('https://www.example.com/pricing?x=1', sites)).toBe('sc-domain:example.com');
    expect(resolveSite('blog.example.com', sites)).toBe('sc-domain:blog.example.com');
  });

  it('picks the longest URL-prefix property', () => {
    expect(resolveSite('https://www.other.io/shop/item-1', sites)).toBe('https://www.other.io/shop/');
    expect(resolveSite('https://www.other.io/about', sites)).toBe('https://www.other.io/');
    expect(resolveSite('other.io', sites)).toBe('https://www.other.io/');
    expect(resolveSite('legacy.net', sites)).toBe('http://legacy.net/');
  });

  it('respects the scheme when one is given', () => {
    expect(() => resolveSite('https://legacy.net/page', sites)).toThrow(/No Search Console property/);
  });

  it('ignores unverified properties', () => {
    expect(() => resolveSite('unverified.dev', sites)).toThrow(/Available properties/);
  });

  it('uses the default site or the only site when none is given', () => {
    expect(resolveSite(undefined, sites, 'example.com')).toBe('sc-domain:example.com');
    expect(resolveSite(undefined, [sites[0]!])).toBe('sc-domain:example.com');
    expect(() => resolveSite(undefined, sites)).toThrow(/Specify which property/);
  });
});
