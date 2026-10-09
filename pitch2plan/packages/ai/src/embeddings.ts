import type { EmbeddingProvider } from '@pitch2plan/domain';

const STOP = new Set('a an and are as at be by for from has have how i in is it of on or that the this to was we what when where which with you your do does can should'.split(' '));
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, (m, _x, off: number) => (off >= 4 ? '' : m));
export const tokenizeForEmbedding = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);

function fnv(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/**
 * Deterministic lexical hashing embedder (feature hashing of unigrams + bigrams). NOT semantic: it has no idea that "latency" and "speed" are related.
 * It exists so the pipeline runs end to end without an embeddings API, and it can re-rank candidates that full-text search already found.
 * `semantic: false` makes the retrieval layer refuse to treat its similarity as proof of relevance (docs/ADR/012).
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly semantic = false;
  readonly meta;
  constructor(private readonly dims = 256) { this.meta = { provider: 'local', model: 'hashing-v1', dimensions: dims, version: `local/hashing-v1/${dims}` }; }
  async embed(texts: string[]): Promise<number[][]> { return texts.map((t) => this.one(t)); }
  private one(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0); const toks = tokenizeForEmbedding(text);
    const add = (f: string, w: number) => { const h = fnv(f); v[h % this.dims]! += (h & 0x80000000 ? -1 : 1) * w; };
    toks.forEach((t, i) => { add(t, 1); if (i > 0) add(`${toks[i - 1]}_${t}`, 0.5); });
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    return norm ? v.map((x) => x / norm) : v;
  }
}
