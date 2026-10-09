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
export interface Repositories extends DiscoveryRepositories, ArchitectureRepositories, ImplementationRepositories, ChangeRepositories, KnowledgeRepositories {
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
  /** INITIAL, or CHANGE when the run applies an approved change proposal. */
  mode: string; proposalId: string | null; baseVersionId: string | null;
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
  /** The decision (in the previous version) this one replaces, and the decision (in a later version) that replaces this one. History is never rewritten: effectiveStatus is derived. */
  supersedesKey: string | null; supersededByKey: string | null; effectiveStatus: string;
}
export interface ArchitectureVersionSummary {
  id: string; architectureId: string; projectId: string; versionNumber: number; status: 'DRAFT' | 'VALIDATING' | 'CRITIQUING' | 'READY' | 'FAILED' | 'SUPERSEDED';
  generationRunId: string; briefVersionId: string; summary: string; createdAt: Date; finalizedAt: Date | null; counts: { nodes: number; edges: number; decisions: number };
  parentVersionId: string | null; sourceProposalId: string | null;
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
  activation: 'ACTIVE' | 'PENDING_REVIEW' | 'SUPERSEDED'; supersedesPlanVersionId: string | null; sourceProposalId: string | null;
}
export interface ImplRunRecord {
  id: string; projectId: string; architectureVersionId: string; status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'; currentStage: string; attempt: number; repairCount: number;
  failureCode: string | null; failureMessage: string | null; jobId: string | null; requestedById: string; createdAt: Date; startedAt: Date | null; heartbeatAt: Date | null; finishedAt: Date | null; planVersionId: string | null;
  chainProposalId: string | null;
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
    getTask(taskId: string): Promise<(TaskRecord & { projectId: string; events: ProgressEventRecord[]; planActivation: 'ACTIVE' | 'PENDING_REVIEW' | 'SUPERSEDED' }) | null>;
    taskIdsDependingOn(taskId: string): Promise<string[]>;
    startGeneration(input: { projectId: string; architectureVersionId: string; userId: string; chainProposalId?: string }): Promise<ImplRunRecord | null>;
    getRunByProposal(proposalId: string): Promise<ImplRunRecord | null>;
    requeueRun(runId: string): Promise<boolean>;
    listPlanVersions(projectId: string): Promise<Array<{ id: string; versionNumber: number; architectureVersionId: string; activation: 'ACTIVE' | 'PENDING_REVIEW' | 'SUPERSEDED'; sourceProposalId: string | null; createdAt: Date }>>;
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
  stream(input: { context: { workspaceId: string; projectId: string; userId: string }; projectContext: unknown; history: Array<{ role: 'user' | 'assistant'; content: string }>; question: string; /** Rendered <retrieved_documentation> block (untrusted reference data), if any. */ documents?: string; signal?: AbortSignal }): AsyncIterable<AssistantStreamEvent>;
}


// ====================================================================== Phase 5: change proposals, review, migration
import type {
  ArchitectureDiff, ChangeAnalysis, ChangePlan, MigItem, MigrationSummary, ProposalState, RequirementChange, ReviewFindingDraft, ReviewOutput,
} from '@pitch2plan/schemas';

export const CHANGE_ANALYZE_JOB = 'change.analyze';
/** payload.runId carries the PROPOSAL id for analysis jobs and the architecture RUN id for application jobs. */
export const CHANGE_APPLY_JOB = 'change.apply';

export interface ImpactItemRecord { kind: 'NODE' | 'EDGE' | 'DECISION' | 'DRIVER' | 'REQUIREMENT' | 'TASK'; refKey: string; relation: 'DIRECT' | 'POTENTIAL'; reason: string; taskId: string | null }
export interface ProposalApprovalRecord { decision: 'APPROVED' | 'REJECTED'; decidedById: string; decidedAt: Date; architectureVersionId: string; confirmedRequirementChanges: boolean; note: string | null }
export interface ProposalRecord {
  id: string; projectId: string; baseVersionId: string; source: string; requestedChange: string; reason: string | null; status: ProposalState; changeType: string | null; severity: string | null;
  requiresReconfirmation: boolean; requirementChanges: RequirementChange[]; analysis: ChangeAnalysis | null; analysisAi: Record<string, unknown> | null; failureCode: string | null; failureMessage: string | null;
  assistantConversationId: string | null; assistantMessageId: string | null; reviewFindingId: string | null; rebasedFromId: string | null; briefVersionId: string | null; resultVersionId: string | null;
  createdById: string; createdAt: Date; updatedAt: Date; analyzedAt: Date | null; analysisAttempt: number; impactItems: ImpactItemRecord[]; approval: ProposalApprovalRecord | null; runId: string | null;
}
export interface ReviewFindingRecord extends ReviewFindingDraft { id: string; reviewId: string }
export interface ReviewRecord { id: string; projectId: string; architectureVersionId: string; createdById: string; assessment: string; ai: Record<string, unknown>; createdAt: Date; findings: ReviewFindingRecord[] }
export interface MigrationRecord { id: string; fromPlanVersionId: string; toPlanVersionId: string; proposalId: string | null; acceptedById: string; acceptedAt: Date; summary: MigrationSummary; items: Array<MigItem & { id: string }> }

