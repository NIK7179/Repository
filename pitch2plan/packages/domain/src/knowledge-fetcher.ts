import { validateSourceUrl } from '@pitch2plan/schemas';
import type { DocumentFetcher, FetchedDocument } from './ports';

export type FetchErrorCode = 'URL_NOT_ALLOWED' | 'REDIRECT_NOT_ALLOWED' | 'TOO_MANY_REDIRECTS' | 'HTTP_ERROR' | 'UNSUPPORTED_CONTENT_TYPE' | 'TOO_LARGE' | 'TIMEOUT' | 'NETWORK_ERROR' | 'FIXTURES_DISABLED' | 'NOT_FOUND';
export class FetchError extends Error {
  constructor(public readonly code: FetchErrorCode, message: string, public readonly retryable = false) { super(message); this.name = 'FetchError'; }
}

export interface HttpFetcherOptions { timeoutMs?: number; maxBytes?: number; maxRedirects?: number; userAgent?: string; fetchImpl?: typeof fetch }

/**
 * Production fetcher. Security properties (each covered by test/unit/knowledge-fetcher.test.ts):
 *  - redirects are followed manually and EVERY hop is re-validated against the allow-list;
 *  - only text-like content types, size-capped while streaming, with a timeout;
 *  - no cookies, no credentials, no referrer.
 */
export class HttpDocumentFetcher implements DocumentFetcher {
  constructor(private readonly o: HttpFetcherOptions = {}) {}
  async fetch(url: string, opts: { allowedDomains: string[]; signal?: AbortSignal }): Promise<FetchedDocument> {
    const f = this.o.fetchImpl ?? fetch; const maxRedirects = this.o.maxRedirects ?? 4; const maxBytes = this.o.maxBytes ?? 2_000_000;
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const check = validateSourceUrl(current, opts.allowedDomains);
      if (!check.ok) throw new FetchError(hop === 0 ? 'URL_NOT_ALLOWED' : 'REDIRECT_NOT_ALLOWED', check.reason);
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 15_000);
      const onAbort = () => ctl.abort(); opts.signal?.addEventListener('abort', onAbort);
      try {
        const res = await f(check.url, { redirect: 'manual', signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { accept: 'text/html,text/plain,text/markdown;q=0.9', 'user-agent': this.o.userAgent ?? 'Pitch2PlanDocsBot/1.0 (+documentation indexing; allow-listed hosts only)' } });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location'); void res.body?.cancel().catch(() => undefined);
          if (!loc) throw new FetchError('HTTP_ERROR', `Redirect without a location (${res.status}).`);
          current = new URL(loc, check.url).toString(); continue;
        }
        if (res.status === 404 || res.status === 410) throw new FetchError('NOT_FOUND', 'The page does not exist (anymore).');
        if (!res.ok) throw new FetchError('HTTP_ERROR', `The documentation server answered ${res.status}.`, res.status >= 500 || res.status === 429);
        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        if (!/^(text\/(html|plain|markdown)|application\/xhtml\+xml)/.test(contentType)) { void res.body?.cancel().catch(() => undefined); throw new FetchError('UNSUPPORTED_CONTENT_TYPE', `Unsupported content type: ${contentType || 'unknown'}.`); }
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > maxBytes) { void res.body?.cancel().catch(() => undefined); throw new FetchError('TOO_LARGE', 'The page is too large.'); }
        const reader = res.body?.getReader(); const parts: Uint8Array[] = []; let size = 0;
        if (reader) for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > maxBytes) { void reader.cancel().catch(() => undefined); throw new FetchError('TOO_LARGE', 'The page is too large.'); }
          parts.push(value);
        }
        const lm = res.headers.get('last-modified'); const lmd = lm ? new Date(lm) : null;
        return { finalUrl: check.url, contentType, body: new TextDecoder('utf-8').decode(Buffer.concat(parts)), lastModified: lmd && !Number.isNaN(lmd.getTime()) ? lmd : null };
      } catch (e) {
        if (e instanceof FetchError) throw e;
        if ((e as { name?: string }).name === 'AbortError') throw new FetchError('TIMEOUT', 'The documentation server did not answer in time.', true);
        throw new FetchError('NETWORK_ERROR', 'The documentation server could not be reached.', true);
      } finally { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); }
    }
    throw new FetchError('TOO_MANY_REDIRECTS', 'Too many redirects.');
  }
}
