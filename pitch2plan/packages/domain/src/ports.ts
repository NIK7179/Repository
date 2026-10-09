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
export interface Repositories extends DiscoveryRepositories, ArchitectureRepositories, ImplementationRepositories {
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

// ====================================================================== Phase 3: architecture
import type {
  ArchitectureIssue, ArchitecturePlan, CriticOutput, PlanInput, CritiqueInput, RepairInput, RepairPatch, NodeCategory, Priority,
} from '@pitch2plan/schemas';

export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export interface GenerationRunRecord {
  id: string; projectId: string; briefVersionId: string; status: RunStatus; currentStage: string; attempt: number; repairCount: number;
  failureCode: string | null; failureMessage: string | null; jobId: string | null; requestedById: string;
  createdAt: Date; startedAt: Date | null; heartbeatAt: Date | null; finishedAt: Date | null; versionId: string | null;
}
export interface IssueRecord extends ArchitectureIssue { id: string; stage: string }
export interface NodeRecord {
  id: string; versionId: string; stableKey: string; name: string; technology: string; technologySlug: string; category: NodeCategory; purpose: string; description: string;
  criticality: Priority; managedService: boolean; provider: string | null; deploymentModel: string; configuration: Array<{ key: string; value: string; note?: string }>;
  risks: string[]; alternatives: Array<{ technology: string; reasoning: string }>; status: string; replacesStableKey: string | null;
}
export interface EdgeRecord {
  id: string; versionId: string; edgeKey: string; sourceStableKey: string; targetStableKey: string; label: string; protocol: string; communicationType: string;
  dataDescription: string; synchronous: boolean; encrypted: boolean | null; criticality: Priority;
}
export interface DecisionRecord {
  id: string; versionId: string; key: string; title: string; problem: string; decision: string; rationale: string; status: 'PROPOSED' | 'ACCEPTED' | 'DEPRECATED' | 'SUPERSEDED';
  tradeoffs: string[]; risks: string[]; alternatives: Array<{ technology: string; reasoning: string }>; consequences: string[]; confidence: number; createdAt: Date;
  driverIds: string[]; requirementIds: string[]; nodeStableKeys: string[]; edgeKeys: string[];
}
export interface ArchitectureVersionSummary {
  id: string; architectureId: string; projectId: string; versionNumber: number; status: 'DRAFT' | 'VALIDATING' | 'CRITIQUING' | 'READY' | 'FAILED' | 'SUPERSEDED';
  generationRunId: string; briefVersionId: string; summary: string; createdAt: Date; finalizedAt: Date | null; counts: { nodes: number; edges: number; decisions: number };
}
export interface ArchitectureVersionRecord extends ArchitectureVersionSummary {
  assumptions: string[]; unresolvedQuestions: string[]; risks: Array<{ text: string; severity: Priority; nodeStableKeys: string[] }>; ai: Record<string, unknown>;
  nodes: NodeRecord[]; edges: EdgeRecord[]; decisions: DecisionRecord[]; issues: IssueRecord[];
}
export interface ArchitectureRecord { id: string; projectId: string; currentVersionId: string | null }
export interface NodeHistoryEntry { versionNumber: number; versionId: string; technology: string; technologySlug: string; replacesStableKey: string | null; replacedByStableKey: string | null }

export interface PersistArchitectureInput {
  runId: string; projectId: string; briefVersionId: string; plan: ArchitecturePlan;
  driverIdByCode: Record<string, string>; requirementIdByCode: Record<string, string>;
  issues: Array<ArchitectureIssue & { stage: string }>; ai: Record<string, unknown>;
}

export interface ArchitectureRepositories {
  architecture: {
    getByProject(projectId: string): Promise<ArchitectureRecord | null>;
    listVersions(projectId: string): Promise<ArchitectureVersionSummary[]>;
    getVersion(versionId: string): Promise<ArchitectureVersionRecord | null>;
    nodeHistory(architectureId: string, stableKey: string): Promise<NodeHistoryEntry[]>;
    /** One transaction: compare-and-set REQUIREMENTS_CONFIRMED -> ARCHITECTURE_GENERATING, then create the run. Null if the project was not confirmed. */
    startGeneration(input: { projectId: string; briefVersionId: string; userId: string }): Promise<GenerationRunRecord | null>;
    attachJob(runId: string, jobId: string): Promise<void>;
    getRun(id: string): Promise<GenerationRunRecord | null>;
    getRunByJobId(jobId: string): Promise<GenerationRunRecord | null>;
    getLatestRun(projectId: string): Promise<GenerationRunRecord | null>;
    /** Compare-and-set: QUEUED, or RUNNING with a stale heartbeat. Returns null if another worker owns it or it is finished. */
    claimRun(runId: string, staleBefore: Date): Promise<GenerationRunRecord | null>;
    touchRun(runId: string, patch: { currentStage?: string; repairCount?: number }): Promise<void>;
    /** One transaction, idempotent per run: the version, its graph, links, issues, run SUCCEEDED and project -> ARCHITECTURE_READY. */
    finalize(input: PersistArchitectureInput): Promise<{ versionId: string; versionNumber: number; created: boolean }>;
    /** One transaction: run -> FAILED and project ARCHITECTURE_GENERATING -> REQUIREMENTS_CONFIRMED. Safe to call repeatedly. */
    failRun(input: { runId: string; code: string; message: string; issues?: Array<ArchitectureIssue & { stage: string }> }): Promise<{ failed: boolean; projectRecovered: boolean }>;
    listStaleRuns(before: Date): Promise<GenerationRunRecord[]>;
  };
}

export interface ArchitectureAiPort {
  plan(input: PlanInput): Promise<AiResult<ArchitecturePlan>>;
  critique(input: CritiqueInput): Promise<AiResult<CriticOutput>>;
  repair(input: RepairInput): Promise<AiResult<RepairPatch>>;
}

/** Port implemented by packages/jobs (pg-boss). The domain never imports a queue library. */
export interface JobQueue {
  /** Returns the job id, or null if an identical job (same singletonKey) is already queued. */
  enqueue(name: string, payload: { runId: string }, options: { singletonKey: string }): Promise<string | null>;
}
export const ARCHITECTURE_JOB = 'architecture.generate';

// ====================================================================== Phase 4: implementation + assistant
import type {
  AssistantMessageContent, ConversationScope, ImplCritiqueInput, ImplCriticOutput, ImplementationPlan, ImplIssue, ImplPlanInput, ImplRepairInput, ImplRepairPatch, TaskStatus, PhaseStatus,
} from '@pitch2plan/schemas';

export const IMPLEMENTATION_JOB = 'implementation.generate';
export interface StepRecord { id: string; sequence: number; title: string; instruction: string; expectedResult: string; validation: string; status: 'NOT_STARTED' | 'COMPLETED'; completedAt: Date | null }
export interface ValidationRecord { id: string; position: number; label: string; confirmed: boolean; confirmationKind: 'USER_CONFIRMED' | 'SYSTEM_VERIFIED' | null; confirmedById: string | null; confirmedAt: Date | null }
export interface ProgressEventRecord { id: string; fromStatus: TaskStatus; toStatus: TaskStatus; reason: string | null; actorId: string; createdAt: Date }
export interface TaskReference { title: string; url: string; sourceType: string; technology: string; version: string | null }
export interface TaskRecord {
  id: string; planVersionId: string; phaseId: string; phaseKey: string; phaseSequence: number; key: string; sequence: number; title: string; objective: string; description: string; whyThisTask: string;
  taskType: string; complexity: string; effort: string; status: TaskStatus; prerequisites: string[]; instructions: string; expectedOutcome: string; validationSteps: string[];
  commonProblems: Array<{ problem: string; resolution: string }>; securityNotes: string[]; operationalNotes: string[]; references: TaskReference[]; createdAt: Date; updatedAt: Date;
  steps: StepRecord[]; dependsOn: string[]; componentKeys: string[]; decisionKeys: string[]; requirementIds: string[]; validations: ValidationRecord[];
}
export interface PhaseRecord { id: string; key: string; sequence: number; name: string; objective: string; description: string; status: PhaseStatus }
export interface ImplIssueRecord extends ImplIssue { id: string; stage: string }
export interface PlanVersionRecord {
  id: string; planId: string; projectId: string; versionNumber: number; architectureVersionId: string; generationRunId: string; summary: string;
  componentCoverage: Array<{ stableKey: string; reason: string }>; ai: Record<string, unknown>; createdAt: Date; phases: PhaseRecord[]; tasks: TaskRecord[]; issues: ImplIssueRecord[];
}
export interface ImplRunRecord {
  id: string; projectId: string; architectureVersionId: string; status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'; currentStage: string; attempt: number; repairCount: number;
  failureCode: string | null; failureMessage: string | null; jobId: string | null; requestedById: string; createdAt: Date; startedAt: Date | null; heartbeatAt: Date | null; finishedAt: Date | null; planVersionId: string | null;
}
export interface PersistPlanInput {
  runId: string; projectId: string; architectureVersionId: string; plan: ImplementationPlan; decisionIdByKey: Record<string, string>; requirementIdByCode: Record<string, string>;
  issues: Array<ImplIssue & { stage: string }>; ai: Record<string, unknown>;
}
export interface ConversationRecord { id: string; projectId: string; scope: ConversationScope; scopeId: string; createdById: string | null; createdAt: Date }
export interface MessageRecord { id: string; conversationId: string; role: 'USER' | 'ASSISTANT' | 'SYSTEM'; content: string; status: 'COMPLETE' | 'FAILED'; structured: AssistantMessageContent | null; contextRefs: Array<{ type: string; id: string }> | null; clientMessageId: string | null; createdAt: Date }

export interface ImplementationRepositories {
  implementation: {
    getPlanByProject(projectId: string): Promise<{ id: string; projectId: string; currentVersionId: string | null } | null>;
    getVersion(planVersionId: string): Promise<PlanVersionRecord | null>;
    getTask(taskId: string): Promise<(TaskRecord & { projectId: string; events: ProgressEventRecord[] }) | null>;
    taskIdsDependingOn(taskId: string): Promise<string[]>;
    startGeneration(input: { projectId: string; architectureVersionId: string; userId: string }): Promise<ImplRunRecord | null>;
    attachJob(runId: string, jobId: string): Promise<void>;
    getRun(id: string): Promise<ImplRunRecord | null>;
    getRunByJobId(jobId: string): Promise<ImplRunRecord | null>;
    getLatestRun(projectId: string): Promise<ImplRunRecord | null>;
    claimRun(runId: string, staleBefore: Date): Promise<ImplRunRecord | null>;
    touchRun(runId: string, patch: { currentStage?: string; repairCount?: number }): Promise<void>;
    finalize(input: PersistPlanInput): Promise<{ planVersionId: string; created: boolean }>;
    failRun(input: { runId: string; code: string; message: string; issues?: Array<ImplIssue & { stage: string }> }): Promise<{ failed: boolean }>;
    listStaleRuns(before: Date): Promise<ImplRunRecord[]>;
    /** Compare-and-set on the current status; appends a history event; recomputes the phase status; moves the project to IMPLEMENTING on the first start. */
    updateTaskStatus(input: { taskId: string; from: TaskStatus; to: TaskStatus; userId: string; reason?: string }): Promise<{ ok: boolean; projectStarted: boolean }>;
    updateStepStatus(input: { taskId: string; stepId: string; status: 'NOT_STARTED' | 'COMPLETED' }): Promise<boolean>;
    setValidations(input: { taskId: string; userId: string; confirmations: Array<{ position: number; confirmed: boolean }> }): Promise<ValidationRecord[]>;
  };
  conversations: {
    getOrCreate(input: { projectId: string; scope: ConversationScope; scopeId: string; userId: string }): Promise<ConversationRecord>;
    get(id: string): Promise<ConversationRecord | null>;
    find(input: { projectId: string; scope: ConversationScope; scopeId: string; userId: string }): Promise<ConversationRecord | null>;
    findMessageByClientId(conversationId: string, clientMessageId: string): Promise<MessageRecord | null>;
    addMessage(input: { conversationId: string; role: 'USER' | 'ASSISTANT'; content: string; status?: 'COMPLETE' | 'FAILED'; structured?: AssistantMessageContent; contextRefs?: Array<{ type: string; id: string }>; clientMessageId?: string; userId?: string }): Promise<MessageRecord>;
    list(conversationId: string, limit: number): Promise<MessageRecord[]>;
  };
}
export interface ImplementationAiPort {
  plan(input: ImplPlanInput): Promise<AiResult<ImplementationPlan>>;
  critique(input: ImplCritiqueInput): Promise<AiResult<ImplCriticOutput>>;
  repair(input: ImplRepairInput): Promise<AiResult<ImplRepairPatch>>;
}
export type AssistantStreamEvent = { type: 'delta'; text: string } | { type: 'done'; ai: AiMeta };
export interface AssistantAiPort {
  stream(input: { context: { workspaceId: string; projectId: string; userId: string }; projectContext: unknown; history: Array<{ role: 'user' | 'assistant'; content: string }>; question: string; signal?: AbortSignal }): AsyncIterable<AssistantStreamEvent>;
}
