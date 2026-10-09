import type { ExternalIdentity } from '@pitch2plan/domain';

export interface CookieReader { get(name: string): string | undefined }

/**
 * The auth boundary. The rest of the app only ever sees an ExternalIdentity; provider-specific
 * types (Clerk, Auth0, ...) must never leak past an implementation of this interface.
 * The internal User row is created/synchronised from the identity by the domain layer.
 */
export interface AuthProvider {
  readonly name: string;
  resolveIdentity(cookies: CookieReader): Promise<ExternalIdentity | null>;
}
