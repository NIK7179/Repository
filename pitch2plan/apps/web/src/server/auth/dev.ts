import type { AuthProvider } from './provider';
import { SESSION_COOKIE, verifySession } from './session';

/** Local development provider: a signed cookie issued by /api/auth/dev-sign-in. NOT for production. */
export class DevAuthProvider implements AuthProvider {
  readonly name = 'dev';
  constructor(private readonly secret: string) {}
  async resolveIdentity(cookies: { get(name: string): string | undefined }) {
    const s = verifySession(cookies.get(SESSION_COOKIE), this.secret);
    return s ? { externalId: s.ext, email: s.email, name: s.name ?? null } : null;
  }
}
