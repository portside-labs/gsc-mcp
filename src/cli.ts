#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { revokeRefreshToken } from './auth/oauth.js';
import { AuthManager } from './auth/provider.js';
import { deleteStoredCredentials, readClientSecretFile, readStoredCredentials, type OAuthClientConfig } from './auth/store.js';
import { dropUnsetPlaceholders, PACKAGE_NAME, VERSION } from './config.js';
import { GscClient } from './gsc/client.js';
import { createContext, createServer } from './server.js';

const HELP = `gsc-mcp ${VERSION} - Google Search Console MCP server

Usage:
  gsc-mcp                 Start the MCP server on stdio (this is what Claude runs)
  gsc-mcp auth [options]  Sign in to Google in your browser and save credentials locally
  gsc-mcp status          Show the connected account and the properties it can access
  gsc-mcp logout          Revoke and delete the saved credentials

Auth options:
  --client-secret-file <path>   OAuth client JSON ("Desktop app") from Google Cloud Console
  --client-id <id>              OAuth client ID (alternative to the file)
  --client-secret <secret>      OAuth client secret
  --write                       Also allow submitting and deleting sitemaps
  --no-browser                  Print the sign-in URL instead of opening a browser

Environment:
  GSC_MCP_HOME                  Config directory (default ~/.config/gsc-mcp)
  GSC_SERVICE_ACCOUNT_KEY_FILE  Use a service account key instead of OAuth
  GSC_OAUTH_CLIENT_ID / GSC_OAUTH_CLIENT_SECRET   OAuth client for the login tool
  GSC_DEFAULT_SITE              Property to use when a tool call does not name one
  GSC_MCP_READ_ONLY=1           Hide the sitemap submit/delete tools
  GSC_MCP_ALLOW_PRIVATE_URLS=1  Let audit_page fetch localhost and private networks

Setup guide: https://github.com/portside-labs/gsc-mcp#setup
`;

async function main(argv: string[]): Promise<number> {
  dropUnsetPlaceholders();
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      'client-secret-file': { type: 'string' },
      'client-id': { type: 'string' },
      'client-secret': { type: 'string' },
      write: { type: 'boolean' },
      'no-browser': { type: 'boolean' },
    },
  });
  const command = positionals[0] ?? 'serve';

  if (values.version) return print(VERSION);
  if (values.help || command === 'help') return print(HELP);

  switch (command) {
    case 'serve':
      return serve();
    case 'auth':
    case 'login':
      return auth({
        clientSecretFile: values['client-secret-file'],
        clientId: values['client-id'],
        clientSecret: values['client-secret'],
        write: values.write ?? false,
        openBrowser: !values['no-browser'],
      });
    case 'status':
      return status();
    case 'logout':
      return logout();
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

function serve(): Promise<number> {
  if (process.stdin.isTTY) {
    process.stderr.write(
      `gsc-mcp ${VERSION} is running as an MCP server on stdio and waiting for a client.\n` +
        `It is meant to be started by Claude Desktop or Claude Code. Run \`npx ${PACKAGE_NAME} --help\` for setup commands.\n`,
    );
  }
  const context = createContext();
  const handle = serveStdio(() => createServer(context), {
    onerror: (error) => process.stderr.write(`gsc-mcp: ${error.message}\n`),
  });
  return new Promise(() => {
    // Exit explicitly: a pending browser sign-in listener would otherwise keep the process alive.
    const stop = () => void handle.close().finally(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdin.once('end', stop);
  });
}

interface AuthArgs {
  clientSecretFile?: string;
  clientId?: string;
  clientSecret?: string;
  write: boolean;
  openBrowser: boolean;
}

async function auth(args: AuthArgs): Promise<number> {
  const manager = new AuthManager();
  let client: OAuthClientConfig | undefined;
  if (args.clientSecretFile) client = await readClientSecretFile(args.clientSecretFile);
  else if (args.clientId) client = { clientId: args.clientId, clientSecret: args.clientSecret };
  else client = await manager.oauthClientConfig();

  if (!client) {
    process.stderr.write(
      'No OAuth client found. Create a "Desktop app" OAuth client in Google Cloud Console and pass the downloaded file:\n\n' +
        `  npx ${PACKAGE_NAME} auth --client-secret-file ~/Downloads/client_secret_XXXX.json\n\n` +
        'Step-by-step guide: https://github.com/portside-labs/gsc-mcp#setup\n',
    );
    return 1;
  }

  const login = await manager.startLogin(args.write, client, args.openBrowser);
  if (!args.openBrowser || !login.browserOpened) {
    process.stderr.write(`Open this URL in your browser to sign in:\n\n${login.url}\n\n`);
  } else {
    process.stderr.write(`Opened your browser to sign in. If nothing appeared, open this URL:\n\n${login.url}\n\n`);
  }
  process.stderr.write('Waiting for Google sign-in (Ctrl+C to cancel)...\n');

  const credentials = await login.result;
  process.stderr.write(`\nSigned in${credentials.email ? ` as ${credentials.email}` : ''} (${args.write ? 'read and write' : 'read-only'}).\n`);
  process.stderr.write(`Credentials saved to ${manager.credentialsPath}\n\n`);
  await printSites(manager);
  return 0;
}

async function status(): Promise<number> {
  const manager = new AuthManager();
  const info = await manager.status();
  if (!info) {
    process.stdout.write(`Not signed in.\n\nRun \`npx ${PACKAGE_NAME} auth --client-secret-file <file>\` to connect. Guide: https://github.com/portside-labs/gsc-mcp#setup\n`);
    return 1;
  }
  try {
    await (await manager.getTokenSource()).getRequestHeaders('https://searchconsole.googleapis.com/');
  } catch (error) {
    process.stdout.write(`Saved credentials (${info.source}) no longer work: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  process.stdout.write(
    `Signed in via ${info.method}${info.account ? ` as ${info.account}` : ''}\n` +
      `Access: ${info.canWrite ? 'read and write' : 'read-only'}\n` +
      `Credentials: ${info.source}\n\n`,
  );
  await printSites(manager);
  return 0;
}

async function printSites(manager: AuthManager): Promise<void> {
  try {
    const sites = await new GscClient({ getTokenSource: () => manager.getTokenSource() }).listSites();
    if (sites.length === 0) {
      process.stdout.write('This account has no Search Console properties yet. Add one at https://search.google.com/search-console\n');
      return;
    }
    process.stdout.write(`Properties (${sites.length}):\n`);
    for (const site of sites.sort((a, b) => a.siteUrl.localeCompare(b.siteUrl))) {
      process.stdout.write(`  ${site.siteUrl}  [${site.permissionLevel}]\n`);
    }
  } catch (error) {
    process.stdout.write(`Could not list properties: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function logout(): Promise<number> {
  const manager = new AuthManager();
  const stored = await readStoredCredentials(manager.credentialsPath).catch(() => undefined);
  if (stored) {
    await revokeRefreshToken(stored).catch((error: Error) => process.stderr.write(`Could not revoke the token with Google (${error.message}); deleting it locally anyway.\n`));
  }
  const deleted = await deleteStoredCredentials(manager.credentialsPath);
  process.stdout.write(deleted ? `Signed out and deleted ${manager.credentialsPath}\n` : 'No saved credentials found.\n');
  return 0;
}

function print(text: string): number {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`gsc-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
