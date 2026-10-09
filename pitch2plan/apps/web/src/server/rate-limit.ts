export interface RateLimiter { check(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } }

/**
 * Fixed-window, in-process limiter. Good enough for one instance; swap the implementation for a
 * shared store (Postgres/Redis) when running multiple instances. The interface is the stable part.
 */
export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly scale = 1) {}
  check(key: string, rawLimit: number, windowMs: number, now = Date.now()) {
    const limit = rawLimit * this.scale;
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      return { ok: true, retryAfterMs: 0 };
    }
    cur.count++;
    return cur.count <= limit ? { ok: true, retryAfterMs: 0 } : { ok: false, retryAfterMs: cur.resetAt - now };
  }
}
