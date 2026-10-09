import { normalizeText } from '@pitch2plan/schemas';

export interface ExtractedDocument { title: string; text: string; updatedAt: Date | null; publishedAt: Date | null }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
  if (g[0] === '#') { const n = g[1]!.toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10); return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENTITIES[g.toLowerCase()] ?? m;
});
const meta = (html: string, key: string): Date | null => {
  const m = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']`, 'i').exec(html) ?? new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, 'i').exec(html);
  const d = m ? new Date(m[1]!) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/** Lightweight, dependency-free extraction: drops page chrome, keeps headings (as "# Title" lines), paragraphs, lists and code. Not a general HTML parser. */
export function extractDocument(raw: string, contentType: string): ExtractedDocument {
  if (!/html/i.test(contentType)) {
    const text = normalizeText(raw);
    return { title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? '', text, updatedAt: null, publishedAt: null };
  }
  let html = raw.replace(/<!--[\s\S]*?-->/g, ' ');
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const updatedAt = meta(html, 'article:modified_time') ?? meta(html, 'last-modified') ?? meta(html, 'og:updated_time');
  const publishedAt = meta(html, 'article:published_time');
  html = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|button|iframe|template|select)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html) ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  if (main) html = main[1]!;
  html = html
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, _l: string, inner: string) => `\n\n# ${inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => `\n\n${inner.replace(/<[^>]+>/g, '')}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ').replace(/<(br|tr)\b[^>]*>/gi, '\n').replace(/<\/(p|div|section|table|ul|ol|dl|dt|dd|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  const text = normalizeText(decode(html).split('\n').map((l) => (l.startsWith('# ') || l.startsWith('- ') ? l : l.replace(/[ \t]+/g, ' '))).join('\n'));
  return { title: title || (/^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? ''), text, updatedAt, publishedAt };
}

/**
 * Product version when the URL or title states one. Unknown stays null: "current" and "latest" are NOT versions,
 * and Pitch2Plan never pretends a page applies to a specific version it cannot establish.
 */
export function detectProductVersion(slug: string, url: string, title: string): string | null {
  const path = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
  if (slug === 'postgresql') return /\/docs\/(\d{1,2})\//.exec(path)?.[1] ?? null;
  if (slug === 'python') return /^\/(3(?:\.\d+)?)\//.exec(path)?.[1] ?? null;
  if (slug === 'apache-kafka') return /\/(\d{2,3})\/documentation/.exec(path)?.[1]?.replace(/^(\d)(\d+)$/, '$1.$2') ?? null;
  const t = /\bv?(\d+\.\d+(?:\.\d+)?)\b/.exec(title);
  return t?.[1] ?? null;
}
