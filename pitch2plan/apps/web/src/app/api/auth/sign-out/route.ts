import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/server/auth/session';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const POST = api({ action: 'auth.sign_out', auth: false }, async ({ requestId }) => {
  const res = NextResponse.json({ data: { signedOut: true }, requestId });
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
});
