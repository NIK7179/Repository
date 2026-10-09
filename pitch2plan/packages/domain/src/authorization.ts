import type { WorkspaceRole } from '@pitch2plan/schemas';
import { DomainError } from './errors';
import type { ProjectRecord, Repositories } from './ports';

const WRITE_ROLES: WorkspaceRole[] = ['OWNER', 'ADMIN', 'EDITOR'];
const MANAGE_ROLES: WorkspaceRole[] = ['OWNER', 'ADMIN'];

export const canWrite = (role: WorkspaceRole) => WRITE_ROLES.includes(role);
export const canManage = (role: WorkspaceRole) => MANAGE_ROLES.includes(role);

export type Access = 'read' | 'write' | 'manage';

/**
 * Resolves a project for a user or throws. Non-members get PROJECT_NOT_FOUND
 * (not FORBIDDEN) so the existence of other workspaces' projects is never leaked.
 */
export async function requireProjectAccess(
  repos: Repositories, userId: string, projectId: string, access: Access,
): Promise<{ project: ProjectRecord; role: WorkspaceRole }> {
  const project = await repos.projects.findById(projectId);
  if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'Project not found.');
  const membership = await repos.workspaces.getMembership(userId, project.workspaceId);
  if (!membership) throw new DomainError('PROJECT_NOT_FOUND', 'Project not found.');
  if (access === 'write' && !canWrite(membership.role)) throw new DomainError('FORBIDDEN', 'You have read-only access to this project.');
  if (access === 'manage' && !canManage(membership.role)) throw new DomainError('FORBIDDEN', 'Only workspace owners and admins can do this.');
  return { project, role: membership.role };
}
