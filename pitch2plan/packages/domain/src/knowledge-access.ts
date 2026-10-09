import { docTechnologiesFor, techDocsFor, type CitationDto, type DocumentationRef, type KnowledgeAvailability, type KnowledgeContext } from '@pitch2plan/schemas';
import { requireProjectAccess } from './authorization';
import type { RequestContext } from './discovery';
import { DomainError } from './errors';
import type { IngestionService } from './knowledge';
import type { KnowledgeRetriever } from './knowledge-retrieval';
import { nodeVersion } from './assistant';
import type { Repositories } from './ports';

export interface DocsResult {
  availability: KnowledgeAvailability | 'NONE';
  technologies: Array<{ slug: string; name: string; availability: KnowledgeAvailability }>;
  documents: Array<DocumentationRef & { matched: boolean }>;
  /** True when the list is general reference for the technology rather than a match for the task/component. */
  generalReference: boolean;
}

interface NodeLike { stableKey: string; name: string; technology: string; technologySlug: string; provider: string | null; managedService: boolean; deploymentModel: string; configuration: Array<{ key: string; value: string }> }

/**
 * Project-scoped and public-registry documentation queries. Every project-scoped call is authorized against the caller's workspace;
 * a task, component or citation of another workspace answers "not found", never "forbidden".
 */
