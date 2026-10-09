import { z } from 'zod';
import { technicalLevelSchema } from './common';

export const ERROR_CODES = [
  'UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR', 'PROJECT_NOT_FOUND', 'PITCH_NOT_FOUND',
  'INTERPRETATION_NOT_FOUND', 'NO_PITCH', 'RATE_LIMITED', 'AI_OUTPUT_INVALID', 'AI_PROVIDER_ERROR',
  'AI_TIMEOUT', 'ORIGIN_NOT_ALLOWED', 'INTERNAL_ERROR',
  'INVALID_STATE', 'DISCOVERY_NOT_FOUND', 'ROUND_NOT_FOUND', 'REQUIREMENT_NOT_FOUND', 'CONFLICT_NOT_FOUND', 'BRIEF_NOT_FOUND',
  'BRIEF_STALE', 'CONFIRMATION_BLOCKED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody { error: { code: ErrorCode; message: string; requestId: string; details?: unknown } }
export interface ApiSuccessBody<T> { data: T; requestId: string }

export const createProjectRequestSchema = z.object({
  name: z.string().trim().min(2, 'Project name must be at least 2 characters').max(80, 'Project name must be 80 characters or fewer'),
  description: z.string().trim().max(500).optional(),
  /** Optional. Always verified against the caller's memberships server-side. */
  workspaceId: z.uuid().optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const submitPitchRequestSchema = z.object({
  content: z.string().trim().min(20, 'Please describe your idea in at least 20 characters').max(8000, 'Pitch must be 8000 characters or fewer'),
  technicalLevel: technicalLevelSchema.optional(),
});
export type SubmitPitchRequest = z.infer<typeof submitPitchRequestSchema>;

export const interpretRequestSchema = z.object({
  pitchId: z.uuid().optional(),
  technicalLevel: technicalLevelSchema.optional(),
});
export type InterpretRequest = z.infer<typeof interpretRequestSchema>;

export const devSignInRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')),
  name: z.string().trim().max(80).optional(),
});

export const editRequirementRequestSchema = z.object({
  statement: z.string().trim().min(5, 'Describe the requirement in at least 5 characters').max(500, 'Keep it under 500 characters'),
  value: z.string().trim().max(200).nullable().optional(),
});
export const resolveConflictRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('KEEP_ONE'), keepRequirementId: z.uuid(), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal('DISMISS'), note: z.string().trim().min(3, 'Tell us briefly why this is not a conflict').max(500) }),
]);
export const confirmBriefRequestSchema = z.object({ briefVersionId: z.uuid(), acceptedUnknownIds: z.array(z.string()).max(50).default([]) });
