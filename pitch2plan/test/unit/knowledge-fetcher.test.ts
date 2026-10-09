import { describe, expect, it } from 'vitest';
import { FetchError, HttpDocumentFetcher, extractDocument, detectProductVersion } from '@pitch2plan/domain';
import { HashingEmbeddingProvider } from '@pitch2plan/ai';

const ALLOW = ['docs.aws.amazon.com'];
const res = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
const fetcher = (impl: (url: string, init?: RequestInit) => Promise<Response>, o = {}) => new HttpDocumentFetcher({ fetchImpl: impl as typeof fetch, ...o });
const code = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { return e instanceof FetchError ? e.code : `OTHER:${String(e)}`; } };

describe('HttpDocumentFetcher (K5: only allow-listed hosts)', () => {
  it('fetches an allowed page', async () => {
    const f = fetcher(async () => res('<html><title>T</title><main><h1>H</h1><p>body</p></main></html>'));
    const d = await f.fetch('https://docs.aws.amazon.com/a', { allowedDomains: ALLOW });
    expect(d.finalUrl).toBe('https://docs.aws.amazon.com/a');
    expect(d.body).toContain('body');
  });
  it('never calls out for a URL outside the allow-list', async () => {
    let calls = 0;
    const f = fetcher(async () => { calls++; return res('x'); });
    expect(await code(f.fetch('https://evil.example.com/a', { allowedDomains: ALLOW }))).toBe('URL_NOT_ALLOWED');
    expect(await code(f.fetch('http://docs.aws.amazon.com/a', { allowedDomains: ALLOW }))).toBe('URL_NOT_ALLOWED');
    expect(calls).toBe(0);
  });
  it('re-validates every redirect hop and refuses to leave the allow-list', async () => {
    const calls: string[] = [];
    const f = fetcher(async (url) => { calls.push(url); return url.includes('docs.aws') ? new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } }) : res('leaked'); });
    expect(await code(f.fetch('https://docs.aws.amazon.com/a', { allowedDomains: ALLOW }))).toBe('REDIRECT_NOT_ALLOWED');
    expect(calls).toEqual(['https://docs.aws.amazon.com/a']); // the evil host was never contacted
  });
  it('follows redirects that stay on allowed hosts, relative ones included', async () => {
    const f = fetcher(async (url) => (url.endsWith('/old') ? new Response(null, { status: 301, headers: { location: '/new' } }) : res('<p>moved here</p>')));
    const d = await f.fetch('https://docs.aws.amazon.com/old', { allowedDomains: ALLOW });
    expect(d.finalUrl).toBe('https://docs.aws.amazon.com/new');
  });
  it('stops redirect loops', async () => {
    const f = fetcher(async () => new Response(null, { status: 302, headers: { location: '/loop' } }));
    expect(await code(f.fetch('https://docs.aws.amazon.com/loop', { allowedDomains: ALLOW }))).toBe('TOO_MANY_REDIRECTS');
  });
  it('rejects non-text content, oversized pages, and maps HTTP errors with retryability', async () => {
    expect(await code(fetcher(async () => res('%PDF', { headers: { 'content-type': 'application/pdf' } })).fetch('https://docs.aws.amazon.com/a', { allowedDomains: ALLOW }))).toBe('UNSUPPORTED_CONTENT_TYPE');
    expect(await code(fetcher(async () => res('x'.repeat(5000)), { maxBytes: 1000 }).fetch('https://docs.aws.amazon.com/a', { allowedDomains: ALLOW }))).toBe('TOO_LARGE');
    expect(await code(fetcher(async () => res('', { status: 404 })).fetch('https://docs.aws.amazon.com/a', { allowedDomains: ALLOW }))).toBe('NOT_FOUND');
    const e503 = await fetcher(async () => res('', { status: 503 })).fetch('https://docs.aws.amazon.com/a', { allowedDomains: ALLOW }).catch((x) => x as FetchError);
    expect(e503).toMatchObject({ code: 'HTTP_ERROR', retryable: true });
    const e403 = await fetcher(async () => res('', { status: 403 })).fetch('https://docs.aws.amazon.com/a', { allowedDomains: ALLOW }).catch((x) => x as FetchError);
    expect(e403).toMatchObject({ code: 'HTTP_ERROR', retryable: false });
  });
  it('times out a stalled server instead of hanging', async () => {
    const f = fetcher((_u, init) => new Promise((_r, rej) => { init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }), { timeoutMs: 50 });
    expect(await code(f.fetch('https://docs.aws.amazon.com/a', { allowedDomains: ALLOW }))).toBe('TIMEOUT');
  });
  it('sends no cookies or credentials', async () => {
    let init: RequestInit | undefined;
    await fetcher(async (_u, i) => { init = i; return res('<p>x</p>'); }).fetch('https://docs.aws.amazon.com/a', { allowedDomains: ALLOW });
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual' });
  });
});

describe('extractDocument', () => {
  const page = `<html><head><title>Guide &amp; more</title><meta property="article:modified_time" content="2026-09-01T00:00:00Z"></head><body>
    <nav>MENU MENU</nav><script>alert(1)</script><main><h1>Main title</h1><p>First   paragraph &lt;ok&gt;.</p><h2>Part</h2><ul><li>one</li><li>two</li></ul><pre>cmd --flag</pre></main><footer>FOOTER</footer></body></html>`;
  it('keeps content and headings, drops chrome and scripts, decodes entities', () => {
    const d = extractDocument(page, 'text/html');
    expect(d.title).toBe('Guide & more');
    expect(d.text).toContain('# Main title');
    expect(d.text).toContain('# Part');
    expect(d.text).toContain('First paragraph <ok>.');
    expect(d.text).toContain('- one');
    expect(d.text).toContain('cmd --flag');
    expect(d.text).not.toMatch(/MENU|FOOTER|alert/);
    expect(d.updatedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
  it('passes plain text through', () => { expect(extractDocument('# T\n\nhello', 'text/plain').title).toBe('T'); });
});

describe('product version detection never guesses', () => {
  it('reads explicit versions and leaves "current"/"latest" unknown', () => {
    expect(detectProductVersion('postgresql', 'https://www.postgresql.org/docs/16/runtime.html', 'x')).toBe('16');
    expect(detectProductVersion('postgresql', 'https://www.postgresql.org/docs/current/runtime.html', 'x')).toBeNull();
    expect(detectProductVersion('aws-s3', 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/x.html', 'S3 guide')).toBeNull();
    expect(detectProductVersion('kubernetes', 'https://kubernetes.io/docs/x', 'Service | Kubernetes v1.31')).toBe('1.31');
  });
});

describe('hashing embedder', () => {
  it('is deterministic, normalized, and states that it is not semantic', async () => {
    const e = new HashingEmbeddingProvider();
    const [a, b] = await e.embed(['consumer lag in kafka', 'consumer lag in kafka']);
    expect(a).toEqual(b);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 5);
    expect(e.semantic).toBe(false);
    expect(e.meta).toMatchObject({ provider: 'local', model: 'hashing-v1', dimensions: 256 });
  });
});
