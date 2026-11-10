import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface OAuthClientConfig {
  clientId: string;
  clientSecret?: string;
}

export interface StoredCredentials extends OAuthClientConfig {
  type: 'oauth';
  refreshToken: string;
  /** Space-separated scopes Google granted. */
  scope: string;
  email?: string;
  createdAt: string;
}

export async function readStoredCredentials(path: string): Promise<StoredCredentials | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
  if (parsed.type !== 'oauth' || !parsed.clientId || !parsed.refreshToken) {
    throw new Error(`Credentials file ${path} is not valid. Run \`gsc-mcp auth\` to sign in again.`);
  }
  return { scope: '', createdAt: '', ...parsed } as StoredCredentials;
}

/** Writes the credentials with owner-only permissions (0600 file in a 0700 directory). */
export async function writeStoredCredentials(path: string, credentials: StoredCredentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

export async function deleteStoredCredentials(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Modification time in ms, or 0 when the file does not exist. Used to notice a fresh `gsc-mcp auth`. */
export async function credentialsMtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Reads a client secret JSON downloaded from Google Cloud Console.
 * Accepts the "installed" (Desktop app) and "web" shapes, or a bare {client_id, client_secret}.
 */
export async function readClientSecretFile(path: string): Promise<OAuthClientConfig> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const section = (parsed.installed ?? parsed.web ?? parsed) as Record<string, unknown>;
  const clientId = section.client_id;
  const clientSecret = section.client_secret;
  if (typeof clientId !== 'string' || !clientId) {
    throw new Error(`${path} does not look like an OAuth client file (no client_id). Download it from Google Cloud Console > APIs & Services > Credentials.`);
  }
  if (parsed.web && !parsed.installed) {
    process.stderr.write(
      'Warning: this is a "Web application" OAuth client. Create a "Desktop app" client instead, or the loopback redirect will be rejected.\n',
    );
  }
  return { clientId, clientSecret: typeof clientSecret === 'string' ? clientSecret : undefined };
}
