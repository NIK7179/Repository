-- ===== existing tables =====
ALTER TABLE "ArchitectureGenerationRun" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'INITIAL', ADD COLUMN "proposalId" UUID, ADD COLUMN "baseVersionId" UUID;
ALTER TABLE "ArchitectureVersion" ADD COLUMN "parentVersionId" UUID, ADD COLUMN "sourceProposalId" UUID;
ALTER TABLE "ArchitectureDecision" ADD COLUMN "supersedesDecisionId" UUID;
ALTER TABLE "ArchitectureBriefVersion" ADD COLUMN "sourceProposalId" UUID;
ALTER TABLE "ImplementationPlanVersion" ADD COLUMN "activation" TEXT NOT NULL DEFAULT 'ACTIVE', ADD COLUMN "supersedesPlanVersionId" UUID, ADD COLUMN "sourceProposalId" UUID;
ALTER TABLE "ImplementationGenerationRun" ADD COLUMN "chainProposalId" UUID;

-- ===== new tables =====
CREATE TABLE "ArchitectureChangeProposal" (
  "id" UUID NOT NULL, "projectId" UUID NOT NULL, "baseVersionId" UUID NOT NULL, "source" TEXT NOT NULL, "requestedChange" TEXT NOT NULL, "reason" TEXT, "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "changeType" TEXT, "severity" TEXT, "requiresReconfirmation" BOOLEAN NOT NULL DEFAULT false, "requirementChanges" JSONB NOT NULL DEFAULT '[]', "analysis" JSONB, "analysisAi" JSONB,
  "analysisAttempt" INTEGER NOT NULL DEFAULT 0, "analysisHeartbeatAt" TIMESTAMP(3), "failureCode" TEXT, "failureMessage" TEXT, "assistantConversationId" UUID, "assistantMessageId" UUID,
  "reviewFindingId" UUID, "rebasedFromId" UUID, "briefVersionId" UUID, "createdById" UUID NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  "analyzedAt" TIMESTAMP(3), CONSTRAINT "ArchitectureChangeProposal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ArchitectureChangeProposal_status_check" CHECK ("status" IN ('DRAFT','ANALYZING','READY_FOR_REVIEW','APPROVED','REJECTED','APPLYING','APPLIED','FAILED','STALE')),
  CONSTRAINT "ArchitectureChangeProposal_source_check" CHECK ("source" IN ('USER_REQUEST','ASSISTANT_RECOMMENDATION','ARCHITECTURE_REVIEW','IMPLEMENTATION_DISCOVERY','FUTURE_COST_OPTIMIZATION','FUTURE_SECURITY_REVIEW')));
