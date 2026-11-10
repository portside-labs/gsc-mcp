import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

export const PACKAGE_NAME = pkg.name;
export const VERSION = pkg.version;
export const USER_AGENT = `gsc-mcp/${VERSION} (+https://github.com/portside-labs/gsc-mcp)`;

export const SCOPE_READONLY = 'https://www.googleapis.com/auth/webmasters.readonly';
export const SCOPE_FULL = 'https://www.googleapis.com/auth/webmasters';
/** Identity scopes, only used so `status` can show which Google account is connected. */
export const SCOPES_IDENTITY = ['openid', 'email'];

/**
 * Directory holding the stored OAuth credentials.
 * GSC_MCP_HOME wins; otherwise %APPDATA%\gsc-mcp on Windows and $XDG_CONFIG_HOME/gsc-mcp (~/.config/gsc-mcp) elsewhere.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GSC_MCP_HOME) return env.GSC_MCP_HOME;
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'gsc-mcp');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'gsc-mcp');
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.GSC_MCP_CREDENTIALS || join(configDir(env), 'credentials.json');
}

export interface RuntimeSettings {
  /** Property used when a tool call omits `site`. */
  defaultSite?: string;
  /** Hide tools that change Search Console state (sitemap submit/delete). */
  readOnly: boolean;
  /** Let the page audit tool fetch localhost and private-network addresses. */
  allowPrivateUrls: boolean;
}

export function runtimeSettings(env: NodeJS.ProcessEnv = process.env): RuntimeSettings {
  return {
    defaultSite: env.GSC_DEFAULT_SITE?.trim() || undefined,
    readOnly: isTruthy(env.GSC_MCP_READ_ONLY),
    allowPrivateUrls: isTruthy(env.GSC_MCP_ALLOW_PRIVATE_URLS),
  };
}

/**
 * Claude Desktop bundles (.mcpb) map optional settings to env vars; an unset one can arrive empty or
 * as its literal `${user_config.x}` placeholder. Treat both as unset.
 */
export function dropUnsetPlaceholders(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('GSC_') && (value === '' || /^\$\{user_config\.[^}]+\}$/.test(value ?? ''))) delete env[key];
  }
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
