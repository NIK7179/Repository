-- Phase 6: trusted knowledge. pgvector is NOT assumed: embeddings are DOUBLE PRECISION[] and candidate selection is Postgres full-text search.
CREATE TABLE "KnowledgeSource" (
  "id" UUID NOT NULL, "technologySlug" TEXT NOT NULL, "name" TEXT NOT NULL, "sourceType" TEXT NOT NULL, "provider" TEXT NOT NULL, "baseUrl" TEXT NOT NULL, "allowedDomains" JSONB NOT NULL,
  "trustLevel" DOUBLE PRECISION NOT NULL DEFAULT 1, "enabled" BOOLEAN NOT NULL DEFAULT true, "lastIngestedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeSource_sourceType_check" CHECK ("sourceType" IN ('OFFICIAL_DOCS','OFFICIAL_API_DOCS','OFFICIAL_REPOSITORY','OFFICIAL_RELEASE_NOTES','STANDARD','CURATED_INTERNAL')));
CREATE TABLE "KnowledgeDocument" (
  "id" UUID NOT NULL, "sourceId" UUID NOT NULL, "technologySlug" TEXT NOT NULL, "canonicalUrl" TEXT NOT NULL, "title" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeDocument_status_check" CHECK ("status" IN ('ACTIVE','REMOVED')));
CREATE TABLE "KnowledgeDocumentVersion" (
  "id" UUID NOT NULL, "documentId" UUID NOT NULL, "versionNumber" INTEGER NOT NULL, "contentHash" TEXT NOT NULL, "title" TEXT NOT NULL, "productVersion" TEXT, "publishedAt" TIMESTAMP(3), "sourceUpdatedAt" TIMESTAMP(3),
  "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "status" TEXT NOT NULL DEFAULT 'ACTIVE', "chunkCount" INTEGER NOT NULL DEFAULT 0, "injectionScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "KnowledgeDocumentVersion_pkey" PRIMARY KEY ("id"), CONSTRAINT "KnowledgeDocumentVersion_status_check" CHECK ("status" IN ('ACTIVE','SUPERSEDED')));
CREATE TABLE "KnowledgeChunk" (
  "id" UUID NOT NULL, "documentVersionId" UUID NOT NULL, "documentId" UUID NOT NULL, "technologySlug" TEXT NOT NULL, "ordinal" INTEGER NOT NULL, "sectionTitle" TEXT, "text" TEXT NOT NULL, "tokenEstimate" INTEGER NOT NULL,
  "injectionScore" DOUBLE PRECISION NOT NULL DEFAULT 0, "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[], "embeddingProvider" TEXT NOT NULL, "embeddingModel" TEXT NOT NULL, "embeddingDimensions" INTEGER NOT NULL,
  "embeddingVersion" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("sectionTitle", '') || ' ' || "text")) STORED,
  CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id"));
CREATE TABLE "KnowledgeIngestionRun" (
  "id" UUID NOT NULL, "sourceId" UUID NOT NULL, "kind" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "attempt" INTEGER NOT NULL DEFAULT 0, "failureCode" TEXT, "failureMessage" TEXT, "retryable" BOOLEAN NOT NULL DEFAULT false,
  "jobId" TEXT, "stats" JSONB, "requestedById" UUID, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "startedAt" TIMESTAMP(3), "heartbeatAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
  CONSTRAINT "KnowledgeIngestionRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeIngestionRun_kind_check" CHECK ("kind" IN ('INGEST','REFRESH','REINDEX')),
  CONSTRAINT "KnowledgeIngestionRun_status_check" CHECK ("status" IN ('PENDING','RUNNING','SUCCEEDED','FAILED')));