/** Requirement edits applied atomically with an approval. @new:N placeholders (in the brief) stand for the ids of requirements this application creates. */
export interface RequirementApplication {
  ops: Array<{ kind: 'ADD'; category: string; statement: string; value: string | null } | { kind: 'MODIFY'; requirementId: string; statement: string; value: string | null } | { kind: 'REMOVE'; requirementId: string }>;
  brief: { content: ArchitectureBriefContent; ai: AiMeta; drivers: ArchitectureDriverDraft[] };
}
export interface FinalizeChangeInput {
  runId: string; proposalId: string; projectId: string; baseVersionId: string; briefVersionId: string; plan: ArchitecturePlan; driverIdByCode: Record<string, string>; requirementIdByCode: Record<string, string>;
  issues: Array<ArchitectureIssue & { stage: string }>; ai: Record<string, unknown>; diff: ArchitectureDiff;
}
export interface ChangeRepositories {
  changes: {
    create(input: { projectId: string; baseVersionId: string; source: string; requestedChange: string; reason?: string; assistantConversationId?: string; assistantMessageId?: string; reviewFindingId?: string; rebasedFromId?: string; userId: string }): Promise<ProposalRecord>;
    get(id: string): Promise<ProposalRecord | null>;
    list(projectId: string): Promise<ProposalRecord[]>;
    /** DRAFT, READY_FOR_REVIEW or FAILED (without approval) -> DRAFT, clearing the analysis. */
    edit(input: { id: string; requestedChange: string; reason: string | null }): Promise<boolean>;
    startAnalysis(id: string): Promise<boolean>;
    claimAnalysis(id: string, staleBefore: Date): Promise<ProposalRecord | null>;
    saveAnalysis(input: { id: string; analysis: ChangeAnalysis; ai: Record<string, unknown>; severity: string; requiresReconfirmation: boolean; requirementChanges: RequirementChange[]; items: ImpactItemRecord[] }): Promise<boolean>;
    failAnalysis(input: { id: string; code: string; message: string }): Promise<boolean>;
    listStaleAnalyses(before: Date): Promise<ProposalRecord[]>;
    reject(input: { id: string; userId: string; note: string | null }): Promise<boolean>;
    /** One transaction: stale check against the CURRENT version, approval record, requirement/brief changes, CHANGE run. */
    approve(input: { id: string; userId: string; note: string | null; confirmedRequirementChanges: boolean; requirementApplication?: RequirementApplication }): Promise<{ result: 'OK'; run: GenerationRunRecord } | { result: 'STALE' | 'INVALID' }>;
    /** FAILED (with an approval) -> APPLYING by re-queuing the SAME run (one approved proposal never has two runs). */
    retryApply(input: { id: string }): Promise<GenerationRunRecord | null>;
    /** Marks every open proposal bound to an older version STALE. Returns how many changed. */
    markStale(projectId: string, currentVersionId: string): Promise<number>;
    failApply(input: { runId: string; code: string; message: string; issues?: Array<ArchitectureIssue & { stage: string }> }): Promise<boolean>;
    /** One transaction, idempotent per run and per proposal: supersede the base version, create the new one with lineage, store the diff, mark the proposal APPLIED and others STALE. */
    finalizeChange(input: FinalizeChangeInput): Promise<{ versionId: string; versionNumber: number; created: boolean }>;
    getByRun(runId: string): Promise<ProposalRecord | null>;
  };
  diffs: { get(fromVersionId: string, toVersionId: string): Promise<ArchitectureDiff | null> };
  reviews: {
    create(input: { projectId: string; architectureVersionId: string; userId: string; assessment: string; ai: Record<string, unknown>; findings: ReviewFindingDraft[] }): Promise<ReviewRecord>;
    latest(projectId: string, architectureVersionId?: string): Promise<ReviewRecord | null>;
    get(id: string): Promise<ReviewRecord | null>;
    getFinding(id: string): Promise<(ReviewFindingRecord & { projectId: string; architectureVersionId: string }) | null>;
  };
  migrations: {
    get(toPlanVersionId: string): Promise<MigrationRecord | null>;
    /** One transaction: activate plan V2, supersede V1, carry completed work forward (with history), record the reviewed mapping. Returns null if V2 was not pending. */
    accept(input: { fromPlanVersionId: string; toPlanVersionId: string; userId: string; proposalId: string | null; items: MigItem[]; summary: MigrationSummary }): Promise<MigrationRecord | null>;
  };
}
export interface ChangeArchitectureView { architecture: ImplPlanInput['architecture']; requirements: ImplPlanInput['requirements']; drivers: ImplPlanInput['drivers'] }
export interface ChangeAnalysisInput extends ChangeArchitectureView {
  context: { workspaceId: string; projectId: string; userId: string }; requestedChange: string; reason: string | null;
  plan: null | { versionNumber: number; progress: { completed: number; applicable: number }; tasks: Array<{ key: string; title: string; status: string; taskType: string; componentKeys: string[]; decisionKeys: string[] }> };
}
export interface ChangePlanInput extends ChangeArchitectureView { context: ChangeAnalysisInput['context']; requestedChange: string; analysis: ChangeAnalysis; basePlan: ArchitecturePlan }
export interface ReviewInput extends ChangeArchitectureView { context: ChangeAnalysisInput['context']; deterministicFindings: ReviewFindingDraft[] }
export interface ChangeAiPort {
  analyze(input: ChangeAnalysisInput): Promise<AiResult<ChangeAnalysis>>;
  plan(input: ChangePlanInput): Promise<AiResult<ChangePlan>>;
  review(input: ReviewInput): Promise<AiResult<ReviewOutput>>;
}


