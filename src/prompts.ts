import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

function userMessage(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'seo_audit',
    {
      title: 'SEO audit from Search Console data',
      description: 'Review a site\'s search performance and produce a prioritized SEO action plan.',
      argsSchema: z.object({
        site: z.string().optional().describe('Property or domain, e.g. example.com'),
        brand: z.string().optional().describe('Brand terms to exclude from opportunity analysis, e.g. "acme|acmecorp"'),
      }),
    },
    ({ site, brand }) =>
      userMessage(`Run an SEO audit of ${site ? `the Search Console property for ${site}` : 'my Search Console property (ask me which if there are several)'} using the gsc tools.

1. performance_summary for the last 28 days compared with the previous period, then again compared with last year.
2. find_quick_wins${brand ? ` with excludeQueryRegex "(?i)${brand}"` : ''}: queries ranking 4-20 with the most upside.
3. find_ctr_opportunities${brand ? ' with the same brand exclusion' : ''}: pages that rank on page one but under-perform on CTR.
4. compare_periods by page to find content that is decaying.
5. find_cannibalization to spot pages competing for the same queries.
6. list_sitemaps, then inspect_urls on the top 10 pages by impressions plus any declining pages, to catch indexing problems.

Then write a prioritized action plan: for each item give the page, the evidence (numbers), the specific change (for titles and meta descriptions, write the new text), and the expected impact. Put quick, high-impact fixes first.`),
  );

  server.registerPrompt(
    'optimize_page',
    {
      title: 'Optimize a landing page',
      description: 'Use Search Console data and an on-page audit to rewrite and improve one page.',
      argsSchema: z.object({
        url: z.string().describe('Full URL of the page to optimize'),
        goal: z.string().optional().describe('What the page should rank or convert for, if known'),
      }),
    },
    ({ url, goal }) =>
      userMessage(`Optimize this page for search: ${url}${goal ? `\nGoal: ${goal}` : ''}

1. Call analyze_page for the URL (last 90 days: days=90) to get its queries, striking-distance terms, index status and on-page audit.
2. If it shares queries with other pages, check find_cannibalization with pageRegex matching the page's section.
3. Based on the evidence, give me:
   - A new title tag (under 60 characters) and meta description (under 155 characters) that target the highest-value queries and earn the click. Offer 2-3 options.
   - The H1 and an outline of H2 sections that cover the queries the page ranks for but does not address.
   - Technical fixes from the audit and index status (canonical, indexing, structured data, redirects).
   - Internal linking suggestions.
Explain which queries each change targets and why, citing impressions and positions.`),
  );

  server.registerPrompt(
    'investigate_traffic_drop',
    {
      title: 'Investigate a traffic drop',
      description: 'Find where search traffic was lost and why.',
      argsSchema: z.object({
        site: z.string().optional().describe('Property or domain'),
        days: z.string().optional().describe('Length of the period to compare, in days (default 28)'),
      }),
    },
    ({ site, days }) =>
      userMessage(`Search traffic ${site ? `for ${site} ` : ''}seems to have dropped. Investigate using the gsc tools${days ? ` over ${days}-day periods` : ''}.

1. performance_summary compared with the previous period and with last year, to separate seasonality from a real drop. Look at the trend for the day it started.
2. compare_periods by page and by query (metric clicks) to find which pages and queries lost the most.
3. For the top 5 losing pages: inspect_urls to check indexing, canonical and robots status, and audit_page to check for noindex, redirects, or changed titles.
4. Check whether impressions fell (ranking or indexing loss) or only CTR fell (SERP or snippet change), and whether the loss is concentrated on one device or country with search_analytics.

Summarize the likely causes with evidence and the fixes, most important first.`),
  );
}