CREATE TABLE "KnowledgeRetrievalRun" (
  "id" UUID NOT NULL, "projectId" UUID, "userId" UUID NOT NULL, "scope" TEXT NOT NULL, "technologySlugs" JSONB NOT NULL, "candidateCount" INTEGER NOT NULL, "selectedCount" INTEGER NOT NULL, "durationMs" INTEGER NOT NULL,
  "technologyMatch" BOOLEAN NOT NULL, "versionMatch" TEXT NOT NULL, "groundingStatus" TEXT NOT NULL, "citationCount" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeRetrievalRun_pkey" PRIMARY KEY ("id"));
CREATE TABLE "KnowledgeCitation" (
  "id" UUID NOT NULL, "projectId" UUID NOT NULL, "userId" UUID NOT NULL, "messageId" UUID, "n" INTEGER NOT NULL, "chunkId" UUID NOT NULL, "documentVersionId" UUID NOT NULL, "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "KnowledgeCitation_pkey" PRIMARY KEY ("id"));

CREATE UNIQUE INDEX "KnowledgeSource_technologySlug_key" ON "KnowledgeSource"("technologySlug");
CREATE UNIQUE INDEX "KnowledgeDocument_sourceId_canonicalUrl_key" ON "KnowledgeDocument"("sourceId", "canonicalUrl");
CREATE INDEX "KnowledgeDocument_technologySlug_status_idx" ON "KnowledgeDocument"("technologySlug", "status");
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_documentId_versionNumber_key" ON "KnowledgeDocumentVersion"("documentId", "versionNumber");
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_documentId_contentHash_key" ON "KnowledgeDocumentVersion"("documentId", "contentHash");
CREATE UNIQUE INDEX "KnowledgeChunk_documentVersionId_ordinal_key" ON "KnowledgeChunk"("documentVersionId", "ordinal");
CREATE INDEX "KnowledgeChunk_technologySlug_idx" ON "KnowledgeChunk"("technologySlug");
CREATE INDEX "KnowledgeChunk_tsv_idx" ON "KnowledgeChunk" USING GIN ("tsv");
CREATE UNIQUE INDEX "KnowledgeIngestionRun_jobId_key" ON "KnowledgeIngestionRun"("jobId");
CREATE INDEX "KnowledgeIngestionRun_sourceId_createdAt_idx" ON "KnowledgeIngestionRun"("sourceId", "createdAt");
CREATE INDEX "KnowledgeIngestionRun_status_heartbeatAt_idx" ON "KnowledgeIngestionRun"("status", "heartbeatAt");
-- At most ONE active ingestion per source, enforced by the database (retry-safe enqueue).
CREATE UNIQUE INDEX "KnowledgeIngestionRun_one_active_per_source" ON "KnowledgeIngestionRun"("sourceId") WHERE "status" IN ('PENDING','RUNNING');
CREATE INDEX "KnowledgeRetrievalRun_projectId_createdAt_idx" ON "KnowledgeRetrievalRun"("projectId", "createdAt");
CREATE INDEX "KnowledgeCitation_projectId_createdAt_idx" ON "KnowledgeCitation"("projectId", "createdAt");
CREATE INDEX "KnowledgeCitation_messageId_idx" ON "KnowledgeCitation"("messageId");

ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "KnowledgeDocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeIngestionRun" ADD CONSTRAINT "KnowledgeIngestionRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeCitation" ADD CONSTRAINT "KnowledgeCitation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A document version's content never changes; it can only be superseded.
CREATE FUNCTION "p2p_guard_knowledge_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."contentHash" IS DISTINCT FROM OLD."contentHash" OR NEW."title" IS DISTINCT FROM OLD."title" OR NEW."documentId" IS DISTINCT FROM OLD."documentId"
     OR NEW."versionNumber" IS DISTINCT FROM OLD."versionNumber" OR NEW."retrievedAt" IS DISTINCT FROM OLD."retrievedAt" THEN
    RAISE EXCEPTION 'KnowledgeDocumentVersion content is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "p2p_knowledge_version_immutable" BEFORE UPDATE ON "KnowledgeDocumentVersion" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_knowledge_version"();
-- Citations are snapshots: append-only.
CREATE FUNCTION "p2p_guard_citation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'KnowledgeCitation is append-only' USING ERRCODE = 'check_violation'; END $$;
CREATE TRIGGER "p2p_citation_append_only" BEFORE UPDATE ON "KnowledgeCitation" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_citation"();
