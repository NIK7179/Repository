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
export interface Repositories extends DiscoveryRepositories {
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
    /** Compare-and-set: returns false (and changes nothing) unless the project is currently in `from`. */
    transitionStatus(id: string, from: ProjectStatus, to: ProjectStatus): Promise<boolean>;
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

// ====================================================================== Phase 2: discovery
import type {
  AiMeta, AiResult, AnswerChoice, AnswerInput, ArchitectureBriefContent, ArchitectureDriverDraft, BriefInput, ClarificationInput,
  ClarificationOutput, DetectorInput, DetectorOutput, DiscoveryQuestion, DiscoveryUnknown, ExtractionInput, ExtractorOutput,
  RequirementCategory, RequirementDraft, RequirementOrigin, RequirementVersionSource,
} from '@pitch2plan/schemas';

export interface SessionRecord {
  id: string; projectId: string; status: 'ACTIVE' | 'READY_FOR_BRIEF'; unknowns: DiscoveryUnknown[];
  finishReason: string | null; createdAt: Date; updatedAt: Date;
}
export interface AnswerRecord { choice: AnswerChoice; advanced: Record<string, string | number> | null; resolvedValue: string | null; recommendationReason: string | null; createdAt: Date }
export type QuestionRecord = DiscoveryQuestion & { answer: AnswerRecord | null };
export interface RoundRecord {
  id: string; sessionId: string; number: number; kind: 'STANDARD' | 'USER_REQUESTED'; status: 'OPEN' | 'ANSWERED' | 'COMPLETED' | 'SKIPPED';
  reasonForAnotherRound: string; canGenerateBrief: boolean; ai: AiMeta; createdAt: Date; completedAt: Date | null; questions: QuestionRecord[];
}
export interface RequirementRecord {
  id: string; projectId: string; key: string; category: RequirementCategory; status: 'ACTIVE' | 'SUPERSEDED' | 'DISMISSED';
  version: number; statement: string; value: string | null; origin: RequirementOrigin; source: RequirementVersionSource;
  confidence: number | null; tags: string[]; previousStatement: string | null; updatedAt: Date; createdAt: Date;
}
export interface RequirementVersionRecord {
  version: number; statement: string; value: string | null; origin: RequirementOrigin; source: RequirementVersionSource;
  confidence: number | null; previousStatement: string | null; previousValue: string | null; createdById: string | null; createdAt: Date;
}
export interface SeedRequirement {
  key: string; category: RequirementCategory; statement: string; origin: RequirementOrigin; confidence: number | null; tags: string[];
  quote?: string; sourceKind: 'PITCH_QUOTE' | 'INTERPRETATION';
}
export interface ConflictRecord {
  id: string; projectId: string; fingerprint: string; detectedBy: 'RULE' | 'AI'; ruleId: string | null; severity: string; title: string;
  description: string; requirementIds: string[]; status: 'OPEN' | 'RESOLVED'; resolution: Record<string, unknown> | null; createdAt: Date; resolvedAt: Date | null;
}
export interface BriefVersionRecord {
  id: string; briefId: string; projectId: string; version: number; content: ArchitectureBriefContent; requirementsFingerprint: string; ai: AiMeta;
  createdById: string; createdAt: Date; confirmedAt: Date | null; confirmedById: string | null; acceptedUnknownIds: string[] | null;
}
export interface BriefRecord { id: string; projectId: string; status: 'DRAFT' | 'CONFIRMED'; confirmedVersionId: string | null }
export interface DriverRecord { id: string; key: string; name: string; description: string; priority: string; requirementIds: string[] }
export interface AnalyticsEventInput { workspaceId: string; projectId?: string; userId?: string; name: string; properties?: Record<string, string | number | boolean | null> }

export interface ApplyExtractionInput {
  projectId: string; sessionId: string; roundId: string; userId: string; ai: AiMeta;
  newRequirements: RequirementDraft[];
  updatedRequirements: Array<Omit<RequirementDraft, 'key'> & { requirementId: string }>;
  recommendations: Array<{ questionKey: string; resolvedValue: string; reason: string }>;
  resolvedUnknownIds: string[]; newUnknowns: Array<{ text: string; critical: boolean }>;
}
export interface NewRoundInput {
  sessionId: string; kind: 'STANDARD' | 'USER_REQUESTED'; reasonForAnotherRound: string; canGenerateBrief: boolean; ai: AiMeta; questions: DiscoveryQuestion[];
}

export interface DiscoveryRepositories {
  discovery: {
    getSession(projectId: string): Promise<SessionRecord | null>;
    /** Idempotent per project. Seeds requirements in the same transaction. Returns the existing session if one exists. */
    createSession(input: { projectId: string; unknowns: DiscoveryUnknown[]; seed: SeedRequirement[] }): Promise<{ session: SessionRecord; created: boolean }>;
    updateSession(id: string, patch: { status?: SessionRecord['status']; unknowns?: DiscoveryUnknown[]; finishReason?: string | null }): Promise<void>;
    createRound(input: NewRoundInput): Promise<RoundRecord>;
    listRounds(sessionId: string): Promise<RoundRecord[]>;
    /** Replaces any previously saved answers for the round and marks it ANSWERED. */
    saveAnswers(input: { roundId: string; userId: string; answers: AnswerInput[] }): Promise<void>;
    setRoundStatus(roundId: string, status: 'SKIPPED'): Promise<void>;
    /** One transaction: new requirement versions, recommendation values, unknown updates, round COMPLETED. */
    applyExtraction(input: ApplyExtractionInput): Promise<void>;
  };
  requirements: {
    list(projectId: string): Promise<RequirementRecord[]>;
    get(id: string): Promise<RequirementRecord | null>;
    history(id: string): Promise<RequirementVersionRecord[]>;
    addEditVersion(input: { requirementId: string; statement: string; value: string | null; userId: string }): Promise<RequirementRecord>;
    setStatus(ids: string[], status: 'SUPERSEDED' | 'DISMISSED' | 'ACTIVE'): Promise<void>;
  };
  conflicts: {
    list(projectId: string): Promise<ConflictRecord[]>;
    get(id: string): Promise<ConflictRecord | null>;
    /** Skips fingerprints that already exist. Returns only the newly created conflicts. */
    createMany(projectId: string, items: Array<Omit<ConflictRecord, 'id' | 'projectId' | 'status' | 'resolution' | 'createdAt' | 'resolvedAt'> & { ai?: AiMeta }>): Promise<ConflictRecord[]>;
    resolve(input: { id: string; userId: string; resolution: Record<string, unknown>; supersedeRequirementIds: string[] }): Promise<void>;
  };
  briefs: {
    getByProject(projectId: string): Promise<BriefRecord | null>;
    latestVersion(projectId: string): Promise<BriefVersionRecord | null>;
    getVersion(id: string): Promise<BriefVersionRecord | null>;
    listDrivers(briefVersionId: string): Promise<DriverRecord[]>;
    createVersion(input: { projectId: string; content: ArchitectureBriefContent; fingerprint: string; ai: AiMeta; userId: string; drivers: ArchitectureDriverDraft[] }): Promise<BriefVersionRecord>;
    /** One transaction with a compare-and-set on project status. Returns false if the project was not in DISCOVERY. */
    confirm(input: { projectId: string; briefVersionId: string; userId: string; acceptedUnknownIds: string[] }): Promise<boolean>;
  };
  analytics: { record(event: AnalyticsEventInput): Promise<void> };
}

export interface DiscoveryAiPort {
  generateQuestions(input: ClarificationInput): Promise<AiResult<ClarificationOutput>>;
  extractRequirements(input: ExtractionInput): Promise<AiResult<ExtractorOutput>>;
  detectConflicts(input: DetectorInput): Promise<AiResult<DetectorOutput>>;
  generateBrief(input: BriefInput): Promise<AiResult<ArchitectureBriefContent>>;
}
