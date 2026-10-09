import type { ProjectStatus } from '@pitch2plan/schemas';
import { DomainError } from './errors';
import type { ProjectRecord, Repositories } from './ports';

/** Explicit project lifecycle. Anything not listed here is an invalid transition. */
export const ALLOWED_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  IDEA: ['DISCOVERY', 'ARCHIVED'],
  DISCOVERY: ['REQUIREMENTS_CONFIRMED', 'ARCHIVED'],
  REQUIREMENTS_CONFIRMED: ['DISCOVERY', 'ARCHITECTURE_GENERATING', 'ARCHIVED'],
  ARCHITECTURE_GENERATING: ['ARCHITECTURE_READY', 'REQUIREMENTS_CONFIRMED', 'ARCHIVED'],
  ARCHITECTURE_READY: ['IMPLEMENTING', 'ARCHIVED'],
  IMPLEMENTING: ['ARCHIVED'],
  ARCHIVED: [],
};

export const canTransition = (from: ProjectStatus, to: ProjectStatus) => ALLOWED_TRANSITIONS[from].includes(to);

export function assertTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (!canTransition(from, to)) throw new DomainError('INVALID_STATE', `A project in ${from} cannot move to ${to}.`, { from, to });
}

/** Architecture generation (Phase 3) may only begin from confirmed requirements. */
export const canStartArchitectureGeneration = (status: ProjectStatus) => status === 'REQUIREMENTS_CONFIRMED';

export async function transitionProject(repos: Repositories, project: Pick<ProjectRecord, 'id' | 'status'>, to: ProjectStatus): Promise<void> {
  assertTransition(project.status, to);
  const ok = await repos.projects.transitionStatus(project.id, project.status, to);
  if (!ok) throw new DomainError('INVALID_STATE', 'The project changed while this was happening. Refresh and try again.');
}
