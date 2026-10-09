-- CreateEnum
CREATE TYPE "ArchitectureVersionStatus" AS ENUM ('DRAFT', 'VALIDATING', 'CRITIQUING', 'READY', 'FAILED', 'SUPERSEDED');
CREATE TYPE "GenerationRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "DecisionStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'DEPRECATED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "Architecture" (
    "id" UUID NOT NULL, "projectId" UUID NOT NULL, "currentVersionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Architecture_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ArchitectureVersion" (
    "id" UUID NOT NULL, "architectureId" UUID NOT NULL, "versionNumber" INTEGER NOT NULL,
    "status" "ArchitectureVersionStatus" NOT NULL DEFAULT 'DRAFT', "generationRunId" UUID NOT NULL, "briefVersionId" UUID NOT NULL,
    "summary" TEXT NOT NULL, "assumptions" JSONB NOT NULL, "unresolvedQuestions" JSONB NOT NULL, "risks" JSONB NOT NULL, "ai" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finalizedAt" TIMESTAMP(3),
    CONSTRAINT "ArchitectureVersion_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ArchitectureNode" (
    "id" UUID NOT NULL, "versionId" UUID NOT NULL, "stableKey" TEXT NOT NULL, "name" TEXT NOT NULL, "technology" TEXT NOT NULL, "technologySlug" TEXT NOT NULL,
    "category" TEXT NOT NULL, "purpose" TEXT NOT NULL, "description" TEXT NOT NULL, "criticality" TEXT NOT NULL, "managedService" BOOLEAN NOT NULL, "provider" TEXT,
    "deploymentModel" TEXT NOT NULL, "configuration" JSONB NOT NULL, "risks" JSONB NOT NULL, "alternatives" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "replacesStableKey" TEXT,
    CONSTRAINT "ArchitectureNode_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ArchitectureEdge" (
    "id" UUID NOT NULL, "versionId" UUID NOT NULL, "edgeKey" TEXT NOT NULL, "sourceStableKey" TEXT NOT NULL, "targetStableKey" TEXT NOT NULL, "label" TEXT NOT NULL,
    "protocol" TEXT NOT NULL, "communicationType" TEXT NOT NULL, "dataDescription" TEXT NOT NULL, "synchronous" BOOLEAN NOT NULL, "encrypted" BOOLEAN, "criticality" TEXT NOT NULL,
    CONSTRAINT "ArchitectureEdge_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ArchitectureDecision" (
    "id" UUID NOT NULL, "versionId" UUID NOT NULL, "key" TEXT NOT NULL, "title" TEXT NOT NULL, "problem" TEXT NOT NULL, "decision" TEXT NOT NULL, "rationale" TEXT NOT NULL,
    "status" "DecisionStatus" NOT NULL, "tradeoffs" JSONB NOT NULL, "risks" JSONB NOT NULL, "alternatives" JSONB NOT NULL, "consequences" JSONB NOT NULL, "confidence" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArchitectureDecision_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "DecisionDriverLink" ("decisionId" UUID NOT NULL, "driverId" UUID NOT NULL, CONSTRAINT "DecisionDriverLink_pkey" PRIMARY KEY ("decisionId", "driverId"));
CREATE TABLE "DecisionRequirementLink" ("decisionId" UUID NOT NULL, "requirementId" UUID NOT NULL, CONSTRAINT "DecisionRequirementLink_pkey" PRIMARY KEY ("decisionId", "requirementId"));
CREATE TABLE "NodeDecisionLink" ("decisionId" UUID NOT NULL, "nodeId" UUID NOT NULL, CONSTRAINT "NodeDecisionLink_pkey" PRIMARY KEY ("decisionId", "nodeId"));
CREATE TABLE "EdgeDecisionLink" ("decisionId" UUID NOT NULL, "edgeId" UUID NOT NULL, CONSTRAINT "EdgeDecisionLink_pkey" PRIMARY KEY ("decisionId", "edgeId"));
CREATE TABLE "ArchitectureGenerationRun" (
    "id" UUID NOT NULL, "projectId" UUID NOT NULL, "briefVersionId" UUID NOT NULL, "status" "GenerationRunStatus" NOT NULL DEFAULT 'QUEUED', "currentStage" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 0, "repairCount" INTEGER NOT NULL DEFAULT 0, "failureCode" TEXT, "failureMessage" TEXT, "jobId" TEXT, "requestedById" UUID NOT NULL, "ai" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "startedAt" TIMESTAMP(3), "heartbeatAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
    CONSTRAINT "ArchitectureGenerationRun_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ArchitectureGenerationIssue" (
    "id" UUID NOT NULL, "runId" UUID NOT NULL, "versionId" UUID, "stage" TEXT NOT NULL, "source" TEXT NOT NULL, "severity" TEXT NOT NULL, "category" TEXT NOT NULL, "code" TEXT NOT NULL,
    "description" TEXT NOT NULL, "affectedNodeStableKeys" JSONB NOT NULL, "affectedDecisionKeys" JSONB NOT NULL, "relatedRequirementCodes" JSONB NOT NULL, "recommendation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArchitectureGenerationIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Architecture_projectId_key" ON "Architecture"("projectId");
CREATE UNIQUE INDEX "ArchitectureVersion_generationRunId_key" ON "ArchitectureVersion"("generationRunId");
CREATE UNIQUE INDEX "ArchitectureVersion_architectureId_versionNumber_key" ON "ArchitectureVersion"("architectureId", "versionNumber");
CREATE UNIQUE INDEX "ArchitectureNode_versionId_stableKey_key" ON "ArchitectureNode"("versionId", "stableKey");
CREATE UNIQUE INDEX "ArchitectureEdge_versionId_edgeKey_key" ON "ArchitectureEdge"("versionId", "edgeKey");
CREATE UNIQUE INDEX "ArchitectureDecision_versionId_key_key" ON "ArchitectureDecision"("versionId", "key");
CREATE INDEX "DecisionDriverLink_driverId_idx" ON "DecisionDriverLink"("driverId");
CREATE INDEX "DecisionRequirementLink_requirementId_idx" ON "DecisionRequirementLink"("requirementId");
CREATE INDEX "NodeDecisionLink_nodeId_idx" ON "NodeDecisionLink"("nodeId");
CREATE INDEX "EdgeDecisionLink_edgeId_idx" ON "EdgeDecisionLink"("edgeId");
CREATE UNIQUE INDEX "ArchitectureGenerationRun_jobId_key" ON "ArchitectureGenerationRun"("jobId");
CREATE INDEX "ArchitectureGenerationRun_projectId_createdAt_idx" ON "ArchitectureGenerationRun"("projectId", "createdAt");
CREATE INDEX "ArchitectureGenerationRun_status_heartbeatAt_idx" ON "ArchitectureGenerationRun"("status", "heartbeatAt");
CREATE INDEX "ArchitectureGenerationIssue_runId_idx" ON "ArchitectureGenerationIssue"("runId");
CREATE INDEX "ArchitectureGenerationIssue_versionId_idx" ON "ArchitectureGenerationIssue"("versionId");

-- AddForeignKey
ALTER TABLE "Architecture" ADD CONSTRAINT "Architecture_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureVersion" ADD CONSTRAINT "ArchitectureVersion_architectureId_fkey" FOREIGN KEY ("architectureId") REFERENCES "Architecture"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureVersion" ADD CONSTRAINT "ArchitectureVersion_generationRunId_fkey" FOREIGN KEY ("generationRunId") REFERENCES "ArchitectureGenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureNode" ADD CONSTRAINT "ArchitectureNode_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ArchitectureVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureEdge" ADD CONSTRAINT "ArchitectureEdge_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ArchitectureVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureDecision" ADD CONSTRAINT "ArchitectureDecision_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ArchitectureVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionDriverLink" ADD CONSTRAINT "DecisionDriverLink_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ArchitectureDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionDriverLink" ADD CONSTRAINT "DecisionDriverLink_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "ArchitectureDriver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionRequirementLink" ADD CONSTRAINT "DecisionRequirementLink_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ArchitectureDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionRequirementLink" ADD CONSTRAINT "DecisionRequirementLink_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NodeDecisionLink" ADD CONSTRAINT "NodeDecisionLink_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ArchitectureDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NodeDecisionLink" ADD CONSTRAINT "NodeDecisionLink_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "ArchitectureNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EdgeDecisionLink" ADD CONSTRAINT "EdgeDecisionLink_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ArchitectureDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EdgeDecisionLink" ADD CONSTRAINT "EdgeDecisionLink_edgeId_fkey" FOREIGN KEY ("edgeId") REFERENCES "ArchitectureEdge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureGenerationRun" ADD CONSTRAINT "ArchitectureGenerationRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureGenerationIssue" ADD CONSTRAINT "ArchitectureGenerationIssue_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ArchitectureGenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureGenerationIssue" ADD CONSTRAINT "ArchitectureGenerationIssue_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ArchitectureVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Immutability. A READY (or SUPERSEDED) architecture version and its graph can never be changed in place; the only
-- permitted write is READY -> SUPERSEDED on the version row itself. Changes require a NEW version.
CREATE FUNCTION "p2p_guard_architecture_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('READY', 'SUPERSEDED') THEN
    IF OLD."status" = 'READY' AND NEW."status" = 'SUPERSEDED' AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ArchitectureVersion % is % and cannot be modified; create a new version instead', OLD."id", OLD."status" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "p2p_architecture_version_immutable" BEFORE UPDATE ON "ArchitectureVersion" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_architecture_version"();

CREATE FUNCTION "p2p_guard_architecture_children"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "ArchitectureVersion" WHERE "id" = NEW."versionId";
  IF v_status IN ('READY', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'ArchitectureVersion % is % and its graph cannot be modified', NEW."versionId", v_status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "p2p_architecture_node_immutable" BEFORE INSERT OR UPDATE ON "ArchitectureNode" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_architecture_children"();
CREATE TRIGGER "p2p_architecture_edge_immutable" BEFORE INSERT OR UPDATE ON "ArchitectureEdge" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_architecture_children"();
CREATE TRIGGER "p2p_architecture_decision_immutable" BEFORE INSERT OR UPDATE ON "ArchitectureDecision" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_architecture_children"();

CREATE FUNCTION "p2p_guard_decision_links"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT v."status"::text INTO v_status FROM "ArchitectureDecision" d JOIN "ArchitectureVersion" v ON v."id" = d."versionId" WHERE d."id" = NEW."decisionId";
  IF v_status IN ('READY', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'The decision belongs to a % architecture version and its links cannot be modified', v_status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "p2p_decision_driver_link_immutable" BEFORE INSERT OR UPDATE ON "DecisionDriverLink" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_decision_links"();
CREATE TRIGGER "p2p_decision_requirement_link_immutable" BEFORE INSERT OR UPDATE ON "DecisionRequirementLink" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_decision_links"();
CREATE TRIGGER "p2p_node_decision_link_immutable" BEFORE INSERT OR UPDATE ON "NodeDecisionLink" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_decision_links"();
CREATE TRIGGER "p2p_edge_decision_link_immutable" BEFORE INSERT OR UPDATE ON "EdgeDecisionLink" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_decision_links"();
