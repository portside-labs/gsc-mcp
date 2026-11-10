import type { Row } from './query.js';

/**
 * Rough organic CTR by rounded position (index 0 = position 1, index 20 = beyond page two).
 * Deliberately conservative to reflect SERPs with AI Overviews and ads; only used where the site
 * itself has too little data for a position.
 */
export const BENCHMARK_CTR = [
  0.27, 0.15, 0.1, 0.07, 0.05, 0.04, 0.032, 0.026, 0.021, 0.018, 0.012, 0.011, 0.01, 0.009, 0.008, 0.007, 0.007, 0.006, 0.006, 0.005,
  0.003,
];

export interface CtrCurve {
  /** Expected CTR per rounded position 1..21 (21 = anything beyond 20). */
  values: number[];
  /** Which buckets came from the site's own data rather than the benchmark. */
  fromSite: boolean[];
}

const MIN_QUERIES_PER_BUCKET = 8;
const MIN_IMPRESSIONS_PER_QUERY = 20;

function bucket(position: number): number {
  return Math.min(Math.max(Math.round(position), 1), 21) - 1;
}

/**
 * Builds the site's own CTR-by-position curve from query rows: the median CTR of queries at each
 * rounded position. Medians keep a few branded queries from inflating the top positions.
 */
export function buildCtrCurve(queryRows: Row[]): CtrCurve {
  const samples: number[][] = BENCHMARK_CTR.map(() => []);
  for (const row of queryRows) {
    if (row.impressions < MIN_IMPRESSIONS_PER_QUERY || row.position <= 0) continue;
    samples[bucket(row.position)]!.push(row.ctr);
  }
  const values: number[] = [];
  const fromSite: boolean[] = [];
  samples.forEach((ctrs, i) => {
    const enough = ctrs.length >= MIN_QUERIES_PER_BUCKET;
    values.push(enough ? median(ctrs) : BENCHMARK_CTR[i]!);
    fromSite.push(enough);
  });
  return { values, fromSite };
}

export function benchmarkCurve(): CtrCurve {
  return { values: [...BENCHMARK_CTR], fromSite: BENCHMARK_CTR.map(() => false) };
}

export function expectedCtr(position: number, curve: CtrCurve): number {
  return curve.values[bucket(position)]!;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
