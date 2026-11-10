import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { VERSION } from '../config.js';
import { jsonResult, safe, textResult } from './format.js';
import type { ToolContext } from './context.js';

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'auth_status',
    {
      title: 'Search Console connection status',
      description:
        'Shows whether the server is signed in to Google Search Console, with which account and method, and whether it can make changes (sitemap submit/delete). Call this first if other tools report authentication problems.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => {
      const info = await ctx.auth.status();
      if (!info) {
        const client = await ctx.auth.oauthClientConfig().catch(() => undefined);
        return jsonResult({
          signedIn: false,
          version: VERSION,
          next: client
            ? 'Call the `login` tool to sign in with your browser.'
            : 'No OAuth client configured yet. Follow https://github.com/portside-labs/gsc-mcp#setup, then run `npx @portside-labs/gsc-mcp auth --client-secret-file <file>` or call `login`.',
        });
      }
      return jsonResult({
        signedIn: true,
        version: VERSION,
        method: info.method,
        account: info.account,
        canWrite: info.canWrite,
        credentials: info.source,
        readOnlyMode: ctx.settings.readOnly,
        defaultSite: ctx.settings.defaultSite,
      });
    }),
  );

  server.registerTool(
    'login',
    {
      title: 'Sign in to Google Search Console',
      description:
        "Starts Google sign-in in the user's browser (OAuth with a local loopback redirect) and saves the credentials on this machine. " +
        'Waits up to `waitSeconds` for the user to finish; if they need longer, it returns the sign-in URL and keeps listening for five minutes. ' +
        'Needs an OAuth client, either from an earlier `gsc-mcp auth` or the GSC_OAUTH_CLIENT_ID/GSC_OAUTH_CLIENT_SECRET environment variables.',
      inputSchema: z.object({
        write: z.boolean().optional().describe('Also grant permission to submit and delete sitemaps (full "webmasters" scope). Default false (read-only).'),
        waitSeconds: z.number().int().min(0).max(110).optional().describe('How long to wait for the browser sign-in before returning. Default 45.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ write, waitSeconds }) => {
      const login = await ctx.auth.startLogin(write ?? false);
      const wait = (waitSeconds ?? 45) * 1000;
      const outcome = await Promise.race([
        login.result.then(
          (credentials) => ({ done: true as const, credentials }),
          (error: Error) => ({ done: true as const, error }),
        ),
        new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), wait).unref()),
      ]);
      if (outcome.done && 'error' in outcome) throw outcome.error;
      if (outcome.done) {
        const sites = await ctx.sites.list(true).catch(() => []);
        return textResult(
          `Signed in${outcome.credentials.email ? ` as ${outcome.credentials.email}` : ''} with ${write ? 'read and write' : 'read-only'} access. ` +
            `${sites.length} Search Console ${sites.length === 1 ? 'property is' : 'properties are'} available. Credentials saved to ${ctx.auth.credentialsPath}.`,
        );
      }
      return textResult(
        `${login.browserOpened ? 'A browser window has been opened for Google sign-in.' : 'Open this URL in a browser to sign in to Google:'}\n\n${login.url}\n\n` +
          'After approving access, tell me to continue. The sign-in link stays valid for five minutes.',
      );
    }),
  );

  server.registerTool(
    'list_sites',
    {
      title: 'List Search Console properties',
      description:
        'Lists the Search Console properties (sites) the signed-in account can access, with permission level. Domain properties look like "sc-domain:example.com"; URL-prefix properties look like "https://www.example.com/".',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async () => {
      const sites = await ctx.sites.list(true);
      return jsonResult({
        defaultSite: ctx.settings.defaultSite,
        sites: sites
          .map((s) => ({
            site: s.siteUrl,
            type: s.siteUrl.startsWith('sc-domain:') ? 'domain' : 'url-prefix',
            permission: s.permissionLevel,
            ...(s.permissionLevel === 'siteUnverifiedUser' ? { note: 'Unverified: no data access' } : {}),
          }))
          .sort((a, b) => a.site.localeCompare(b.site)),
      });
    }),
  );
}
