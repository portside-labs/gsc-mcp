import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { jsonResult, safe, textResult } from './format.js';
import { siteField, type ToolContext } from './context.js';

/** Sitemaps the site advertises in robots.txt, or /sitemap.xml when robots.txt lists none. Failures are ignored. */
async function discoverSitemaps(ctx: ToolContext, site: string): Promise<string[]> {
  const origin = site.startsWith('sc-domain:') ? `https://${site.slice('sc-domain:'.length)}` : new URL(site).origin;
  const options = { allowPrivate: ctx.settings.allowPrivateUrls, timeoutMs: 10_000, maxBytes: 512 * 1024 };
  const found = new Set<string>();
  try {
    const robots = await ctx.fetchPage(`${origin}/robots.txt`, options);
    if (robots.status === 200) {
      for (const match of robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)) found.add(match[1]!);
    }
  } catch {
    // No robots.txt or unreachable site.
  }
  if (found.size === 0) {
    try {
      const page = await ctx.fetchPage(`${origin}/sitemap.xml`, options);
      if (page.status === 200 && /<(urlset|sitemapindex)[\s>]/i.test(page.body)) found.add(page.finalUrl);
    } catch {
      // No sitemap at the default location.
    }
  }
  return [...found];
}

const sitemapField = z.string().url().describe('Full sitemap URL, e.g. "https://www.example.com/sitemap.xml". Must belong to the property.');

export function registerSitemapTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_sitemaps',
    {
      title: 'List sitemaps',
      description:
        'Lists the sitemaps submitted for a property with their status: last submitted and downloaded, whether processing is pending, error and warning counts, and how many URLs of each type they contain. ' +
        'Also checks the site\'s robots.txt and /sitemap.xml for sitemaps that exist but were never submitted.',
      inputSchema: z.object({ site: siteField }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ site: input }) => {
      const site = await ctx.sites.resolve(input);
      const [sitemaps, discovered] = await Promise.all([ctx.api.listSitemaps(site), discoverSitemaps(ctx, site)]);
      const submitted = new Set(sitemaps.map((s) => s.path));
      const notSubmitted = discovered.filter((url) => !submitted.has(url));
      return jsonResult({
        site,
        sitemaps: sitemaps.map((s) => ({
          path: s.path,
          type: s.type,
          isIndex: s.isSitemapsIndex ?? false,
          lastSubmitted: s.lastSubmitted,
          lastDownloaded: s.lastDownloaded,
          isPending: s.isPending ?? false,
          errors: Number(s.errors ?? 0),
          warnings: Number(s.warnings ?? 0),
          submittedUrls: (s.contents ?? []).map((c) => ({ type: c.type, submitted: Number(c.submitted ?? 0) })),
        })),
        ...(notSubmitted.length
          ? {
              notSubmitted,
              note: `Found ${notSubmitted.length === 1 ? 'a sitemap' : 'sitemaps'} on the site that ${notSubmitted.length === 1 ? 'is' : 'are'} not submitted in Search Console. Submitting helps Google discover new pages: use submit_sitemap (needs write access) or Search Console > Sitemaps.`,
            }
          : sitemaps.length === 0
            ? { note: 'No sitemaps submitted, and none found in robots.txt or at /sitemap.xml. A sitemap helps Google discover new and updated pages.' }
            : {}),
      });
    }),
  );

  if (ctx.settings.readOnly) return;

  server.registerTool(
    'submit_sitemap',
    {
      title: 'Submit a sitemap',
      description:
        'Submits (or resubmits) a sitemap to Google Search Console so Google re-reads it. Resubmit after publishing or updating landing pages. Requires write access (sign in with write=true).',
      inputSchema: z.object({ site: siteField, sitemapUrl: sitemapField }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ site: input, sitemapUrl }) => {
      const site = await ctx.sites.resolve(input ?? sitemapUrl);
      await ctx.api.submitSitemap(site, sitemapUrl);
      return textResult(`Submitted ${sitemapUrl} to ${site}. Google usually processes it within a few hours; check with list_sitemaps.`);
    }),
  );

  server.registerTool(
    'delete_sitemap',
    {
      title: 'Remove a sitemap',
      description:
        'Removes a sitemap from Search Console. This only stops Search Console tracking it; the file on the website is untouched and already-indexed URLs stay indexed. Requires write access. Confirm with the user before calling.',
      inputSchema: z.object({ site: siteField, sitemapUrl: sitemapField }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ site: input, sitemapUrl }) => {
      const site = await ctx.sites.resolve(input ?? sitemapUrl);
      await ctx.api.deleteSitemap(site, sitemapUrl);
      return textResult(`Removed ${sitemapUrl} from ${site} in Search Console.`);
    }),
  );
}