// ====================================================================== Phase 6: trusted knowledge
import type { SourceType, GroundingStatus, IngestionState } from '@pitch2plan/schemas';

export const KNOWLEDGE_INGEST_JOB = 'knowledge.ingest';
export const KNOWLEDGE_REFRESH_JOB = 'knowledge.refresh';
export const KNOWLEDGE_REINDEX_JOB = 'knowledge.reindex';
export const KNOWLEDGE_JOBS = [KNOWLEDGE_INGEST_JOB, KNOWLEDGE_REFRESH_JOB, KNOWLEDGE_REINDEX_JOB] as const;

export interface KnowledgeSourceRecord {
  id: string; technologySlug: string; name: string; sourceType: SourceType; provider: string; baseUrl: string; allowedDomains: string[];
  trustLevel: number; enabled: boolean; lastIngestedAt: Date | null;
}
export interface IngestionRunRecord {
  id: string; sourceId: string; kind: 'INGEST' | 'REFRESH' | 'REINDEX'; status: IngestionState; attempt: number; failureCode: string | null; failureMessage: string | null;
  retryable: boolean; jobId: string | null; stats: Record<string, unknown> | null; createdAt: Date; startedAt: Date | null; heartbeatAt: Date | null; finishedAt: Date | null;
}
export interface EmbeddingMeta { provider: string; model: string; dimensions: number; version: string }
export interface ChunkInput { ordinal: number; sectionTitle: string | null; text: string; tokenEstimate: number; injectionScore: number; embedding: number[] }
export interface SaveVersionInput {
  sourceId: string; technologySlug: string; canonicalUrl: string; title: string; contentHash: string; productVersion: string | null;
  publishedAt: Date | null; sourceUpdatedAt: Date | null; retrievedAt: Date; injectionScore: number; embedding: EmbeddingMeta; chunks: ChunkInput[];
}
export interface KnowledgeCandidate {
  chunkId: string; documentVersionId: string; documentId: string; technologySlug: string; sectionTitle: string | null; text: string; tokenEstimate: number; injectionScore: number;
  embedding: number[]; ftsRank: number; documentTitle: string; url: string; productVersion: string | null; retrievedAt: Date; checkedAt: Date;
  sourceTitle: string; sourceType: SourceType; provider: string; trustLevel: number;
}
export interface KnowledgeDocumentRow {
  documentId: string; versionId: string; technologySlug: string; title: string; url: string; productVersion: string | null; retrievedAt: Date; checkedAt: Date;
  sourceTitle: string; sourceType: SourceType; provider: string; trustLevel: number; chunkCount: number;
}
export interface CitationInput { id: string; projectId: string; userId: string; messageId?: string | null; n: number; chunkId: string; documentVersionId: string; snapshot: Record<string, unknown> }
export interface CitationRecord extends CitationInput { createdAt: Date }
export interface RetrievalRunInput {
  projectId?: string | null; userId: string; scope: string; technologySlugs: string[]; candidateCount: number; selectedCount: number; durationMs: number;
  technologyMatch: boolean; versionMatch: string; groundingStatus: GroundingStatus; citationCount: number;
}

