import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Totals } from '../analysis/query.js';

export function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function pct(ratio: number, digits = 2): string {
  return `${round(ratio * 100, digits)}%`;
}

export function metrics(t: Totals) {
  return { clicks: Math.round(t.clicks), impressions: Math.round(t.impressions), ctr: pct(t.ctr), position: round(t.position) };
}

export function change(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? '0%' : 'new';
  const value = round(((current - previous) / previous) * 100, 1);
  return `${value > 0 ? '+' : ''}${value}%`;
}

export function signed(value: number, digits = 0): string {
  const r = round(value, digits);
  return `${r > 0 ? '+' : ''}${r}`;
}

export function totalsComparison(current: Totals, previous: Totals) {
  return {
    current: metrics(current),
    previous: metrics(previous),
    change: {
      clicks: change(current.clicks, previous.clicks),
      impressions: change(current.impressions, previous.impressions),
      ctr: `${signed((current.ctr - previous.ctr) * 100, 2)} pts`,
      position: previous.impressions && current.impressions ? signed(current.position - previous.position, 1) : 'n/a',
    },
  };
}

/**
 * JSON that keeps short objects and arrays on one line. Tables of rows stay readable for people
 * looking at tool output while costing far fewer tokens than fully indented JSON.
 */
export function compactJson(value: unknown, indent = '', width = 140): string {
  const inline = JSON.stringify(value);
  if (inline === undefined) return 'null';
  if (inline.length + indent.length <= width || value === null || typeof value !== 'object') return inline;
  const next = `${indent}  `;
  if (Array.isArray(value)) {
    return `[\n${value.map((v) => next + compactJson(v, next, width)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${compactJson(v, next, width)}`).join(',\n')}\n${indent}}`;
}

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: compactJson(data) }] };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Wraps a tool handler so API and auth failures come back as readable tool errors, not protocol errors. */
export function safe<A extends unknown[]>(handler: (...args: A) => Promise<CallToolResult>): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (error) {
      return errorResult(error);
    }
  };
}

/** Shown when a period has no final data at all, which usually means a new property or page. */
export function noDataNote(range: { startDate: string; endDate: string }) {
  return {
    note: `No final search data for ${range.startDate} to ${range.endDate}. New properties and pages take a few days to collect data, and final data lags 2-3 days. search_analytics with dataState "all" shows the freshest numbers.`,
  };
}
