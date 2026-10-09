import { DomainError } from '@pitch2plan/domain';
import { devSignInRequestSchema } from '@pitch2plan/schemas';
import { NextResponse } from 'next/server';
import { signSession, SESSION_COOKIE } from '@/server/auth/session';
import { getContainer } from '@/server/container';
import { getEnv } from '@/server/env';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Development-only sign-in. Issues a signed session cookie for the given email. */
export const POST = api(
  { action: 'auth.dev_sign_in', auth: false, body: devSignInRequestSchema, rateLimit: { limit: 20, windowMs: 60_000 } },
  async ({ body, requestId }) => {
    const env = getEnv();
    if (env.AUTH_PROVIDER !== 'dev') throw new DomainError('FORBIDDEN', 'Dev sign-in is disabled.');
    const c = getContainer();
    const externalId = `dev:${body.email}`;
    const { user } = await c.app.users.provision({ externalId, email: body.email, name: body.name || null });
    const res = NextResponse.json({ data: { user: { id: user.id, email: user.email, name: user.name } }, requestId });
    res.cookies.set(SESSION_COOKIE, signSession({ ext: externalId, email: body.email, name: body.name || undefined }, c.authSecret), {
      httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: '/', maxAge: 7 * 24 * 3600,
    });
    return res;
  },
);
