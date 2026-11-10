import { readFile } from 'node:fs/promises';
import { GoogleAuth, OAuth2Client, type AuthClient } from 'google-auth-library';
import { credentialsPath, runtimeSettings, SCOPE_FULL, SCOPE_READONLY } from '../config.js';
import { startLogin, type PendingLogin } from './oauth.js';
import {
  credentialsMtime,
  readClientSecretFile,
  readStoredCredentials,
  writeStoredCredentials,
  type OAuthClientConfig,
  type StoredCredentials,
} from './store.js';

export type AuthMethod = 'oauth' | 'service_account' | 'adc';

export interface AuthInfo {
  method: AuthMethod;
  /** Google account or service account email, when known. */
  account?: string;
  /** Whether the credentials carry the full `webmasters` scope (needed for sitemap changes). */
  canWrite: boolean;
  /** Where the credentials came from. */
  source: string;
}

export interface TokenSource {
  info: AuthInfo;
  /** Authorization headers for a Google API request (plus x-goog-user-project for gcloud credentials). */
  getRequestHeaders(url: string): Promise<Record<string, string>>;
}

export class NotAuthenticatedError extends Error {
  override name = 'NotAuthenticatedError';
}

const SETUP_HINT =
  'To connect: create a "Desktop app" OAuth client in Google Cloud Console (with the Search Console API enabled), then run ' +
  '`npx @portside-labs/gsc-mcp auth --client-secret-file <path-to-client_secret.json>` in a terminal. ' +
  'Alternatively set GSC_SERVICE_ACCOUNT_KEY_FILE to a service account key that has been added as a user on your Search Console property. ' +
  'Setup guide: https://github.com/portside-labs/gsc-mcp#setup';

/**
 * Resolves Google credentials in this order:
 * 1. GSC_SERVICE_ACCOUNT_KEY_FILE (service account key JSON)
 * 2. OAuth credentials saved by `gsc-mcp auth` or the `login` tool
 * 3. Application Default Credentials, only when GSC_AUTH=adc
 */
export class AuthManager {
  private cached?: { source: Promise<TokenSource>; mtime: number };
  private pendingLogin?: { login: PendingLogin; write: boolean };

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get credentialsPath(): string {
    return credentialsPath(this.env);
  }

  /** Shares one in-flight resolution, so parallel tool requests reuse a single client and token refresh. */
  async getTokenSource(): Promise<TokenSource> {
    const mtime = await credentialsMtime(this.credentialsPath);
    if (!this.cached || this.cached.mtime !== mtime) {
      const source = this.resolve();
      this.cached = { source, mtime };
      source.catch(() => {
        if (this.cached?.source === source) this.cached = undefined;
      });
    }
    return this.cached.source;
  }

  /** Auth details, or undefined when nothing is configured. */
  async status(): Promise<AuthInfo | undefined> {
    try {
      return (await this.getTokenSource()).info;
    } catch (error) {
      if (error instanceof NotAuthenticatedError) return undefined;
      throw error;
    }
  }

  invalidate(): void {
    this.cached = undefined;
  }

  /** OAuth client used for browser sign-in: env vars first, then the client saved with earlier credentials. */
  async oauthClientConfig(): Promise<OAuthClientConfig | undefined> {
    if (this.env.GSC_OAUTH_CLIENT_ID) {
      return { clientId: this.env.GSC_OAUTH_CLIENT_ID, clientSecret: this.env.GSC_OAUTH_CLIENT_SECRET || undefined };
    }
    if (this.env.GSC_OAUTH_CLIENT_FILE) return readClientSecretFile(this.env.GSC_OAUTH_CLIENT_FILE);
    const stored = await readStoredCredentials(this.credentialsPath).catch(() => undefined);
    return stored ? { clientId: stored.clientId, clientSecret: stored.clientSecret } : undefined;
  }

