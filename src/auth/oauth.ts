import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { SCOPE_FULL, SCOPE_READONLY, SCOPES_IDENTITY } from '../config.js';
import { openBrowser } from './browser.js';
import { writeStoredCredentials, type OAuthClientConfig, type StoredCredentials } from './store.js';

export interface LoginOptions {
  client: OAuthClientConfig;
  /** Request the full `webmasters` scope (needed to submit or delete sitemaps). */
  write: boolean;
  credentialsPath: string;
  /** Default true. */
  openBrowser?: boolean;
  timeoutMs?: number;
}

export interface PendingLogin {
  url: string;
  browserOpened: boolean;
  /** Settles once the browser redirect arrives (or the timeout passes) and credentials are saved. */
  result: Promise<StoredCredentials>;
  cancel(): void;
}

const CALLBACK_PATH = '/oauth2callback';

/**
 * Starts Google's installed-app OAuth flow: a one-shot HTTP listener on 127.0.0.1 receives the
 * redirect, the code is exchanged with PKCE, and the refresh token is written to disk.
 */
export async function startLogin(options: LoginOptions): Promise<PendingLogin> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not start the local OAuth callback listener.');
  }

  const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
  const oauth = new OAuth2Client({
    clientId: options.client.clientId,
    clientSecret: options.client.clientSecret,
    redirectUri,
  });
  const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
  const state = randomBytes(16).toString('hex');
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [options.write ? SCOPE_FULL : SCOPE_READONLY, ...SCOPES_IDENTITY],
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });

  let timer: NodeJS.Timeout | undefined;
  let settle: { resolve: (value: StoredCredentials) => void; reject: (error: Error) => void };
  const result = new Promise<StoredCredentials>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Callers that only want the URL may never await the result; keep a failed login from crashing the process.
  result.catch(() => {});

  const finish = (error?: Error, credentials?: StoredCredentials) => {
    clearTimeout(timer);
    closeServer(server);
    if (error) settle.reject(error);
    else settle.resolve(credentials!);
  };

  const handleCallback = async (req: IncomingMessage, res: ServerResponse) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (requestUrl.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const params = requestUrl.searchParams;
    if (params.get('state') !== state) {
      respond(res, 400, 'Sign-in failed', 'The response did not match this sign-in attempt. Start again from your terminal or Claude.');
      return;
    }
    const oauthError = params.get('error');
    if (oauthError) {
      respond(res, 400, 'Sign-in cancelled', `Google returned: ${oauthError}. You can close this tab.`);
      finish(new Error(`Google sign-in failed: ${oauthError}`));
      return;
    }
    const code = params.get('code');
    if (!code) {
      respond(res, 400, 'Sign-in failed', 'No authorization code was returned.');
      return;
    }
    try {
      const { tokens } = await oauth.getToken({ code, codeVerifier });
      if (!tokens.refresh_token) {
        throw new Error('Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and sign in again.');
      }
      const scope = tokens.scope ?? '';
      if (!scope.includes(SCOPE_READONLY) && !scope.includes(SCOPE_FULL)) {
        const granted = scope.split(/\s+/).filter(Boolean).map((s) => s.replace('https://www.googleapis.com/auth/', '')).join(', ') || 'none';
        throw new Error(
          `Search Console access was not granted (Google granted: ${granted}). Sign in again and tick the box for viewing your Search Console data on the consent screen.`,
        );
      }
      const credentials: StoredCredentials = {
        type: 'oauth',
        clientId: options.client.clientId,
        clientSecret: options.client.clientSecret,
        refreshToken: tokens.refresh_token,
        scope,
        email: emailFromIdToken(tokens.id_token),
        createdAt: new Date().toISOString(),
      };
      await writeStoredCredentials(options.credentialsPath, credentials);
      respond(res, 200, 'Connected to Google Search Console', `Signed in${credentials.email ? ` as ${credentials.email}` : ''}. You can close this tab and go back to Claude.`);
      finish(undefined, credentials);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respond(res, 500, 'Sign-in failed', message);
      finish(error instanceof Error ? error : new Error(message));
    }
  };

  // Anything can reach a loopback port, so a bad request must never take the process down.
  server.on('request', (req, res) => {
    handleCallback(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  timer = setTimeout(
    () => finish(new Error('Timed out waiting for the Google sign-in to finish.')),
    options.timeoutMs ?? 5 * 60_000,
  );
  timer.unref();

  const browserOpened = options.openBrowser === false ? false : await openBrowser(url);
  return { url, browserOpened, result, cancel: () => finish(new Error('Sign-in cancelled.')) };
}

function closeServer(server: Server) {
  server.close();
  server.closeAllConnections?.();
}

function respond(res: ServerResponse, status: number, title: string, message: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#1f2328}h1{font-size:1.4rem}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(html);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The id_token comes straight from Google's token endpoint over TLS, so reading its payload is enough. */
export function emailFromIdToken(idToken: string | null | undefined): string | undefined {
  const payload = idToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown };
    return typeof claims.email === 'string' ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

export async function revokeRefreshToken(credentials: StoredCredentials): Promise<void> {
  const oauth = new OAuth2Client({ clientId: credentials.clientId, clientSecret: credentials.clientSecret });
  await oauth.revokeToken(credentials.refreshToken);
}