CREATE TABLE "ChangeProposalImpactItem" ("id" UUID NOT NULL, "proposalId" UUID NOT NULL, "kind" TEXT NOT NULL, "refKey" TEXT NOT NULL, "relation" TEXT NOT NULL, "reason" TEXT NOT NULL, "taskId" UUID, CONSTRAINT "ChangeProposalImpactItem_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ChangeProposalApproval" ("id" UUID NOT NULL, "proposalId" UUID NOT NULL, "decision" TEXT NOT NULL, "decidedById" UUID NOT NULL, "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "architectureVersionId" UUID NOT NULL, "confirmedRequirementChanges" BOOLEAN NOT NULL DEFAULT false, "note" TEXT,
  CONSTRAINT "ChangeProposalApproval_pkey" PRIMARY KEY ("id"), CONSTRAINT "ChangeProposalApproval_decision_check" CHECK ("decision" IN ('APPROVED','REJECTED')));
CREATE TABLE "ArchitectureVersionDiff" ("id" UUID NOT NULL, "fromVersionId" UUID NOT NULL, "toVersionId" UUID NOT NULL, "proposalId" UUID, "summary" JSONB NOT NULL, "entries" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ArchitectureVersionDiff_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ImplementationMigration" ("id" UUID NOT NULL, "fromPlanVersionId" UUID NOT NULL, "toPlanVersionId" UUID NOT NULL, "proposalId" UUID, "acceptedById" UUID NOT NULL, "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "summary" JSONB NOT NULL, CONSTRAINT "ImplementationMigration_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ImplementationMigrationItem" ("id" UUID NOT NULL, "migrationId" UUID NOT NULL, "v1TaskId" UUID, "v2TaskId" UUID, "outcome" TEXT NOT NULL, "reason" TEXT NOT NULL, "v1Status" TEXT, CONSTRAINT "ImplementationMigrationItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImplementationMigrationItem_outcome_check" CHECK ("outcome" IN ('CARRIED_FORWARD','REQUIRES_REVALIDATION','OBSOLETE','NEW','UNCHANGED_NOT_STARTED')));
CREATE TABLE "ArchitectureReview" ("id" UUID NOT NULL, "projectId" UUID NOT NULL, "architectureVersionId" UUID NOT NULL, "createdById" UUID NOT NULL, "assessment" TEXT NOT NULL, "ai" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ArchitectureReview_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ArchitectureReviewFinding" ("id" UUID NOT NULL, "reviewId" UUID NOT NULL, "area" TEXT NOT NULL, "severity" TEXT NOT NULL, "title" TEXT NOT NULL, "description" TEXT NOT NULL, "recommendation" TEXT NOT NULL, "nodeKeys" JSONB NOT NULL, "decisionKeys" JSONB NOT NULL, "requiresArchitectureChange" BOOLEAN NOT NULL, "suggestedChange" TEXT NOT NULL, "source" TEXT NOT NULL, CONSTRAINT "ArchitectureReviewFinding_pkey" PRIMARY KEY ("id"));

-- ===== indexes =====
CREATE UNIQUE INDEX "ArchitectureGenerationRun_proposalId_key" ON "ArchitectureGenerationRun"("proposalId");
CREATE UNIQUE INDEX "ArchitectureVersion_sourceProposalId_key" ON "ArchitectureVersion"("sourceProposalId");
CREATE UNIQUE INDEX "ArchitectureBriefVersion_sourceProposalId_key" ON "ArchitectureBriefVersion"("sourceProposalId");
CREATE UNIQUE INDEX "ImplementationGenerationRun_chainProposalId_key" ON "ImplementationGenerationRun"("chainProposalId");
CREATE INDEX "ArchitectureChangeProposal_projectId_createdAt_idx" ON "ArchitectureChangeProposal"("projectId", "createdAt");
CREATE INDEX "ArchitectureChangeProposal_baseVersionId_status_idx" ON "ArchitectureChangeProposal"("baseVersionId", "status");
CREATE UNIQUE INDEX "ChangeProposalImpactItem_proposalId_kind_refKey_key" ON "ChangeProposalImpactItem"("proposalId", "kind", "refKey");
CREATE UNIQUE INDEX "ChangeProposalApproval_proposalId_key" ON "ChangeProposalApproval"("proposalId");
CREATE UNIQUE INDEX "ArchitectureVersionDiff_fromVersionId_toVersionId_key" ON "ArchitectureVersionDiff"("fromVersionId", "toVersionId");
CREATE UNIQUE INDEX "ImplementationMigration_toPlanVersionId_key" ON "ImplementationMigration"("toPlanVersionId");
CREATE INDEX "ImplementationMigrationItem_migrationId_idx" ON "ImplementationMigrationItem"("migrationId");
CREATE INDEX "ImplementationMigrationItem_v2TaskId_idx" ON "ImplementationMigrationItem"("v2TaskId");
CREATE INDEX "ArchitectureReview_projectId_createdAt_idx" ON "ArchitectureReview"("projectId", "createdAt");
CREATE INDEX "ArchitectureReviewFinding_reviewId_idx" ON "ArchitectureReviewFinding"("reviewId");
-- At most ONE active change application per project, enforced by the database.
CREATE UNIQUE INDEX "ArchitectureGenerationRun_one_active_change_per_project" ON "ArchitectureGenerationRun"("projectId") WHERE "mode" = 'CHANGE' AND "status" IN ('QUEUED', 'RUNNING');

-- ===== foreign keys =====
ALTER TABLE "ArchitectureChangeProposal" ADD CONSTRAINT "ArchitectureChangeProposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureChangeProposal" ADD CONSTRAINT "ArchitectureChangeProposal_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "ArchitectureVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ArchitectureChangeProposal" ADD CONSTRAINT "ArchitectureChangeProposal_rebasedFromId_fkey" FOREIGN KEY ("rebasedFromId") REFERENCES "ArchitectureChangeProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ArchitectureChangeProposal" ADD CONSTRAINT "ArchitectureChangeProposal_reviewFindingId_fkey" FOREIGN KEY ("reviewFindingId") REFERENCES "ArchitectureReviewFinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ArchitectureGenerationRun" ADD CONSTRAINT "ArchitectureGenerationRun_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "ArchitectureChangeProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ArchitectureVersion" ADD CONSTRAINT "ArchitectureVersion_sourceProposalId_fkey" FOREIGN KEY ("sourceProposalId") REFERENCES "ArchitectureChangeProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ArchitectureDecision" ADD CONSTRAINT "ArchitectureDecision_supersedesDecisionId_fkey" FOREIGN KEY ("supersedesDecisionId") REFERENCES "ArchitectureDecision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChangeProposalImpactItem" ADD CONSTRAINT "ChangeProposalImpactItem_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "ArchitectureChangeProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChangeProposalApproval" ADD CONSTRAINT "ChangeProposalApproval_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "ArchitectureChangeProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureVersionDiff" ADD CONSTRAINT "ArchitectureVersionDiff_fromVersionId_fkey" FOREIGN KEY ("fromVersionId") REFERENCES "ArchitectureVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ArchitectureVersionDiff" ADD CONSTRAINT "ArchitectureVersionDiff_toVersionId_fkey" FOREIGN KEY ("toVersionId") REFERENCES "ArchitectureVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImplementationMigration" ADD CONSTRAINT "ImplementationMigration_fromPlanVersionId_fkey" FOREIGN KEY ("fromPlanVersionId") REFERENCES "ImplementationPlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImplementationMigration" ADD CONSTRAINT "ImplementationMigration_toPlanVersionId_fkey" FOREIGN KEY ("toPlanVersionId") REFERENCES "ImplementationPlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImplementationMigrationItem" ADD CONSTRAINT "ImplementationMigrationItem_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "ImplementationMigration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImplementationMigrationItem" ADD CONSTRAINT "ImplementationMigrationItem_v1TaskId_fkey" FOREIGN KEY ("v1TaskId") REFERENCES "ImplementationTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImplementationMigrationItem" ADD CONSTRAINT "ImplementationMigrationItem_v2TaskId_fkey" FOREIGN KEY ("v2TaskId") REFERENCES "ImplementationTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ArchitectureReview" ADD CONSTRAINT "ArchitectureReview_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureReview" ADD CONSTRAINT "ArchitectureReview_architectureVersionId_fkey" FOREIGN KEY ("architectureVersionId") REFERENCES "ArchitectureVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ArchitectureReviewFinding" ADD CONSTRAINT "ArchitectureReviewFinding_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "ArchitectureReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== database-level safety =====
-- A proposal is bound to the architecture version it modifies, permanently.
CREATE FUNCTION "p2p_guard_proposal_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."baseVersionId" <> OLD."baseVersionId" OR NEW."projectId" <> OLD."projectId" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'ArchitectureChangeProposal % is bound to its architecture version and cannot be re-pointed', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "p2p_proposal_binding" BEFORE UPDATE ON "ArchitectureChangeProposal" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_proposal_binding"();

-- Approvals, diffs and migration records are history: they are never edited.
CREATE FUNCTION "p2p_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only and cannot be updated', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER "p2p_approval_append_only" BEFORE UPDATE ON "ChangeProposalApproval" FOR EACH ROW EXECUTE FUNCTION "p2p_append_only"();
CREATE TRIGGER "p2p_diff_append_only" BEFORE UPDATE ON "ArchitectureVersionDiff" FOR EACH ROW EXECUTE FUNCTION "p2p_append_only"();
CREATE TRIGGER "p2p_migration_append_only" BEFORE UPDATE ON "ImplementationMigration" FOR EACH ROW EXECUTE FUNCTION "p2p_append_only"();
CREATE TRIGGER "p2p_migration_item_append_only" BEFORE UPDATE ON "ImplementationMigrationItem" FOR EACH ROW EXECUTE FUNCTION "p2p_append_only"();