  /**
   * Starts (or reuses) a browser sign-in. The returned login keeps listening in the background,
   * so a tool call can hand the URL to the user and return straight away.
   */
  async startLogin(write: boolean, client?: OAuthClientConfig, openBrowser = true): Promise<PendingLogin> {
    if (this.pendingLogin && this.pendingLogin.write === write) return this.pendingLogin.login;
    this.pendingLogin?.login.cancel();
    const resolvedClient = client ?? (await this.oauthClientConfig());
    if (!resolvedClient) {
      throw new NotAuthenticatedError(`No OAuth client is configured, so a browser sign-in cannot start. ${SETUP_HINT}`);
    }
    const login = await startLogin({ client: resolvedClient, write, credentialsPath: this.credentialsPath, openBrowser });
    this.pendingLogin = { login, write };
    const clear = () => {
      if (this.pendingLogin?.login === login) this.pendingLogin = undefined;
      this.invalidate();
    };
    login.result.then(clear, clear);
    return login;
  }

  private async resolve(): Promise<TokenSource> {
    const scopes = [runtimeSettings(this.env).readOnly ? SCOPE_READONLY : SCOPE_FULL];

    const keyFile = this.env.GSC_SERVICE_ACCOUNT_KEY_FILE;
    if (keyFile) {
      const key = JSON.parse(await readFile(keyFile, 'utf8')) as { client_email?: string };
      const auth = new GoogleAuth({ keyFile, scopes });
      return fromAuthClient(await auth.getClient(), {
        method: 'service_account',
        account: key.client_email,
        canWrite: scopes[0] === SCOPE_FULL,
        source: keyFile,
      });
    }

    const stored = await readStoredCredentials(this.credentialsPath);
    if (stored) return this.fromStored(stored);

    // ADC is opt-in: GOOGLE_APPLICATION_CREDENTIALS is often set for unrelated projects.
    if (this.env.GSC_AUTH === 'adc') {
      const auth = new GoogleAuth({ scopes });
      const client = await auth.getClient();
      const credentials = await auth.getCredentials().catch(() => ({ client_email: undefined }));
      return fromAuthClient(client, {
        method: 'adc',
        account: credentials.client_email ?? undefined,
        canWrite: scopes[0] === SCOPE_FULL,
        source: this.env.GOOGLE_APPLICATION_CREDENTIALS ?? 'gcloud application default credentials',
      });
    }

    const client = await this.oauthClientConfig().catch(() => undefined);
    throw new NotAuthenticatedError(
      client
        ? 'Not signed in to Google Search Console. Call the `login` tool to sign in through your browser, or run `npx @portside-labs/gsc-mcp auth` in a terminal.'
        : `Not signed in to Google Search Console. ${SETUP_HINT}`,
    );
  }

  private fromStored(stored: StoredCredentials): TokenSource {
    const oauth = new OAuth2Client({ clientId: stored.clientId, clientSecret: stored.clientSecret });
    oauth.setCredentials({ refresh_token: stored.refreshToken });
    // Google rarely rotates refresh tokens, but keep the file current if it does.
    oauth.on('tokens', (tokens) => {
      if (tokens.refresh_token && tokens.refresh_token !== stored.refreshToken) {
        stored = { ...stored, refreshToken: tokens.refresh_token };
        writeStoredCredentials(this.credentialsPath, stored).catch((error: Error) =>
          process.stderr.write(`gsc-mcp: could not save the refreshed Google token: ${error.message}\n`),
        );
      }
    });
    return fromAuthClient(oauth, {
      method: 'oauth',
      account: stored.email,
      canWrite: stored.scope.split(/\s+/).includes(SCOPE_FULL),
      source: this.credentialsPath,
    });
  }
}

function fromAuthClient(client: AuthClient, info: AuthInfo): TokenSource {
  return {
    info,
    async getRequestHeaders(url) {
      try {
        const headers: Record<string, string> = {};
        (await client.getRequestHeaders(url)).forEach((value, key) => {
          headers[key] = value;
        });
        if (!headers.authorization) throw new Error('Google returned no access token.');
        return headers;
      } catch (error) {
        throw explainTokenError(error, info);
      }
    },
  };
}

function explainTokenError(error: unknown, info: AuthInfo): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (info.method === 'oauth' && /invalid_grant|expired or revoked/i.test(message)) {
    return new NotAuthenticatedError(
      'Your Google sign-in has expired or was revoked (invalid_grant). Call the `login` tool or run `npx @portside-labs/gsc-mcp auth` to sign in again. ' +
        'If this keeps happening every 7 days, your OAuth consent screen is in "Testing" mode: publish it to "In production" in Google Cloud Console.',
    );
  }
  return new Error(`Could not get a Google access token: ${message}`);
}
