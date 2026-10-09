import { randomUUID } from 'node:crypto';
import { DomainError, type RequestContext } from '@pitch2plan/domain';
import { NextResponse, type NextRequest } from 'next/server';
import type { ZodType } from 'zod';
import { getContainer } from './container';
import { toApiError, zodDetails } from './errors';
import { safeLogger } from './logger';

export interface ApiOptions<B> {
  action: string;
  /** Default true. */
  auth?: boolean;
  body?: ZodType<B>;
  rateLimit?: { limit: number; windowMs: number };
  status?: number;
}
export interface HandlerContext<B, P> {
  req: NextRequest; requestId: string; userId: string; body: B; params: P; ip: string;
  rc: RequestContext; annotate(fields: Record<string, unknown>): void;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function workspaceIdOf(result: unknown): string | undefined {
  const r = result as { workspaceId?: string; project?: { workspaceId?: string } } | null;
  return r?.workspaceId ?? r?.project?.workspaceId;
}

/**
 * Route boundary: HTTP, authentication, validation, rate limiting, serialization, logging.
 * No business logic belongs here; handlers call the application service.
 */
export function api<B = undefined, P = Record<string, string>>(
  opts: ApiOptions<B>, fn: (c: HandlerContext<B, P>) => Promise<unknown>,
) {
  return async (req: NextRequest, route: { params: Promise<P> }): Promise<Response> => {
    const started = Date.now();
    const requestId = req.headers.get('x-request-id')?.slice(0, 64) || randomUUID();
    const log: Record<string, unknown> = { requestId, action: opts.action, method: req.method };
    let status = opts.status ?? 200;
    let response: Response;
    try {
      // CSRF defence in depth (cookies are also SameSite=Lax): reject cross-origin state changes.
      const origin = req.headers.get('origin');
      if (MUTATING.has(req.method) && origin && new URL(origin).host !== req.headers.get('host')) {
        throw new DomainError('ORIGIN_NOT_ALLOWED', 'Cross-origin requests are not allowed.');
      }
      const c = getContainer();
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
      let userId = '';
      if (opts.auth !== false) {
        const cookies = { get: (n: string) => req.cookies.get(n)?.value };
        const identity = await c.auth.resolveIdentity(cookies);
        if (!identity) throw new DomainError('UNAUTHENTICATED', 'Please sign in.');
        userId = (await c.app.users.provision(identity)).user.id;
        log.userId = userId;
      }
      if (opts.rateLimit) {
        const r = c.rateLimiter.check(`${opts.action}:${userId || ip}`, opts.rateLimit.limit, opts.rateLimit.windowMs);
        if (!r.ok) throw new DomainError('RATE_LIMITED', `Too many requests. Try again in ${Math.ceil(r.retryAfterMs / 1000)}s.`);
      }
      let body = undefined as B;
      if (opts.body) {
        let raw: unknown;
        try { raw = await req.json(); } catch { throw new DomainError('VALIDATION_ERROR', 'Request body must be valid JSON.'); }
        const parsed = opts.body.safeParse(raw);
        if (!parsed.success) throw new DomainError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request.', zodDetails(parsed.error));
        body = parsed.data;
      }
      const params = ((await route?.params) ?? {}) as P;
      if (params && typeof params === 'object' && 'projectId' in params) log.projectId = (params as { projectId: string }).projectId;
      const result = await fn({
        req, requestId, userId, body, params, ip, rc: { userId, requestId },
        annotate: (f) => Object.assign(log, f),
      });
      log.workspaceId ??= workspaceIdOf(result);
      response = result instanceof Response ? result : NextResponse.json({ data: result, requestId }, { status });
      status = response.status;
    } catch (e) {
      const mapped = toApiError(e, requestId);
      status = mapped.status;
      log.errorCode = mapped.body.error.code;
      if (mapped.unexpected) safeLogger().error({ ...log, err: e instanceof Error ? { message: e.message, stack: e.stack } : String(e) }, 'unhandled error');
      response = NextResponse.json(mapped.body, { status });
    }
    response.headers.set('x-request-id', requestId);
    safeLogger().info({ ...log, status, durationMs: Date.now() - started }, 'request');
    return response;
  };
}
