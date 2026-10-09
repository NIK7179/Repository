import { DomainError } from '@pitch2plan/domain';
import { describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import { signSession, verifySession } from './auth/session';
import { toApiError } from './errors';
import { MemoryRateLimiter } from './rate-limit';

describe('toApiError', () => {
  it('maps domain errors to the public contract with the right status', () => {
    const { status, body } = toApiError(new DomainError('PROJECT_NOT_FOUND', 'Project not found.'), 'req-1');
    expect(status).toBe(404);
    expect(body).toEqual({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found.', requestId: 'req-1', details: undefined } });
  });
  it('maps AI failures to gateway-style statuses', () => {
    expect(toApiError(new DomainError('AI_OUTPUT_INVALID', 'x'), 'r').status).toBe(502);
    expect(toApiError(new DomainError('AI_TIMEOUT', 'x'), 'r').status).toBe(504);
  });
  it('maps validation errors to 400 with field-level details', () => {
    const parsed = z.object({ name: z.string().min(2) }).safeParse({ name: 'a' });
    const { status, body } = toApiError(parsed.error as ZodError, 'r');
    expect(status).toBe(400);
    expect(body.error.details).toEqual([{ path: 'name', message: expect.any(String) }]);
  });
  it('never leaks internals for unexpected errors', () => {
    const { status, body, unexpected } = toApiError(new Error('password=hunter2 at db.ts:12'), 'r');
    expect(status).toBe(500);
    expect(unexpected).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/hunter2|db\.ts/);
  });
});

describe('session cookies', () => {
  const secret = 'a-long-test-secret-value-1234';
  const payload = { ext: 'dev:a@b.co', email: 'a@b.co', name: 'A' };
  it('round-trips a valid session', () => {
    expect(verifySession(signSession(payload, secret), secret)).toMatchObject(payload);
  });
  it('rejects tampering, wrong secrets, garbage and expiry', () => {
    const good = signSession(payload, secret);
    const [body, sig] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, email: 'admin@b.co', exp: 9_999_999_999 })).toString('base64url');
    expect(verifySession(`${forged}.${sig}`, secret)).toBeNull();
    expect(verifySession(`${body}.${sig}x`, secret)).toBeNull();
    expect(verifySession(good, 'another-secret-another-secret')).toBeNull();
    expect(verifySession('garbage', secret)).toBeNull();
    expect(verifySession(undefined, secret)).toBeNull();
    expect(verifySession(signSession(payload, secret, 60, 0), secret, 120_000)).toBeNull();
  });
});

describe('rate limit scale (test servers only)', () => {
  it('multiplies the limit, and stays strict by default', () => {
    const strict = new MemoryRateLimiter(); const scaled = new MemoryRateLimiter(10);
    expect([1, 2, 3].map(() => strict.check('k', 2, 60_000, 0).ok)).toEqual([true, true, false]);
    expect(Array.from({ length: 21 }, () => scaled.check('k', 2, 60_000, 0).ok).filter(Boolean)).toHaveLength(20);
  });
  it('is refused by the environment unless the throwaway dev auth is explicitly enabled', async () => {
    const { getEnv } = await import('./env');
    const base = { DATABASE_URL: 'postgresql://x', AUTH_SECRET: 'a-sufficiently-long-secret' } as Record<string, string>;
    const env = (e: Record<string, string>) => { const saved = { ...process.env }; Object.assign(process.env, base, e); try { return getEnv(); } finally { process.env = saved; } };
    expect(() => env({ RATE_LIMIT_SCALE: '50' })).toThrow(/RATE_LIMIT_SCALE/);
    expect(env({ RATE_LIMIT_SCALE: '50', ALLOW_DEV_AUTH: 'true' }).RATE_LIMIT_SCALE).toBe(50);
  });
});

describe('MemoryRateLimiter', () => {
  it('blocks after the limit within a window and recovers after it', () => {
    const rl = new MemoryRateLimiter();
    expect([1, 2, 3].map((i) => rl.check('k', 2, 1000, i).ok)).toEqual([true, true, false]);
    expect(rl.check('other', 2, 1000, 3).ok).toBe(true); // keys are independent
    expect(rl.check('k', 2, 1000, 1001).ok).toBe(true); // new window
  });
});
