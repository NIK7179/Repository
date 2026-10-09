/**
 * Interfaces for later phases. Intentionally NOT implemented yet.
 * (ArchitecturePlanner/Critic/Repairer, ImplementationPlanner/Critic/Repairer and the task assistant are implemented in capabilities/.)
 */
import type { ArchitecturePlan } from '@pitch2plan/schemas';

export interface ProjectContext { projectId: string; workspaceId: string; userId: string }
export interface ReviewFinding { severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'RECOMMENDATION'; area: string; message: string; confidence: number }
export interface ArchitectureReviewer { review(ctx: ProjectContext, architecture: ArchitecturePlan): Promise<ReviewFinding[]> }
export interface ChangeProposalPlanner { propose(ctx: ProjectContext, request: string): Promise<unknown> }
