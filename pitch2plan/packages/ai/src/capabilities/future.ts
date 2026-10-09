/**
 * Interfaces for later phases. Intentionally NOT implemented yet.
 * Orchestration stays deterministic: each step is a typed function that is observable and testable, not an autonomous agent.
 * (ArchitecturePlanner, ArchitectureCritic and ArchitectureRepairer are implemented in capabilities/architecture.ts.)
 */
import type { ArchitecturePlan } from '@pitch2plan/schemas';

export interface ProjectContext { projectId: string; workspaceId: string; userId: string }
export interface ReviewFinding { severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'RECOMMENDATION'; area: string; message: string; confidence: number }

export interface ImplementationPlanner { plan(ctx: ProjectContext, architecture: ArchitecturePlan): Promise<unknown> }
export interface ContextualAssistant { answer(ctx: ProjectContext, question: string, focus: { nodeKey?: string; taskId?: string }): Promise<string> }
export interface ArchitectureReviewer { review(ctx: ProjectContext, architecture: ArchitecturePlan): Promise<ReviewFinding[]> }
