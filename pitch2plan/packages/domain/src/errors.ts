import type { ErrorCode } from '@pitch2plan/schemas';

export class DomainError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'DomainError';
  }
}
