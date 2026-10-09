import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'p2p_session';
export interface SessionPayload { ext: string; email: string; name?: string; exp: number }

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const sign = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest('base64url');

export function signSession(p: Omit<SessionPayload, 'exp'>, secret: string, ttlSeconds = 7 * 24 * 3600, now = Date.now()): string {
  const body = b64(JSON.stringify({ ...p, exp: Math.floor(now / 1000) + ttlSeconds }));
  return `${body}.${sign(body, secret)}`;
}

export function verifySession(value: string | undefined, secret: string, now = Date.now()): SessionPayload | null {
  if (!value) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
    return payload.exp * 1000 > now && payload.ext && payload.email ? payload : null;
  } catch { return null; }
}
