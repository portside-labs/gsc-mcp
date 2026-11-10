import { USER_AGENT } from '../config.js';
import type { TokenSource } from '../auth/provider.js';
import type {
  GscApi,
  SearchAnalyticsRequest,
  SearchAnalyticsResponse,
  Site,
  Sitemap,
  UrlInspectionResult,
} from './types.js';

const WEBMASTERS = 'https://searchconsole.googleapis.com/webmasters/v3';
const INSPECTION = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

export class GscApiError extends Error {
  override name = 'GscApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
  }
}

export interface GscClientOptions {
  getTokenSource: () => Promise<TokenSource>;
  fetch?: typeof fetch;
  /** Retries for 429, 5xx and network errors. */
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export class GscClient implements GscApi {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GscClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listSites(): Promise<Site[]> {
    const body = await this.request<{ siteEntry?: Site[] }>('GET', `${WEBMASTERS}/sites`);
    return body.siteEntry ?? [];
  }

  searchAnalytics(siteUrl: string, request: SearchAnalyticsRequest): Promise<SearchAnalyticsResponse> {
    return this.request('POST', `${WEBMASTERS}/sites/${enc(siteUrl)}/searchAnalytics/query`, request, siteUrl);
  }

  async inspectUrl(siteUrl: string, inspectionUrl: string, languageCode?: string): Promise<UrlInspectionResult> {
    const body = await this.request<{ inspectionResult?: UrlInspectionResult }>(
      'POST',
      INSPECTION,
      { inspectionUrl, siteUrl, ...(languageCode ? { languageCode } : {}) },
      siteUrl,
    );
    return body.inspectionResult ?? {};
  }

  async listSitemaps(siteUrl: string): Promise<Sitemap[]> {
    const body = await this.request<{ sitemap?: Sitemap[] }>('GET', `${WEBMASTERS}/sites/${enc(siteUrl)}/sitemaps`, undefined, siteUrl);
    return body.sitemap ?? [];
  }

  async submitSitemap(siteUrl: string, feedpath: string): Promise<void> {
    await this.request('PUT', `${WEBMASTERS}/sites/${enc(siteUrl)}/sitemaps/${enc(feedpath)}`, undefined, siteUrl);
  }

  async deleteSitemap(siteUrl: string, feedpath: string): Promise<void> {
    await this.request('DELETE', `${WEBMASTERS}/sites/${enc(siteUrl)}/sitemaps/${enc(feedpath)}`, undefined, siteUrl);
  }

  private async request<T>(method: string, url: string, body?: unknown, siteUrl?: string): Promise<T> {
    const tokenSource = await this.options.getTokenSource();
    const maxRetries = this.options.maxRetries ?? 3;
    const baseDelay = this.options.retryDelayMs ?? 500;

    for (let attempt = 0; ; attempt++) {
      const delay = (retryAfter?: number) =>
        new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter ? retryAfter * 1000 : baseDelay * 2 ** attempt, 10_000)));
      const headers = await tokenSource.getRequestHeaders(url);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            ...headers,
            'user-agent': USER_AGENT,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
        });
      } catch (error) {
        if (attempt < maxRetries) {
          await delay();
          continue;
        }
        const message = error instanceof Error && error.name === 'TimeoutError' ? 'the request timed out' : String((error as Error)?.message ?? error);
        throw new GscApiError(`Could not reach the Search Console API: ${message}.`, 0);
      }

      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : {}) as T;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
        continue;
      }
      throw await toApiError(response, { method, url, siteUrl }, tokenSource);
    }
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: { reason?: string; message?: string }[];
    details?: { reason?: string; metadata?: Record<string, string> }[];
  };
}

interface RequestInfo {
  method: string;
  url: string;
  siteUrl?: string;
}

async function toApiError(response: Response, request: RequestInfo, tokenSource: TokenSource): Promise<GscApiError> {
  const { siteUrl } = request;
  const isWrite = request.method === 'PUT' || request.method === 'DELETE';
  const method = tokenSource.info.method;
  const text = await response.text().catch(() => '');
  let parsed: GoogleErrorBody = {};
  try {
    parsed = JSON.parse(text) as GoogleErrorBody;
  } catch {
    // Non-JSON error body; fall back to the raw text below.
  }
  const error = parsed.error ?? {};
  const message = error.message ?? (text.slice(0, 300) || response.statusText);
  const reason = error.details?.find((d) => d.reason)?.reason ?? error.errors?.find((e) => e.reason)?.reason ?? error.status;
  const status = response.status;

  if (reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/i.test(message)) {
    const activation = error.details?.find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl;
    return new GscApiError(
      `The Google Search Console API is not enabled for your Google Cloud project. Enable it${activation ? ` at ${activation}` : ' under APIs & Services > Library'}, wait a minute, then retry.`,
      status,
      reason,
    );
  }
  if (status === 401) {
    return new GscApiError(`Google rejected the credentials (${message}). Sign in again with the \`login\` tool or \`npx @portside-labs/gsc-mcp auth\`.`, status, reason);
  }
  if (status === 403 && (reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || /insufficient authentication scopes/i.test(message))) {
    if (method === 'adc') {
      return new GscApiError(
        'The Application Default Credentials do not include Search Console access. Run `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/webmasters,https://www.googleapis.com/auth/cloud-platform` (with your own OAuth client via --client-id-file if gcloud\'s is blocked), or sign in with `npx @portside-labs/gsc-mcp auth` instead.',
        status,
        reason,
      );
    }
    if (!isWrite) return new GscApiError(`The credentials do not grant Search Console access (${message}). Sign in again with \`npx @portside-labs/gsc-mcp auth\`.`, status, reason);
    const hint =
      method === 'oauth'
        ? 'Sign in again with write access: call `login` with write=true, or run `npx @portside-labs/gsc-mcp auth --write`.'
        : 'Unset GSC_MCP_READ_ONLY so the full webmasters scope is requested.';
    return new GscApiError(`This action needs write access to Search Console, but the current credentials are read-only. ${hint}`, status, reason);
  }
  if (status === 403 && method === 'adc' && /quota project|x-goog-user-project|billing/i.test(message)) {
    return new GscApiError(
      `Google needs a quota project for these credentials: run \`gcloud auth application-default set-quota-project <your-project-id>\` for a project with the Search Console API enabled. Google said: ${message}`,
      status,
      reason,
    );
  }
  if (status === 403 && siteUrl && /permission/i.test(message)) {
    const who = tokenSource.info.account ? ` (${tokenSource.info.account})` : '';
    return new GscApiError(
      `The signed-in account${who} does not have sufficient access to "${siteUrl}" for this request. Use \`list_sites\` to see the exact property names you can use${method === 'oauth' ? '' : ', and make sure the service account is added as a user on the property in Search Console'}. Google said: ${message}`,
      status,
      reason,
    );
  }
  if (status === 429) {
    const limits = request.url.startsWith(INSPECTION)
      ? 'URL Inspection allows 2,000 inspections per property per day and 600 per minute.'
      : 'Search Analytics allows 1,200 queries per minute per property and also limits heavy queries over 10-minute and daily windows.';
    return new GscApiError(`Search Console API quota exceeded (${message}). ${limits} Wait a few minutes and try again.`, status, reason);
  }
  return new GscApiError(`Search Console API error ${status}: ${message}`, status, reason);
}
