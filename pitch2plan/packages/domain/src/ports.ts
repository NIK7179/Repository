import type { IdeaInterpretation, ProjectStatus, TechnicalLevel, WorkspaceRole } from '@pitch2plan/schemas';

export interface ExternalIdentity { externalId: string; email: string; name?: string | null }
export interface UserRecord { id: string; externalId: string; email: string; name: string | null }
export interface WorkspaceRecord { id: string; name: string; isPersonal: boolean }
export interface MembershipRecord { workspaceId: string; userId: string; role: WorkspaceRole }
export type MembershipWithWorkspace = MembershipRecord & { workspace: WorkspaceRecord };

export interface ProjectRecord {
  id: string; workspaceId: string; createdById: string; name: string; description: string | null;
  status: ProjectStatus; createdAt: Date; updatedAt: Date; deletedAt: Date | null;
}
export interface PitchRecord {
  id: string; projectId: string; authorId: string; version: number; content: string;
  technicalLevel: TechnicalLevel | null; createdAt: Date;
}
export interface InterpretationRecord {
  id: string; projectId: string; pitchId: string; promptId: string; promptVersion: number;
  provider: string; model: string; output: IdeaInterpretation; createdAt: Date;
}
export interface UsageEventInput {
  workspaceId: string; projectId?: string; userId?: string; capability: string; provider: string; model: string;
  promptId?: string; promptVersion?: number; inputTokens?: number; outputTokens?: number;
  latencyMs: number; success: boolean; errorCode?: string;
}
export interface AuditEventInput {
  workspaceId: string; projectId?: string; actorId?: string; action: string;
  entityType?: string; entityId?: string; metadata?: Record<string, unknown>; requestId?: string;
}

/** Persistence ports. Implemented by packages/db; the domain never imports Prisma. */
export interface Repositories {
  users: {
    findById(id: string): Promise<UserRecord | null>;
    /** Idempotent: creates the user, a personal workspace and an OWNER membership on first sight. */
    provision(identity: ExternalIdentity): Promise<{ user: UserRecord; workspace: WorkspaceRecord; created: boolean }>;
  };
  workspaces: {
    getMembership(userId: string, workspaceId: string): Promise<MembershipRecord | null>;
    listMemberships(userId: string): Promise<MembershipWithWorkspace[]>;
  };
  projects: {
    create(input: { workspaceId: string; createdById: string; name: string; description?: string }): Promise<ProjectRecord>;
    listForWorkspaces(workspaceIds: string[]): Promise<ProjectRecord[]>;
    /** Excludes soft-deleted projects. */
    findById(id: string): Promise<ProjectRecord | null>;
    touch(id: string): Promise<void>;
    setStatus(id: string, status: ProjectStatus): Promise<void>;
    softDelete(id: string): Promise<void>;
  };
  pitches: {
    /** Append-only: each submission is a new immutable version. */
    append(input: { projectId: string; authorId: string; content: string; technicalLevel?: TechnicalLevel }): Promise<PitchRecord>;
    latest(projectId: string): Promise<PitchRecord | null>;
    findById(id: string): Promise<PitchRecord | null>;
  };
  interpretations: {
    create(input: Omit<InterpretationRecord, 'id' | 'createdAt'>): Promise<InterpretationRecord>;
    latest(projectId: string): Promise<InterpretationRecord | null>;
  };
  usage: { record(event: UsageEventInput): Promise<void> };
  audit: { record(event: AuditEventInput): Promise<void> };
}

/** Port implemented by packages/ai. */
export interface IdeaInterpreterPort {
  interpret(input: {
    projectId: string; workspaceId: string; userId: string; pitch: string; technicalLevel?: TechnicalLevel;
  }): Promise<{ output: IdeaInterpretation; promptId: string; promptVersion: number; provider: string; model: string }>;
}
