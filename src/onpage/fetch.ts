import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { lookup as dnsLookupAsync } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate, gunzipSync } from 'node:zlib';
import { USER_AGENT } from '../config.js';

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  redirects: { url: string; status: number }[];
  headers: Record<string, string>;
  body: string;
  /** True when the body was cut at maxBytes. */
  truncated: boolean;
  responseTimeMs: number;
}

/** One HTTP exchange. The default uses node:http(s); tests swap in a fake. */
export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}
export type Transport = (url: URL, options: { allowPrivate: boolean; signal: AbortSignal; headers: Record<string, string> }) => Promise<RawResponse>;

export interface FetchPageOptions {
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  transport?: Transport;
}

export type PageFetcher = (url: string, options?: FetchPageOptions) => Promise<FetchedPage>;

const privateRanges = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  privateRanges.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  privateRanges.addSubnet(net, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateRanges.check(mapped[1]!, 'ipv4');
  const family = isIP(address);
  if (family === 4) return privateRanges.check(address, 'ipv4');
  if (family === 6) return privateRanges.check(address, 'ipv6');
  return false;
}

const PRIVATE_HINT = 'Set GSC_MCP_ALLOW_PRIVATE_URLS=1 in the server environment to audit local or staging sites.';

/**
 * DNS lookup used for every connection: rejects private answers at connect time, so a hostname that
 * resolves differently on a second lookup (DNS rebinding) cannot reach the local network.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 4);
    const list = addresses as unknown as LookupAddress[];
    const blocked = list.find((a) => isPrivateAddress(a.address));
    if (blocked || list.length === 0) {
      return callback(new Error(`${hostname} resolves to a private or local network address (${blocked?.address ?? 'none'}), which is blocked. ${PRIVATE_HINT}`), '', 4);
    }
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

/** Fast, readable rejection before connecting; guardedLookup is what actually enforces it. */
async function assertPublicUrl(url: URL, allowPrivate: boolean): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs can be audited (got ${url.protocol}).`);
  }
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await dnsLookupAsync(host, { all: true })).map((a) => a.address);
  if (host === 'localhost' || addresses.some(isPrivateAddress)) {
    throw new Error(`${url.hostname} resolves to a private or local network address, which is blocked. ${PRIVATE_HINT}`);
  }
}

export const nodeTransport: Transport = (url, { allowPrivate, signal, headers }) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET',
      headers: { ...headers, 'accept-encoding': 'gzip, deflate, br' },
      signal,
      ...(allowPrivate ? {} : { lookup: guardedLookup }),
    });
    request.once('error', reject);
    request.once('response', (response) => {
      const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
      const decoder =
        encoding === 'gzip' || encoding === 'x-gzip'
          ? createGunzip()
          : encoding === 'br'
            ? createBrotliDecompress()
            : encoding === 'deflate'
              ? createInflate()
              : undefined;
      const body: Readable = decoder ? response.pipe(decoder) : response;
      if (decoder) response.once('error', (error) => decoder.destroy(error));
      const flat: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined) flat[key] = Array.isArray(value) ? value.join(', ') : value;
      }
      resolve({
        status: response.statusCode ?? 0,
        headers: flat,
        body,
        destroy: () => {
          response.destroy();
          decoder?.destroy();
        },
      });
    });
    request.end();
  });

export const fetchPage: PageFetcher = async (input, options = {}) => {
  const transport = options.transport ?? nodeTransport;
  const allowPrivate = options.allowPrivate ?? false;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 10;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const redirects: FetchedPage['redirects'] = [];
  const started = Date.now();
  let url = new URL(input);

  for (;;) {
    await assertPublicUrl(url, allowPrivate);
    const response = await transport(url, {
      allowPrivate,
      signal,
      headers: {
        'user-agent': `Mozilla/5.0 (compatible; ${USER_AGENT})`,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.8',
      },
    });

    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location) {
      response.destroy();
      redirects.push({ url: url.href, status: response.status });
      if (redirects.length > maxRedirects) throw new Error(`Too many redirects (more than ${maxRedirects}) starting at ${input}.`);
      url = new URL(location, url);
      continue;
    }

    const { bytes, truncated } = await readLimited(response, maxBytes);
    return {
      requestedUrl: input,
      finalUrl: url.href,
      status: response.status,
      redirects,
      headers: response.headers,
      body: decodeBody(bytes, response.headers['content-type'], maxBytes),
      truncated,
      responseTimeMs: Date.now() - started,
    };
  }
};

async function readLimited(response: RawResponse, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    size += chunk.byteLength;
    if (size >= maxBytes) {
      response.destroy();
      return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), truncated: true };
    }
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
}

/** Handles .gz files served without Content-Encoding (common for sitemaps) and non-UTF-8 pages. */
export function decodeBody(bytes: Buffer, contentType: string | undefined, maxBytes = 5 * 1024 * 1024): string {
  let data = bytes;
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try {
      data = gunzipSync(data, { maxOutputLength: maxBytes });
    } catch {
      // Truncated or oversized archive: fall through and decode what we have.
    }
  }
  const charset =
    contentType?.match(/charset=["']?([\w-]+)/i)?.[1] ??
    data.subarray(0, 2048).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ??
    data.subarray(0, 200).toString('latin1').match(/<\?xml[^>]+encoding=["']([\w-]+)/i)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(charset).decode(data);
  } catch {
    return new TextDecoder('utf-8').decode(data);
  }
}
