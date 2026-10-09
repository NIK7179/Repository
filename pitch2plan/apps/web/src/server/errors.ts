import { DomainError } from '@pitch2plan/domain';
import { ERROR_CODES, type ApiErrorBody, type ErrorCode } from '@pitch2plan/schemas';
import { ZodError } from 'zod';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401, FORBIDDEN: 403, ORIGIN_NOT_ALLOWED: 403, VALIDATION_ERROR: 400,
  PROJECT_NOT_FOUND: 404, PITCH_NOT_FOUND: 404, INTERPRETATION_NOT_FOUND: 404, NO_PITCH: 409,
  RATE_LIMITED: 429,
  INVALID_STATE: 409, BRIEF_STALE: 409, CONFIRMATION_BLOCKED: 409, DISCOVERY_NOT_FOUND: 404, ROUND_NOT_FOUND: 404, REQUIREMENT_NOT_FOUND: 404, CONFLICT_NOT_FOUND: 404, BRIEF_NOT_FOUND: 404,
  AI_OUTPUT_INVALID: 502, AI_PROVIDER_ERROR: 502, AI_TIMEOUT: 504, INTERNAL_ERROR: 500,
};

export function zodDetails(e: ZodError) {
  return e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Pure mapping from any thrown value to the public error contract. Internals are never leaked. */
export function toApiError(e: unknown, requestId: string): { status: number; body: ApiErrorBody; unexpected: boolean } {
  if (e instanceof DomainError && (ERROR_CODES as readonly string[]).includes(e.code)) {
    return { status: STATUS[e.code], unexpected: false, body: { error: { code: e.code, message: e.message, requestId, details: e.details } } };
  }
  if (e instanceof ZodError) {
    return { status: 400, unexpected: false, body: { error: { code: 'VALIDATION_ERROR', message: 'The request was invalid.', requestId, details: zodDetails(e) } } };
  }
  return { status: 500, unexpected: true, body: { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again.', requestId } } };
}