export interface KnowledgeRepositories {
  knowledge: {
    upsertSource(input: Omit<KnowledgeSourceRecord, 'id' | 'lastIngestedAt'>): Promise<KnowledgeSourceRecord>;
    findSourceBySlug(slug: string): Promise<KnowledgeSourceRecord | null>;
    findSource(id: string): Promise<KnowledgeSourceRecord | null>;
    listSources(): Promise<KnowledgeSourceRecord[]>;
    /** A NEW version is created only when the content hash differs from the active version. Unchanged content only bumps `checkedAt`. Superseded versions lose their chunks. */
    saveVersion(input: SaveVersionInput): Promise<{ documentId: string; versionId: string; versionNumber: number; outcome: 'CREATED' | 'NEW_VERSION' | 'UNCHANGED' }>;
    markDocumentsRemoved(sourceId: string, keepUrls: string[]): Promise<number>;
    markSourceIngested(sourceId: string, at: Date): Promise<void>;
    /** Full-text candidates only: a chunk that shares no word with the query is never a candidate. */
    searchCandidates(input: { technologySlugs: string[]; terms: string[]; limit: number }): Promise<KnowledgeCandidate[]>;
    listDocuments(technologySlugs: string[], limit: number): Promise<KnowledgeDocumentRow[]>;
    countActiveDocuments(technologySlug: string): Promise<number>;
    getChunk(id: string): Promise<(KnowledgeCandidate) | null>;
    // ingestion runs
    createRun(input: { sourceId: string; kind: IngestionRunRecord['kind']; requestedById?: string | null }): Promise<{ run: IngestionRunRecord; created: boolean }>;
    attachJob(runId: string, jobId: string): Promise<void>;
    findRun(id: string): Promise<IngestionRunRecord | null>;
    latestRun(sourceId: string): Promise<IngestionRunRecord | null>;
    /** Compare-and-set PENDING→RUNNING (or RUNNING with an expired heartbeat). Returns null if another worker owns it. */
    claimRun(id: string, staleBefore: Date): Promise<IngestionRunRecord | null>;
    heartbeat(id: string): Promise<void>;
    finishRun(id: string, outcome: { ok: true; stats: Record<string, unknown> } | { ok: false; code: string; message: string; retryable: boolean }): Promise<boolean>;
    failStaleRuns(staleBefore: Date): Promise<IngestionRunRecord[]>;
    sourcesDueForRefresh(olderThan: Date): Promise<KnowledgeSourceRecord[]>;
    // re-indexing
    chunksNeedingEmbedding(sourceId: string, currentVersion: string, limit: number): Promise<Array<{ id: string; text: string; sectionTitle: string | null }>>;
    setEmbeddings(items: Array<{ id: string; embedding: number[] }>, meta: EmbeddingMeta): Promise<void>;
    // citations & observability
    saveCitations(items: CitationInput[]): Promise<void>;
    getCitation(id: string): Promise<CitationRecord | null>;
    listCitations(ids: string[]): Promise<CitationRecord[]>;
    recordRetrieval(input: RetrievalRunInput): Promise<void>;
    overview(): Promise<{ sources: Array<KnowledgeSourceRecord & { documents: number; chunks: number; lastRun: IngestionRunRecord | null; embeddingModels: string[] }>; retrievals: { total: number; grounded: number } }>;
  };
}

export interface FetchedDocument { finalUrl: string; contentType: string; body: string; lastModified: Date | null }
/** Fetches ONE page. Implementations must enforce the allow-list on the URL and on every redirect hop. */
export interface DocumentFetcher { fetch(url: string, opts: { allowedDomains: string[]; signal?: AbortSignal }): Promise<FetchedDocument> }
export interface EmbeddingProvider {
  readonly meta: EmbeddingMeta;
  /** True only for a genuinely semantic model. A lexical/hashing embedder must say false: it can re-rank but never prove relevance. */
  readonly semantic: boolean;
  embed(texts: string[]): Promise<number[][]>;
}
