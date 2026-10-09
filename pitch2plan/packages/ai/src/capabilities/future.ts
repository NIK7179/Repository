/**
 * Interfaces for upcoming capabilities. Intentionally NOT implemented in Phase 1.
 * Orchestration stays deterministic: each step is a typed function that is observable and testable,
 * not an autonomous agent.
 *
 *   Idea -> Interpret -> Find requirement gaps -> Ask clarification questions -> Confirm requirements
 *        -> Generate candidate architecture -> Validate -> Critique -> Finalize
 */
import type { Architecture } from '@pitch2plan/schemas';

export interface ProjectContext { projectId: string; workspaceId: string; userId: string }
export interface ConfirmedRequirements { items: Array<{ id: string; type: string; description: string }> }
export interface ReviewFinding { severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'RECOMMENDATION'; area: string; message: string; confidence: number }

export interface ArchitecturePlanner { plan(ctx: ProjectContext, requirements: ConfirmedRequirements): Promise<Architecture> }
export interface ArchitectureCritic { critique(ctx: ProjectContext, architecture: Architecture): Promise<ReviewFinding[]> }
export interface ImplementationPlanner { plan(ctx: ProjectContext, architecture: Architecture): Promise<unknown> }
export interface ContextualAssistant { answer(ctx: ProjectContext, question: string, focus: { nodeKey?: string; taskId?: string }): Promise<string> }
export interface ArchitectureReviewer { review(ctx: ProjectContext, architecture: Architecture): Promise<ReviewFinding[]> }
