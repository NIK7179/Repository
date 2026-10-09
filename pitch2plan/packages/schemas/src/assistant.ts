import { z } from 'zod';

export const CONVERSATION_SCOPES = ['PROJECT', 'COMPONENT', 'TASK'] as const;
export const conversationScopeSchema = z.enum(CONVERSATION_SCOPES);
export type ConversationScope = z.infer<typeof conversationScopeSchema>;

export const askArchitectRequestSchema = z.object({
  projectId: z.uuid(),
  scope: conversationScopeSchema,
  /** PROJECT: omitted. COMPONENT: the component stableKey. TASK: the task id. */
  scopeId: z.string().trim().min(1).max(100).optional(),
  stepId: z.uuid().optional(),
  message: z.string().trim().min(1, 'Ask a question').max(4000, 'Keep the question under 4000 characters'),
  /** Client-generated idempotency key: a retry after a failure reuses the stored user message instead of duplicating it. */
  clientMessageId: z.string().trim().min(8).max(64),
});
export type AskArchitectRequest = z.infer<typeof askArchitectRequestSchema>;

export const commandRiskSchema = z.enum(['READ_ONLY', 'MUTATING', 'DESTRUCTIVE']);
/** What the model may return after the answer text. The server validates it, classifies commands itself, and drops references it cannot verify. */
export const assistantExtrasSchema = z.object({
  warnings: z.array(z.string().trim().min(3).max(400)).max(6).default([]),
  commands: z.array(z.object({ command: z.string().trim().min(1).max(600), purpose: z.string().trim().min(3).max(240) })).max(8).default([]),
  codeBlocks: z.array(z.object({ language: z.string().trim().max(30).default('text'), filename: z.string().trim().max(120).optional(), purpose: z.string().trim().min(3).max(240), content: z.string().max(6000) })).max(5).default([]),
  validationSteps: z.array(z.string().trim().min(3).max(300)).max(8).default([]),
  relatedTaskIds: z.array(z.string()).max(8).default([]),
  architectureImpact: z.string().trim().max(600).default(''),
  needsArchitectureChange: z.boolean().default(false),
});
export type AssistantExtras = z.infer<typeof assistantExtrasSchema>;

export interface AssistantCommand { command: string; purpose: string; risk: z.infer<typeof commandRiskSchema>; reasons: string[] }
export interface AssistantMessageContent {
  answer: string; warnings: string[]; commands: AssistantCommand[]; codeBlocks: AssistantExtras['codeBlocks']; validationSteps: string[];
  relatedTasks: Array<{ id: string; title: string }>; architectureImpact: string; needsArchitectureChange: boolean;
  /** Set by the server, never the model. */
  notices: string[];
}
