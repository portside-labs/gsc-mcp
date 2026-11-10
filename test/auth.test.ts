import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailFromIdToken, startLogin } from '../src/auth/oauth.js';
import { AuthManager, NotAuthenticatedError } from '../src/auth/provider.js';
import { readClientSecretFile, readStoredCredentials, writeStoredCredentials } from '../src/auth/store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gsc-mcp-test-'));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('credential store', () => {
  it('writes credentials readable only by the owner', async () => {
    const path = join(dir, 'nested', 'credentials.json');
    await writeStoredCredentials(path, {
      type: 'oauth',
      clientId: 'cid',
      clientSecret: 'secret',
      refreshToken: 'rt',
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      createdAt: '2026-11-10T00:00:00Z',
    });
    // Windows has no POSIX permission bits.
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readStoredCredentials(path)).toMatchObject({ clientId: 'cid', refreshToken: 'rt' });
    expect(await readStoredCredentials(join(dir, 'missing.json'))).toBeUndefined();
  });

  it('reads Desktop app client files', async () => {
    const path = join(dir, 'client.json');
    await writeFile(path, JSON.stringify({ installed: { client_id: 'abc.apps.googleusercontent.com', client_secret: 'GOCSPX-x' } }));
    expect(await readClientSecretFile(path)).toEqual({ clientId: 'abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-x' });
    await writeFile(path, JSON.stringify({ nope: true }));
    await expect(readClientSecretFile(path)).rejects.toThrow(/client_id/);
  });

  it('reads the email from an id token', () => {
    expect(emailFromIdToken(idToken({ email: 'me@example.com' }))).toBe('me@example.com');
    expect(emailFromIdToken(undefined)).toBeUndefined();
    expect(emailFromIdToken('garbage')).toBeUndefined();
  });
});

describe('browser login', () => {
  it('exchanges the code from the loopback redirect and saves credentials', async () => {
    const getToken = vi.spyOn(OAuth2Client.prototype, 'getToken').mockImplementation((async () => ({
      tokens: {
        refresh_token: 'refresh-1',
        access_token: 'access-1',
        scope: 'https://www.googleapis.com/auth/webmasters.readonly openid https://www.googleapis.com/auth/userinfo.email',
        id_token: idToken({ email: 'owner@example.com' }),
      },
      res: null,
    })) as never);

    const credentialsPath = join(dir, 'credentials.json');
    const login = await startLogin({ client: { clientId: 'cid', clientSecret: 'cs' }, write: false, credentialsPath, openBrowser: false });
    const authUrl = new URL(login.url);
    expect(authUrl.origin).toBe('https://accounts.google.com');
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('scope')).toContain('webmasters.readonly');
    const redirect = authUrl.searchParams.get('redirect_uri')!;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);

    const wrongState = await fetch(`${redirect}?code=abc&state=nope`);
    expect(wrongState.status).toBe(400);

    const ok = await fetch(`${redirect}?code=abc&state=${authUrl.searchParams.get('state')}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('owner@example.com');

    const credentials = await login.result;
    expect(credentials).toMatchObject({ refreshToken: 'refresh-1', email: 'owner@example.com', clientId: 'cid' });
    expect(getToken).toHaveBeenCalledWith(expect.objectContaining({ code: 'abc', codeVerifier: expect.any(String) }));
    expect(JSON.parse(await readFile(credentialsPath, 'utf8'))).toMatchObject({ refreshToken: 'refresh-1' });
  });

  it('survives malformed requests to the callback listener', async () => {
    const login = await startLogin({ client: { clientId: 'cid' }, write: false, credentialsPath: join(dir, 'c.json'), openBrowser: false });
    const redirect = new URL(new URL(login.url).searchParams.get('redirect_uri')!);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: redirect.port, path: '//[' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.once('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    // Still listening afterwards.
    expect((await fetch(`${redirect.origin}/elsewhere`)).status).toBe(404);
    login.cancel();
    await expect(login.result).rejects.toThrow(/cancelled/);
  });

  it('reports a denied consent', async () => {
    const login = await startLogin({ client: { clientId: 'cid' }, write: true, credentialsPath: join(dir, 'c.json'), openBrowser: false });
    const authUrl = new URL(login.url);
    expect(authUrl.searchParams.get('scope')).toContain('auth/webmasters ');
    const redirect = authUrl.searchParams.get('redirect_uri')!;
    await fetch(`${redirect}?error=access_denied&state=${authUrl.searchParams.get('state')}`);
    await expect(login.result).rejects.toThrow(/access_denied/);
  });
});

describe('AuthManager', () => {
  it('explains how to connect when nothing is configured', async () => {
    const manager = new AuthManager({ GSC_MCP_HOME: dir });
    await expect(manager.getTokenSource()).rejects.toThrow(NotAuthenticatedError);
    await expect(manager.getTokenSource()).rejects.toThrow(/Desktop app/);
    expect(await manager.status()).toBeUndefined();
  });

  it('points to the login tool when an OAuth client is available', async () => {
    const manager = new AuthManager({ GSC_MCP_HOME: dir, GSC_OAUTH_CLIENT_ID: 'cid' });
    await expect(manager.getTokenSource()).rejects.toThrow(/`login` tool/);
  });

  it('loads saved OAuth credentials and picks up a new sign-in', async () => {
    const manager = new AuthManager({ GSC_MCP_HOME: dir });
    expect(await manager.status()).toBeUndefined();
    await writeStoredCredentials(manager.credentialsPath, {
      type: 'oauth',
      clientId: 'cid',
      refreshToken: 'rt',
      scope: 'https://www.googleapis.com/auth/webmasters openid',
      email: 'me@example.com',
      createdAt: '2026-11-10T00:00:00Z',
    });
    expect(await manager.status()).toMatchObject({ method: 'oauth', account: 'me@example.com', canWrite: true });
  });

  it('turns a revoked refresh token into a sign-in prompt', async () => {
    vi.spyOn(OAuth2Client.prototype, 'getRequestHeaders').mockRejectedValue(new Error('invalid_grant: Token has been expired or revoked.'));
    const manager = new AuthManager({ GSC_MCP_HOME: dir });
    await writeStoredCredentials(manager.credentialsPath, {
      type: 'oauth',
      clientId: 'cid',
      refreshToken: 'rt',
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      createdAt: '2026-11-10T00:00:00Z',
    });
    const source = await manager.getTokenSource();
    await expect(source.getRequestHeaders('https://searchconsole.googleapis.com/')).rejects.toThrow(/expired or was revoked.*Testing/);
  });

  it('shares one token source across parallel requests', async () => {
    const manager = new AuthManager({ GSC_MCP_HOME: dir });
    await writeStoredCredentials(manager.credentialsPath, {
      type: 'oauth',
      clientId: 'cid',
      refreshToken: 'rt',
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      createdAt: '2026-11-10T00:00:00Z',
    });
    const sources = await Promise.all(Array.from({ length: 7 }, () => manager.getTokenSource()));
    expect(new Set(sources).size).toBe(1);
  });

  it('ignores GOOGLE_APPLICATION_CREDENTIALS unless GSC_AUTH=adc', async () => {
    const manager = new AuthManager({ GSC_MCP_HOME: dir, GOOGLE_APPLICATION_CREDENTIALS: join(dir, 'unrelated.json') });
    expect(await manager.status()).toBeUndefined();
  });
});
