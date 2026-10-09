export interface AiCallContextLike { workspaceId: string; projectId: string; userId: string }
export type AssistantStreamEventLike = { type: 'delta'; text: string } | { type: 'done'; ai: import('@pitch2plan/schemas').AiMeta };
