import type { Row, Totals } from './query.js';

export type ChangeMetric = 'clicks' | 'impressions';

export interface Change {
  key: string;
  current: Totals;
  previous: Totals;
  clicksChange: number;
  impressionsChange: number;
  /** Negative is better (moved up the results). Null when the row is missing from one period. */
  positionChange: number | null;
}

export interface PeriodComparison {
  declining: Change[];
  improving: Change[];
  /** Present now, absent (zero impressions) in the earlier period. */
  new: Change[];
  /** Present in the earlier period, absent now. */
  lost: Change[];
}

const ZERO: Totals = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

export function comparePeriods(
  current: Row[],
  previous: Row[],
  keyOf: (r: Row) => string | undefined,
  metric: ChangeMetric,
  limit: number,
  /** Whether each period's rows are complete. A key missing from a cut-off period may just be below the cutoff. */
  completeness: { currentComplete: boolean; previousComplete: boolean } = { currentComplete: true, previousComplete: true },
): PeriodComparison {
  const now = index(current, keyOf);
  const before = index(previous, keyOf);
  const changes: Change[] = [];
  for (const key of new Set([...now.keys(), ...before.keys()])) {
    const c = now.get(key) ?? ZERO;
    const p = before.get(key) ?? ZERO;
    changes.push({
      key,
      current: c,
      previous: p,
      clicksChange: c.clicks - p.clicks,
      impressionsChange: c.impressions - p.impressions,
      positionChange: c.impressions && p.impressions ? c.position - p.position : null,
    });
  }
  const delta = (x: Change) => (metric === 'clicks' ? x.clicksChange : x.impressionsChange);
  const both = changes.filter((x) => x.current.impressions > 0 && x.previous.impressions > 0);
  return {
    declining: both.filter((x) => delta(x) < 0).sort((a, b) => delta(a) - delta(b)).slice(0, limit),
    improving: both.filter((x) => delta(x) > 0).sort((a, b) => delta(b) - delta(a)).slice(0, limit),
    new: completeness.previousComplete
      ? changes.filter((x) => x.previous.impressions === 0 && x.current[metric] > 0).sort((a, b) => delta(b) - delta(a)).slice(0, limit)
      : [],
    lost: completeness.currentComplete
      ? changes.filter((x) => x.current.impressions === 0 && x.previous[metric] > 0).sort((a, b) => delta(a) - delta(b)).slice(0, limit)
      : [],
  };
}

function index(rows: Row[], keyOf: (r: Row) => string | undefined): Map<string, Totals> {
  const map = new Map<string, Totals>();
  for (const r of rows) {
    const key = keyOf(r);
    if (key !== undefined) map.set(key, { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
  }
  return map;
}
