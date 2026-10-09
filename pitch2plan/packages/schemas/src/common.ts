import { z } from 'zod';

export const PROJECT_STATUSES = [
  'IDEA', 'DISCOVERY', 'REQUIREMENTS_CONFIRMED', 'ARCHITECTURE_GENERATING',
  'ARCHITECTURE_READY', 'IMPLEMENTING', 'ARCHIVED',
] as const;
export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const technicalLevelSchema = z.enum(['BEGINNER', 'DEVELOPER', 'ARCHITECT', 'FOUNDER']);
export type TechnicalLevel = z.infer<typeof technicalLevelSchema>;

export const workspaceRoleSchema = z.enum(['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const idSchema = z.uuid();
