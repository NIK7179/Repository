-- CreateEnum
CREATE TYPE "DiscoverySessionStatus" AS ENUM ('ACTIVE', 'READY_FOR_BRIEF');
CREATE TYPE "DiscoveryRoundStatus" AS ENUM ('OPEN', 'ANSWERED', 'COMPLETED', 'SKIPPED');
CREATE TYPE "RequirementStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'DISMISSED');
CREATE TYPE "RequirementOrigin" AS ENUM ('USER_STATED', 'USER_ANSWERED', 'AI_INFERRED', 'AI_RECOMMENDED', 'SYSTEM_DERIVED');
CREATE TYPE "RequirementVersionSource" AS ENUM ('USER_STATED', 'USER_ANSWERED', 'AI_INFERRED', 'AI_RECOMMENDED', 'SYSTEM_DERIVED', 'USER_EDITED');
CREATE TYPE "ConflictStatus" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "BriefStatus" AS ENUM ('DRAFT', 'CONFIRMED');

-- CreateTable
CREATE TABLE "DiscoverySession" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "DiscoverySessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "unknowns" JSONB NOT NULL,
    "finishReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscoverySession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscoveryRound" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "DiscoveryRoundStatus" NOT NULL DEFAULT 'OPEN',
    "reasonForAnotherRound" TEXT NOT NULL DEFAULT '',
    "canGenerateBrief" BOOLEAN NOT NULL DEFAULT false,
    "ai" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "DiscoveryRound_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscoveryQuestion" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "roundId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "whyItMatters" TEXT NOT NULL,
    "answerType" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL,
    "priority" TEXT NOT NULL,
    "allowRecommendation" BOOLEAN NOT NULL,
    "relatedUnknowns" JSONB NOT NULL,
    "numberRange" JSONB,
    "advanced" JSONB,
    "position" INTEGER NOT NULL,
    CONSTRAINT "DiscoveryQuestion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscoveryQuestionOption" (
    "id" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL,
    CONSTRAINT "DiscoveryQuestionOption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscoveryAnswer" (
    "id" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "choice" JSONB NOT NULL,
    "advanced" JSONB,
    "resolvedValue" TEXT,
    "recommendationReason" TEXT,
    "answeredById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscoveryAnswer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Requirement" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" "RequirementStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Requirement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RequirementVersion" (
    "id" UUID NOT NULL,
    "requirementId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "statement" TEXT NOT NULL,
    "value" TEXT,
    "origin" "RequirementOrigin" NOT NULL,
    "source" "RequirementVersionSource" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "tags" JSONB NOT NULL,
    "previousStatement" TEXT,
    "previousValue" TEXT,
    "createdById" UUID,
    "roundId" UUID,
    "ai" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RequirementVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RequirementSource" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "questionKey" TEXT,
    "quote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RequirementSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscoveryConflict" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "detectedBy" TEXT NOT NULL,
    "ruleId" TEXT,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requirementIds" JSONB NOT NULL,
    "status" "ConflictStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" JSONB,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "ai" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscoveryConflict_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArchitectureBrief" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "BriefStatus" NOT NULL DEFAULT 'DRAFT',
    "confirmedVersionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ArchitectureBrief_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArchitectureBriefVersion" (
    "id" UUID NOT NULL,
    "briefId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "requirementsFingerprint" TEXT NOT NULL,
    "ai" JSONB NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" UUID,
    "acceptedUnknownIds" JSONB,
    CONSTRAINT "ArchitectureBriefVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArchitectureDriver" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "briefVersionId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    CONSTRAINT "ArchitectureDriver_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArchitectureDriverRequirement" (
    "driverId" UUID NOT NULL,
    "requirementId" UUID NOT NULL,
    CONSTRAINT "ArchitectureDriverRequirement_pkey" PRIMARY KEY ("driverId", "requirementId")
);

CREATE TABLE "AnalyticsEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID,
    "userId" UUID,
    "name" TEXT NOT NULL,
    "properties" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscoverySession_projectId_key" ON "DiscoverySession"("projectId");
CREATE UNIQUE INDEX "DiscoveryRound_sessionId_number_key" ON "DiscoveryRound"("sessionId", "number");
CREATE INDEX "DiscoveryQuestion_roundId_idx" ON "DiscoveryQuestion"("roundId");
CREATE UNIQUE INDEX "DiscoveryQuestion_sessionId_key_key" ON "DiscoveryQuestion"("sessionId", "key");
CREATE UNIQUE INDEX "DiscoveryQuestionOption_questionId_key_key" ON "DiscoveryQuestionOption"("questionId", "key");
CREATE UNIQUE INDEX "DiscoveryAnswer_questionId_key" ON "DiscoveryAnswer"("questionId");
CREATE INDEX "Requirement_projectId_status_idx" ON "Requirement"("projectId", "status");
CREATE UNIQUE INDEX "Requirement_projectId_key_key" ON "Requirement"("projectId", "key");
CREATE UNIQUE INDEX "RequirementVersion_requirementId_version_key" ON "RequirementVersion"("requirementId", "version");
CREATE INDEX "RequirementSource_versionId_idx" ON "RequirementSource"("versionId");
CREATE INDEX "DiscoveryConflict_projectId_status_idx" ON "DiscoveryConflict"("projectId", "status");
CREATE UNIQUE INDEX "DiscoveryConflict_projectId_fingerprint_key" ON "DiscoveryConflict"("projectId", "fingerprint");
CREATE UNIQUE INDEX "ArchitectureBrief_projectId_key" ON "ArchitectureBrief"("projectId");
CREATE UNIQUE INDEX "ArchitectureBriefVersion_briefId_version_key" ON "ArchitectureBriefVersion"("briefId", "version");
CREATE INDEX "ArchitectureDriver_projectId_idx" ON "ArchitectureDriver"("projectId");
CREATE UNIQUE INDEX "ArchitectureDriver_briefVersionId_key_key" ON "ArchitectureDriver"("briefVersionId", "key");
CREATE INDEX "ArchitectureDriverRequirement_requirementId_idx" ON "ArchitectureDriverRequirement"("requirementId");
CREATE INDEX "AnalyticsEvent_workspaceId_createdAt_idx" ON "AnalyticsEvent"("workspaceId", "createdAt");
CREATE INDEX "AnalyticsEvent_projectId_name_idx" ON "AnalyticsEvent"("projectId", "name");

-- AddForeignKey
ALTER TABLE "DiscoverySession" ADD CONSTRAINT "DiscoverySession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveryRound" ADD CONSTRAINT "DiscoveryRound_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DiscoverySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveryQuestion" ADD CONSTRAINT "DiscoveryQuestion_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DiscoverySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveryQuestion" ADD CONSTRAINT "DiscoveryQuestion_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "DiscoveryRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveryQuestionOption" ADD CONSTRAINT "DiscoveryQuestionOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "DiscoveryQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveryAnswer" ADD CONSTRAINT "DiscoveryAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "DiscoveryQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequirementVersion" ADD CONSTRAINT "RequirementVersion_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequirementSource" ADD CONSTRAINT "RequirementSource_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "RequirementVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveryConflict" ADD CONSTRAINT "DiscoveryConflict_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureBrief" ADD CONSTRAINT "ArchitectureBrief_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureBriefVersion" ADD CONSTRAINT "ArchitectureBriefVersion_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "ArchitectureBrief"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureDriver" ADD CONSTRAINT "ArchitectureDriver_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureDriver" ADD CONSTRAINT "ArchitectureDriver_briefVersionId_fkey" FOREIGN KEY ("briefVersionId") REFERENCES "ArchitectureBriefVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureDriverRequirement" ADD CONSTRAINT "ArchitectureDriverRequirement_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "ArchitectureDriver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchitectureDriverRequirement" ADD CONSTRAINT "ArchitectureDriverRequirement_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
