-- Conversations become scoped (PROJECT | COMPONENT | TASK); messages gain status, structured content, context references and an idempotency key.
ALTER TABLE "Conversation" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'PROJECT', ADD COLUMN "scopeId" TEXT NOT NULL DEFAULT '', ADD COLUMN "createdById" UUID;
CREATE UNIQUE INDEX "Conversation_projectId_scope_scopeId_createdById_key" ON "Conversation"("projectId", "scope", "scopeId", "createdById");
ALTER TABLE "Message" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'COMPLETE', ADD COLUMN "structured" JSONB, ADD COLUMN "contextRefs" JSONB, ADD COLUMN "clientMessageId" TEXT, ADD COLUMN "createdById" UUID;
CREATE UNIQUE INDEX "Message_conversationId_clientMessageId_key" ON "Message"("conversationId", "clientMessageId");

CREATE TABLE "ImplementationPlan" ("id" UUID NOT NULL, "projectId" UUID NOT NULL, "currentVersionId" UUID, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ImplementationPlan_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ImplementationPlanVersion" (
  "id" UUID NOT NULL, "planId" UUID NOT NULL, "versionNumber" INTEGER NOT NULL, "architectureVersionId" UUID NOT NULL, "generationRunId" UUID NOT NULL, "summary" TEXT NOT NULL,
  "componentCoverage" JSONB NOT NULL, "ai" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ImplementationPlanVersion_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ImplementationPhase" ("id" UUID NOT NULL, "planVersionId" UUID NOT NULL, "key" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "name" TEXT NOT NULL, "objective" TEXT NOT NULL, "description" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'NOT_STARTED', CONSTRAINT "ImplementationPhase_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ImplementationTask" (
  "id" UUID NOT NULL, "planVersionId" UUID NOT NULL, "phaseId" UUID NOT NULL, "key" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "title" TEXT NOT NULL, "objective" TEXT NOT NULL, "description" TEXT NOT NULL,
  "whyThisTask" TEXT NOT NULL, "taskType" TEXT NOT NULL, "complexity" TEXT NOT NULL, "effort" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'NOT_STARTED', "prerequisites" JSONB NOT NULL, "instructions" TEXT NOT NULL,
  "expectedOutcome" TEXT NOT NULL, "validationSteps" JSONB NOT NULL, "commonProblems" JSONB NOT NULL, "securityNotes" JSONB NOT NULL, "operationalNotes" JSONB NOT NULL, "references" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ImplementationTask_pkey" PRIMARY KEY ("id"));
CREATE TABLE "TaskStep" ("id" UUID NOT NULL, "taskId" UUID NOT NULL, "sequence" INTEGER NOT NULL, "title" TEXT NOT NULL, "instruction" TEXT NOT NULL, "expectedResult" TEXT NOT NULL, "validation" TEXT NOT NULL DEFAULT '', "status" TEXT NOT NULL DEFAULT 'NOT_STARTED', "completedAt" TIMESTAMP(3), CONSTRAINT "TaskStep_pkey" PRIMARY KEY ("id"));
CREATE TABLE "TaskDependency" ("taskId" UUID NOT NULL, "dependsOnTaskId" UUID NOT NULL, CONSTRAINT "TaskDependency_pkey" PRIMARY KEY ("taskId", "dependsOnTaskId"));
CREATE TABLE "TaskComponentLink" ("taskId" UUID NOT NULL, "architectureVersionId" UUID NOT NULL, "stableKey" TEXT NOT NULL, CONSTRAINT "TaskComponentLink_pkey" PRIMARY KEY ("taskId", "stableKey"));
CREATE TABLE "TaskDecisionLink" ("taskId" UUID NOT NULL, "decisionId" UUID NOT NULL, CONSTRAINT "TaskDecisionLink_pkey" PRIMARY KEY ("taskId", "decisionId"));
CREATE TABLE "TaskRequirementLink" ("taskId" UUID NOT NULL, "requirementId" UUID NOT NULL, CONSTRAINT "TaskRequirementLink_pkey" PRIMARY KEY ("taskId", "requirementId"));
CREATE TABLE "TaskProgressEvent" ("id" UUID NOT NULL, "taskId" UUID NOT NULL, "fromStatus" TEXT NOT NULL, "toStatus" TEXT NOT NULL, "reason" TEXT, "actorId" UUID NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "TaskProgressEvent_pkey" PRIMARY KEY ("id"));
CREATE TABLE "TaskValidation" ("id" UUID NOT NULL, "taskId" UUID NOT NULL, "position" INTEGER NOT NULL, "label" TEXT NOT NULL, "confirmed" BOOLEAN NOT NULL DEFAULT false, "confirmationKind" TEXT, "confirmedById" UUID, "confirmedAt" TIMESTAMP(3), CONSTRAINT "TaskValidation_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ImplementationGenerationRun" (
  "id" UUID NOT NULL, "projectId" UUID NOT NULL, "architectureVersionId" UUID NOT NULL, "status" "GenerationRunStatus" NOT NULL DEFAULT 'QUEUED', "currentStage" TEXT NOT NULL DEFAULT 'QUEUED', "attempt" INTEGER NOT NULL DEFAULT 0,
  "repairCount" INTEGER NOT NULL DEFAULT 0, "failureCode" TEXT, "failureMessage" TEXT, "jobId" TEXT, "requestedById" UUID NOT NULL, "ai" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3), "heartbeatAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3), CONSTRAINT "ImplementationGenerationRun_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ImplementationGenerationIssue" (
  "id" UUID NOT NULL, "runId" UUID NOT NULL, "planVersionId" UUID, "stage" TEXT NOT NULL, "source" TEXT NOT NULL, "severity" TEXT NOT NULL, "category" TEXT NOT NULL, "code" TEXT NOT NULL, "description" TEXT NOT NULL,
  "taskKeys" JSONB NOT NULL, "componentKeys" JSONB NOT NULL, "decisionKeys" JSONB NOT NULL, "recommendation" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ImplementationGenerationIssue_pkey" PRIMARY KEY ("id"));

CREATE UNIQUE INDEX "ImplementationPlan_projectId_key" ON "ImplementationPlan"("projectId");
CREATE UNIQUE INDEX "ImplementationPlanVersion_architectureVersionId_key" ON "ImplementationPlanVersion"("architectureVersionId");
CREATE UNIQUE INDEX "ImplementationPlanVersion_generationRunId_key" ON "ImplementationPlanVersion"("generationRunId");
CREATE UNIQUE INDEX "ImplementationPlanVersion_planId_versionNumber_key" ON "ImplementationPlanVersion"("planId", "versionNumber");
CREATE UNIQUE INDEX "ImplementationPhase_planVersionId_key_key" ON "ImplementationPhase"("planVersionId", "key");
CREATE UNIQUE INDEX "ImplementationPhase_planVersionId_sequence_key" ON "ImplementationPhase"("planVersionId", "sequence");
CREATE UNIQUE INDEX "ImplementationTask_planVersionId_key_key" ON "ImplementationTask"("planVersionId", "key");
CREATE UNIQUE INDEX "ImplementationTask_planVersionId_sequence_key" ON "ImplementationTask"("planVersionId", "sequence");
CREATE INDEX "ImplementationTask_phaseId_idx" ON "ImplementationTask"("phaseId");
CREATE UNIQUE INDEX "TaskStep_taskId_sequence_key" ON "TaskStep"("taskId", "sequence");
CREATE INDEX "TaskDependency_dependsOnTaskId_idx" ON "TaskDependency"("dependsOnTaskId");
CREATE INDEX "TaskComponentLink_architectureVersionId_stableKey_idx" ON "TaskComponentLink"("architectureVersionId", "stableKey");
CREATE INDEX "TaskDecisionLink_decisionId_idx" ON "TaskDecisionLink"("decisionId");
CREATE INDEX "TaskRequirementLink_requirementId_idx" ON "TaskRequirementLink"("requirementId");
CREATE INDEX "TaskProgressEvent_taskId_createdAt_idx" ON "TaskProgressEvent"("taskId", "createdAt");
CREATE UNIQUE INDEX "TaskValidation_taskId_position_key" ON "TaskValidation"("taskId", "position");
CREATE UNIQUE INDEX "ImplementationGenerationRun_jobId_key" ON "ImplementationGenerationRun"("jobId");
CREATE INDEX "ImplementationGenerationRun_projectId_createdAt_idx" ON "ImplementationGenerationRun"("projectId", "createdAt");
CREATE INDEX "ImplementationGenerationRun_status_heartbeatAt_idx" ON "ImplementationGenerationRun"("status", "heartbeatAt");
CREATE INDEX "ImplementationGenerationIssue_runId_idx" ON "ImplementationGenerationIssue"("runId");
-- At most ONE active (queued or running) implementation generation per project, enforced by the database.
CREATE UNIQUE INDEX "ImplementationGenerationRun_one_active_per_project" ON "ImplementationGenerationRun"("projectId") WHERE "status" IN ('QUEUED', 'RUNNING');

ALTER TABLE "ImplementationPlan" ADD CONSTRAINT "ImplementationPlan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImplementationPlanVersion" ADD CONSTRAINT "ImplementationPlanVersion_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ImplementationPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImplementationPlanVersion" ADD CONSTRAINT "ImplementationPlanVersion_architectureVersionId_fkey" FOREIGN KEY ("architectureVersionId") REFERENCES "ArchitectureVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImplementationPlanVersion" ADD CONSTRAINT "ImplementationPlanVersion_generationRunId_fkey" FOREIGN KEY ("generationRunId") REFERENCES "ImplementationGenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImplementationPhase" ADD CONSTRAINT "ImplementationPhase_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "ImplementationPlanVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImplementationTask" ADD CONSTRAINT "ImplementationTask_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "ImplementationPlanVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImplementationTask" ADD CONSTRAINT "ImplementationTask_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "ImplementationPhase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskStep" ADD CONSTRAINT "TaskStep_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ImplementationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ImplementationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_dependsOnTaskId_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES "ImplementationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskComponentLink" ADD CONSTRAINT "TaskComponentLink_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ImplementationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskComponentLink" ADD CONSTRAINT "TaskComponentLink_architectureVersionId_fkey" FOREIGN KEY ("architectureVersionId") REFERENCES "ArchitectureVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskDecisionLink" ADD CONSTRAINT "TaskDecisionLink_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ImplementationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskDecisionLink" ADD CONSTRAINT "TaskDecisionLink_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ArchitectureDecision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskRequirementLink" ADD CONSTRAINT "TaskRequirementLink_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ImplementationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskRequirementLink" ADD CONSTRAINT "TaskRequirementLink_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskProgressEvent" ADD CONSTRAINT "TaskProgressEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ImplementationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskValidation" ADD CONSTRAINT "TaskValidation_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ImplementationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImplementationGenerationRun" ADD CONSTRAINT "ImplementationGenerationRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImplementationGenerationIssue" ADD CONSTRAINT "ImplementationGenerationIssue_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ImplementationGenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImplementationGenerationIssue" ADD CONSTRAINT "ImplementationGenerationIssue_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "ImplementationPlanVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A plan version is permanently bound to its architecture version and its run.
CREATE FUNCTION "p2p_guard_plan_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."architectureVersionId" <> OLD."architectureVersionId" OR NEW."generationRunId" <> OLD."generationRunId" OR NEW."planId" <> OLD."planId" THEN
    RAISE EXCEPTION 'ImplementationPlanVersion % is bound to its architecture version and cannot be re-pointed', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "p2p_plan_version_binding" BEFORE UPDATE ON "ImplementationPlanVersion" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_plan_version"();

-- The roadmap's content never changes silently: of a task, only its status (and updatedAt) may be updated.
CREATE FUNCTION "p2p_guard_task_content"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'updatedAt') <> (to_jsonb(OLD) - 'status' - 'updatedAt') THEN
    RAISE EXCEPTION 'ImplementationTask % content is immutable; only its status can change', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "p2p_task_content_immutable" BEFORE UPDATE ON "ImplementationTask" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_task_content"();