export function createKnowledgeAccessService(deps: { repos: Repositories; ingestion: IngestionService; retriever: KnowledgeRetriever }) {
  const { repos, ingestion, retriever } = deps;

  const aggregate = (m: Record<string, KnowledgeAvailability>): DocsResult['availability'] => {
    const v = Object.values(m);
    return !v.length ? 'NONE' : v.includes('READY') ? 'READY' : v.includes('PREPARING') ? 'PREPARING' : v.every((x) => x === 'NOT_COVERED') ? 'NOT_COVERED' : 'UNAVAILABLE';
  };

  async function build(nodes: NodeLike[], ctxExtra: { question?: string; taskTitle?: string; stepTitle?: string }): Promise<DocsResult> {
    const technologies = nodes.flatMap((n) => docTechnologiesFor(n).map((slug) => ({ slug, provider: n.provider, version: nodeVersion(n.configuration), managedService: n.managedService, deploymentModel: n.deploymentModel, name: n.technology })));
    if (!technologies.length) return { availability: 'NONE', technologies: [], documents: [], generalReference: false };
    const slugs = [...new Set(technologies.map((t) => t.slug))];
    const av = await ingestion.ensureIndexed(slugs);
    const kctx: KnowledgeContext = { question: ctxExtra.question ?? '', technologies, taskTitle: ctxExtra.taskTitle, stepTitle: ctxExtra.stepTitle, componentName: nodes[0]?.name };
    const { documents } = await retriever.documentsFor(kctx, 4);
    return {
      availability: aggregate(av), technologies: slugs.map((slug) => ({ slug, name: techDocsFor(slug)?.displayName ?? slug, availability: av[slug] ?? 'UNAVAILABLE' })),
      documents, generalReference: documents.length > 0 && documents.every((d) => !d.matched),
    };
  }

  return {
    /** Registry-level documentation for one technology (any signed-in user; no project data involved). */
    async docsForTechnology(slug: string): Promise<DocsResult> {
      const tech = techDocsFor(slug);
      if (!tech) return { availability: 'NOT_COVERED', technologies: [{ slug, name: slug, availability: 'NOT_COVERED' }], documents: [], generalReference: false };
      const av = await ingestion.ensureIndexed([slug]);
      const rows = await repos.knowledge.listDocuments([slug], 12);
      const documents = await retriever.documentsFor({ question: tech.displayName, technologies: [{ slug }] }, 12).then((r) => r.documents.length ? r.documents : rows.map((d) => ({ title: d.title, url: d.url, sourceTitle: d.sourceTitle, sourceType: d.sourceType, technologySlug: d.technologySlug, provider: d.provider, version: d.productVersion, sectionTitle: null, retrievedAt: d.checkedAt.toISOString(), stale: false, matched: false })));
      return { availability: av[slug] ?? 'UNAVAILABLE', technologies: [{ slug, name: tech.displayName, availability: av[slug] ?? 'UNAVAILABLE' }], documents, generalReference: true };
    },

    async docsForComponent(ctx: RequestContext, projectId: string, stableKey: string): Promise<DocsResult> {
      const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
      const record = await repos.architecture.getByProject(project.id);
      const arch = record?.currentVersionId ? await repos.architecture.getVersion(record.currentVersionId) : null;
      const node = arch?.nodes.find((n: NodeLike) => n.stableKey === stableKey);
      if (!node) throw new DomainError('NODE_NOT_FOUND', 'Component not found in this project.');
      return build([node], { question: `${node.name} ${node.technology}` });
    },

    async docsForTask(ctx: RequestContext, taskId: string, stepId?: string): Promise<DocsResult> {
      const task = await repos.implementation.getTask(taskId);
      if (!task) throw new DomainError('TASK_NOT_FOUND', 'Task not found.');
      try { await requireProjectAccess(repos, ctx.userId, task.projectId, 'read'); }
      catch (e) { if (e instanceof DomainError && e.code === 'PROJECT_NOT_FOUND') throw new DomainError('TASK_NOT_FOUND', 'Task not found.'); throw e; }
      const plan = (await repos.implementation.getVersion(task.planVersionId))!;
      const arch = (await repos.architecture.getVersion(plan.architectureVersionId))!;
      const step = stepId ? task.steps.find((s) => s.id === stepId) : undefined;
      return build(arch.nodes.filter((n: NodeLike) => task.componentKeys.includes(n.stableKey)), { question: [step?.title, task.title].filter(Boolean).join(' '), taskTitle: task.title, stepTitle: step?.title });
    },

    /** Searches indexed documentation for a question, optionally narrowed to a technology. Returns real chunks that passed the relevance gate. */
    async search(ctx: RequestContext, input: { query: string; technologySlug?: string; projectId?: string }): Promise<{ results: CitationDto[]; availability: KnowledgeAvailability | 'NONE' }> {
      if (input.projectId) await requireProjectAccess(repos, ctx.userId, input.projectId, 'read');
      const slug = input.technologySlug;
      if (!slug) return { results: [], availability: 'NONE' };
      if (!techDocsFor(slug)) return { results: [], availability: 'NOT_COVERED' };
      const av = await ingestion.ensureIndexed([slug]);
      const r = await retriever.retrieve({ question: input.query, technologies: [{ slug }] });
      return { results: r.citations.map((c) => ({ id: '', n: c.n, title: c.title, url: c.url, sourceTitle: c.sourceTitle, sourceType: c.sourceType, technologySlug: c.technologySlug, provider: c.provider, version: c.version, sectionTitle: c.sectionTitle, retrievedAt: c.retrievedAt, stale: c.stale, excerpt: c.excerpt })), availability: av[slug] ?? 'UNAVAILABLE' };
    },

    /** The source inspector: the stored snapshot of what was cited, visible only to members of the project the answer belongs to. */
    async getCitation(ctx: RequestContext, citationId: string): Promise<CitationDto & { fullText: string | null }> {
      const rec = await repos.knowledge.getCitation(citationId);
      if (!rec) throw new DomainError('CITATION_NOT_FOUND', 'Citation not found.');
      try { await requireProjectAccess(repos, ctx.userId, rec.projectId, 'read'); }
      catch (e) { if (e instanceof DomainError && (e.code === 'PROJECT_NOT_FOUND' || e.code === 'FORBIDDEN')) throw new DomainError('CITATION_NOT_FOUND', 'Citation not found.'); throw e; }
      const s = rec.snapshot as Partial<CitationDto>;
      return {
        id: rec.id, n: rec.n, title: String(s.title ?? ''), url: String(s.url ?? ''), sourceTitle: String(s.sourceTitle ?? ''), sourceType: s.sourceType as CitationDto['sourceType'], technologySlug: String(s.technologySlug ?? ''),
        provider: String(s.provider ?? ''), version: (s.version as string | null) ?? null, sectionTitle: (s.sectionTitle as string | null) ?? null, retrievedAt: String(s.retrievedAt ?? ''), stale: Boolean(s.stale), excerpt: String(s.excerpt ?? ''),
        fullText: (await repos.knowledge.getChunk(rec.chunkId))?.text ?? null,
      };
    },

    async refresh(ctx: RequestContext, slug: string) {
      if (!techDocsFor(slug)) throw new DomainError('SOURCE_NOT_FOUND', 'No documentation source exists for this technology.');
      return ingestion.refreshSource(slug, ctx.userId);
    },
    async status() { return repos.knowledge.overview(); },
  };
}
export type KnowledgeAccessService = ReturnType<typeof createKnowledgeAccessService>;
