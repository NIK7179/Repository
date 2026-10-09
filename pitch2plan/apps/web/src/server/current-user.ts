import { cookies } from 'next/headers';
import { getContainer } from './container';

/** For server components: resolves the signed-in user (provisioning on first sight) or null. */
export async function getCurrentUser() {
  const c = getContainer();
  const jar = await cookies();
  const identity = await c.auth.resolveIdentity({ get: (n) => jar.get(n)?.value });
  if (!identity) return null;
  return (await c.app.users.provision(identity)).user;
}
