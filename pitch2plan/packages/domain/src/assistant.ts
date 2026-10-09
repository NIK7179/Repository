import { randomUUID } from 'node:crypto';
import {
  STRUCTURED_DELIMITER, DelimiterSplitter, assistantExtrasSchema, citationSupportsClaim, classifyCommand, deriveGrounding, docTechnologiesFor, inspectCommand, renderDocuments, stripInvalidMarkers,
  validateClaims, versionNoteText, type AskArchitectRequest, type AssistantMessageContent, type CitationDraft, type CitationDto, type ConversationScope, type KnowledgeContext,
  type MessageGrounding, type VersionNote,
} from '@pitch2plan/schemas';
import { requireProjectAccess } from './authorization';
import { buildAssistantContext, type TaskLite } from './assistant-context';
import type { RequestContext } from './discovery';
import { DomainError } from './errors';
import { buildPlanView } from './implementation';
import { loadProjectKnowledge, type ProjectKnowledge } from './implementation-context';
import type { RetrievalResult, KnowledgeRetriever } from './knowledge-retrieval';
import type { IngestionService } from './knowledge';
import type { Logger } from './logger';
import type { AssistantAiPort, MessageRecord, Repositories } from './ports';
import { isAiError } from './shared';

export type AssistantEvent =
  | { type: 'start'; conversationId: string; userMessageId: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; message: MessageRecord }
  | { type: 'error'; code: string; message: string };

const SAFE_ERRORS: Record<string, string> = {
  AI_TIMEOUT: 'The assistant took too long to answer. Your question is saved; try again.',
  AI_PROVIDER_ERROR: 'The assistant is temporarily unavailable. Your question is saved; try again.',
  EMPTY_ANSWER: 'The assistant did not produce an answer. Try rephrasing, or try again.',
};
const NOTICES = {
  destructive: 'Some commands below are DESTRUCTIVE. Pitch2Plan never runs commands. Read each one carefully and run only what you understand, ideally in a non-production environment first.',
  mutating: 'Some commands below change state. Pitch2Plan never runs commands for you.',
  code: 'Generated code is a starting point. Review before use: check it against your versions, credentials handling and security requirements.',
  change: 'This would change an architecture decision. Architecture changes are not available in Pitch2Plan yet, so nothing was changed. The architecture shown remains the source of truth.',
  structured: 'Extra details (commands, warnings) could not be read for this answer, so only the text answer is shown.',
};

export interface AssistantKnowledge { ensureIndexed: IngestionService['ensureIndexed']; retriever: KnowledgeRetriever }

/** The version an architecture node pins, from its configuration (e.g. "engine_version: 16"). Nothing is guessed when it is absent. */
export function nodeVersion(configuration: Array<{ key: string; value: string }>): string | null {
  const hit = configuration.find((c) => /version/i.test(c.key) && /\d/.test(c.value));
  return hit ? hit.value : null;
}

interface GroundingEnv {
  retrieval: RetrievalResult | null; availability: MessageGrounding['availability']; projectRefs: Set<string>; requestedVersion: string | null; identity: string[];
}

export function createAssistantService(deps: { repos: Repositories; ai: AssistantAiPort; logger: Logger; knowledge?: AssistantKnowledge }) {
  const { repos, ai, logger, knowledge } = deps;
  const lite = (k: ProjectKnowledge): TaskLite[] => (k.plan?.tasks ?? []).map((t) => ({
    id: t.id, key: t.key, title: t.title, status: t.status, taskType: t.taskType, phaseName: k.plan!.phases.find((p) => p.id === t.phaseId)?.name ?? '', dependsOn: t.dependsOn, componentKeys: t.componentKeys, decisionKeys: t.decisionKeys,
    objective: t.objective, instructions: t.instructions, expectedOutcome: t.expectedOutcome, validationSteps: t.validationSteps, securityNotes: t.securityNotes, commonProblems: t.commonProblems,
    steps: t.steps.map((s) => ({ id: s.id, sequence: s.sequence, title: s.title, instruction: s.instruction, expectedResult: s.expectedResult, validation: s.validation, status: s.status })),
  }));

  /** Every scope is authorized against the project the caller is acting in: a task or component of another workspace can never be addressed. */
  async function resolveScope(k: ProjectKnowledge, input: AskArchitectRequest): Promise<{ scopeId: string; stepId?: string }> {
    if (input.scope === 'PROJECT') return { scopeId: input.projectId };
    if (!input.scopeId) throw new DomainError('VALIDATION_ERROR', 'A scopeId is required for this scope.');
    if (input.scope === 'COMPONENT') {
      if (!k.architecture.nodes.some((n) => n.stableKey === input.scopeId)) throw new DomainError('NODE_NOT_FOUND', 'Component not found in this project.');
      return { scopeId: input.scopeId };
    }
    const task = k.plan?.tasks.find((t) => t.id === input.scopeId);
    if (!task) throw new DomainError('TASK_NOT_FOUND', 'Task not found in this project.');
    if (input.stepId && !task.steps.some((s) => s.id === input.stepId)) throw new DomainError('TASK_NOT_FOUND', 'Step not found in this task.');
    return { scopeId: input.scopeId, stepId: input.stepId };
  }

  /**
   * Everything the reader will trust is decided here. The model's claims, citation numbers and labels are proposals: a number that was not
   * retrieved, or whose passage does not support the statement, is dropped, and the label is downgraded to UNVERIFIED. The status is derived, never read.
   */
  function finalize(raw: string | null, answer: string, tail: string, taskIds: Map<string, string>, env: GroundingEnv): { content: AssistantMessageContent; used: CitationDraft[] } {
    const notices: string[] = [];
    let extras = assistantExtrasSchema.parse({});
    if (raw) {
      try { const parsed = assistantExtrasSchema.safeParse(JSON.parse(raw.replace(/^```(?:json)?|```$/gm, '').trim())); if (parsed.success) extras = parsed.data; else notices.push(NOTICES.structured); } catch { notices.push(NOTICES.structured); }
    } else notices.push(NOTICES.structured);

    const retrieved = env.retrieval?.citations ?? [];
    const sources = retrieved.map((c) => ({ n: c.n, title: c.title, text: env.retrieval!.texts.get(c.chunkId) ?? c.excerpt }));
    const bySource = new Map(sources.map((x) => [x.n, x]));
    const supported = (text: string, nums: number[]) => [...new Set(nums)].filter((n) => { const x = bySource.get(n); return !!x && citationSupportsClaim(text, `${x.title} ${x.text}`, env.identity); });

    const claims = validateClaims({ claims: extras.claims, sources, projectRefs: env.projectRefs, identityTerms: env.identity });
    // Risk is decided HERE, by deterministic rules. Whatever the model claims about safety is ignored.
    const commands = extras.commands.map((c) => {
      const r = classifyCommand(c.command); const cites = supported(`${c.purpose} ${c.command}`, c.citations); const insp = inspectCommand(c.command);
      const assumptions = [...new Set([...c.assumptions, ...insp.placeholders.map((p) => `Replace ${p} with your own value.`)])].slice(0, 8);
      return { command: c.command, purpose: c.purpose, risk: r.risk, reasons: r.reasons, citations: cites, placeholders: insp.placeholders, assumptions, documented: cites.length > 0 };
    });
    const codeBlocks = extras.codeBlocks.map((b) => ({ ...b, citations: supported(`${b.purpose} ${b.filename ?? ''}`, b.citations) }));
    if (commands.some((c) => c.risk === 'DESTRUCTIVE')) notices.push(NOTICES.destructive); else if (commands.some((c) => c.risk === 'MUTATING')) notices.push(NOTICES.mutating);
    if (codeBlocks.length) notices.push(NOTICES.code);
    if (extras.needsArchitectureChange) notices.push(NOTICES.change);

    const usedNumbers = new Set<number>([...claims.flatMap((c) => c.citations), ...commands.flatMap((c) => c.citations), ...codeBlocks.flatMap((b) => b.citations)]);
    const uncited = commands.filter((c) => !c.documented && c.risk !== 'READ_ONLY').length + codeBlocks.filter((b) => !b.citations.length).length;
    const versionMatch: VersionNote | 'NONE' = env.retrieval?.stats.versionMatch ?? 'NONE';
    const derived = deriveGrounding({ claims, retrievedCount: retrieved.length, uncitedCommands: uncited, versionMatch });
    const reasons = [...derived.reasons];
    if (!retrieved.length) {
      if (env.availability === 'PREPARING') reasons.push('Official documentation for this technology is still being prepared; ask again in a moment.');
      else if (env.availability === 'UNAVAILABLE') reasons.push('Official documentation could not be loaded right now.');
      else if (env.availability === 'NOT_COVERED') reasons.push('Official documentation for this technology is not in the knowledge base yet.');
    }
    const used: CitationDraft[] = retrieved.filter((c) => usedNumbers.has(c.n)).map((c) => ({ ...c, id: randomUUID() }));
    const dto: CitationDto[] = used.map((c) => ({ id: c.id, n: c.n, title: c.title, url: c.url, sourceTitle: c.sourceTitle, sourceType: c.sourceType, technologySlug: c.technologySlug, provider: c.provider, version: c.version, sectionTitle: c.sectionTitle, retrievedAt: c.retrievedAt, stale: c.stale, excerpt: c.excerpt }));
    const vnote = used.length ? versionNoteText(versionMatch, env.requestedVersion) : null;
    if (used.some((c) => c.stale)) reasons.push('Some documentation was last checked a while ago and may be out of date.');
    const grounding: MessageGrounding = { status: derived.status, reasons, versionNote: vnote, availability: env.availability, retrievedCount: retrieved.length };
    const relatedTasks = extras.relatedTaskIds.filter((id) => taskIds.has(id)).map((id) => ({ id, title: taskIds.get(id)! }));
    const text = stripInvalidMarkers((answer + tail).trim(), usedNumbers);
    return { used, content: { answer: text, warnings: extras.warnings, commands, codeBlocks, validationSteps: extras.validationSteps, relatedTasks, architectureImpact: extras.architectureImpact, needsArchitectureChange: extras.needsArchitectureChange, notices, grounding, claims, citations: dto } };
  }

  /** Which technologies does this question concern? Derived from the scope, never from the model. */
  function knowledgeContext(k: ProjectKnowledge, input: AskArchitectRequest, scopeId: string, question: string): KnowledgeContext {
    const nodes = k.architecture.nodes;
    const task = input.scope === 'TASK' ? k.plan?.tasks.find((t) => t.id === scopeId) : undefined;
    const step = task && input.stepId ? task.steps.find((s) => s.id === input.stepId) : undefined;
    let focus = input.scope === 'COMPONENT' ? nodes.filter((n) => n.stableKey === scopeId) : task ? nodes.filter((n) => task.componentKeys.includes(n.stableKey)) : [];
    if (input.scope === 'PROJECT') { const q = question.toLowerCase(); focus = nodes.filter((n) => q.includes(n.name.toLowerCase()) || q.includes(n.technology.toLowerCase()) || q.includes(n.technologySlug.replace(/-/g, ' '))); }
    const technologies = focus.flatMap((n) => docTechnologiesFor(n).map((slug) => ({ slug, provider: n.provider, version: nodeVersion(n.configuration), managedService: n.managedService, deploymentModel: n.deploymentModel, name: n.technology })));
    return { question, technologies, taskTitle: task?.title, stepTitle: step?.title, componentName: focus[0]?.name };
  }

  return {
    /**
     * Validation and authorization errors are thrown before the first event, so an HTTP layer can still answer with a normal error.
     * An assistant message is stored ONLY after a complete, valid answer. A provider error, timeout or disconnect stores nothing partial.
     */
    async *ask(ctx: RequestContext, input: AskArchitectRequest, signal?: AbortSignal): AsyncGenerator<AssistantEvent> {
      const { project } = await requireProjectAccess(repos, ctx.userId, input.projectId, 'write');
      const k = await loadProjectKnowledge(repos, project);
      const scope = await resolveScope(k, input);
      const conversation = await repos.conversations.getOrCreate({ projectId: project.id, scope: input.scope, scopeId: scope.scopeId, userId: ctx.userId });
      const prior = await repos.conversations.list(conversation.id, 12);
      const userMessage = (await repos.conversations.findMessageByClientId(conversation.id, input.clientMessageId))
        ?? await repos.conversations.addMessage({ conversationId: conversation.id, role: 'USER', content: input.message, clientMessageId: input.clientMessageId, userId: ctx.userId });
      yield { type: 'start', conversationId: conversation.id, userMessageId: userMessage.id };

      const tasks = lite(k);
      const planView = k.plan ? buildPlanView(k.plan, k.architecture) : null;
      const built = buildAssistantContext({
        project: { id: project.id, name: project.name }, brief: k.brief,
        requirements: k.requirements.filter((r) => r.status === 'ACTIVE').map((r) => ({ code: k.codebook.requirementCodeById[r.id]!, category: r.category, statement: r.statement, origin: r.origin })),
        drivers: k.drivers.filter((d) => k.codebook.driverCodeById[d.id]).map((d) => ({ code: k.codebook.driverCodeById[d.id]!, name: d.name, description: d.description, priority: d.priority, requirementCodes: d.requirementIds.map((id) => k.codebook.requirementCodeById[id]!).filter(Boolean) })),
        architecture: { versionNumber: k.architecture.versionNumber, summary: k.architecture.summary, nodes: k.architecture.nodes, edges: k.architecture.edges,
          decisions: k.architecture.decisions.map((d) => ({ key: d.key, title: d.title, status: d.status, decision: d.decision, rationale: d.rationale, tradeoffs: d.tradeoffs, nodeStableKeys: d.nodeStableKeys, driverCodes: d.driverIds.map((id) => k.codebook.driverCodeById[id]!).filter(Boolean), requirementCodes: d.requirementIds.map((id) => k.codebook.requirementCodeById[id]!).filter(Boolean) })) },
        plan: planView ? { progress: { percent: planView.progress.overall.percent, completed: planView.progress.overall.completed, applicable: planView.progress.overall.applicable }, tasks } : null,
        scope: { kind: input.scope as ConversationScope, scopeId: scope.scopeId, stepId: scope.stepId }, question: input.message,
        tail: prior.filter((m) => m.status === 'COMPLETE' && m.id !== userMessage.id).map((m) => ({ role: m.role === 'USER' ? 'USER' as const : 'ASSISTANT' as const, content: m.role === 'ASSISTANT' ? (m.structured?.answer ?? m.content) : m.content })),
      });
      const history = prior.filter((m) => m.status === 'COMPLETE' && m.id !== userMessage.id).slice(-6).map((m) => ({ role: m.role === 'USER' ? 'user' as const : 'assistant' as const, content: m.role === 'ASSISTANT' ? (m.structured?.answer ?? m.content) : m.content }));

      // Retrieval happens BEFORE generation and is scoped by the project's architecture. A failure here degrades to an ungrounded answer; it never blocks the user.
      const kctx = knowledgeContext(k, input, scope.scopeId, input.message);
      const env: GroundingEnv = {
        retrieval: null, availability: kctx.technologies.length ? 'UNAVAILABLE' : 'NONE', identity: [], requestedVersion: kctx.technologies.find((t) => t.version)?.version ?? null,
        projectRefs: new Set([...k.architecture.decisions.map((d) => d.key), ...Object.values(k.codebook.requirementCodeById), ...Object.values(k.codebook.driverCodeById), ...tasks.map((t) => t.key)]),
      };
      if (knowledge && kctx.technologies.length) {
        try {
          const slugs = [...new Set(kctx.technologies.map((t) => t.slug))];
          const av = await knowledge.ensureIndexed(slugs); const vals = Object.values(av);
          env.availability = vals.includes('READY') ? 'READY' : vals.includes('PREPARING') ? 'PREPARING' : vals.every((v) => v === 'NOT_COVERED') ? 'NOT_COVERED' : 'UNAVAILABLE';
          env.retrieval = await knowledge.retriever.retrieve(kctx);
          env.identity = env.retrieval.query.contextTerms;
        } catch (e) { logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'knowledge retrieval failed; answering without documentation'); env.retrieval = null; env.availability = 'UNAVAILABLE'; }
      }
      const documents = env.retrieval?.citations.length ? renderDocuments(env.retrieval.citations, env.retrieval.texts) : undefined;

      const splitter = new DelimiterSplitter(); let streamed = ''; const started = Date.now();
      try {
        for await (const ev of ai.stream({ context: { workspaceId: project.workspaceId, projectId: project.id, userId: ctx.userId }, projectContext: built.context, history, question: input.message, documents, signal })) {
          if (signal?.aborted) return; // the client went away: nothing is stored
          if (ev.type === 'delta') { const text = splitter.push(ev.text); if (text) { streamed += text; yield { type: 'delta', text }; } continue; }
          const rest = splitter.finish();
          if (rest.tail) { streamed += rest.tail; yield { type: 'delta', text: rest.tail }; }
          if (!streamed.trim()) throw Object.assign(new Error('empty'), { code: 'EMPTY_ANSWER' });
          const { content, used } = finalize(rest.structured, streamed, '', new Map(tasks.map((t) => [t.id, t.title])), env);
          // Citation snapshots are written BEFORE the message that references them, so a stored answer never points at a missing citation.
          if (used.length) await repos.knowledge.saveCitations(used.map((c) => ({ id: c.id, projectId: project.id, userId: ctx.userId, messageId: null, n: c.n, chunkId: c.chunkId, documentVersionId: c.documentVersionId, snapshot: { ...c } })));
          const stored = await repos.conversations.addMessage({ conversationId: conversation.id, role: 'ASSISTANT', content: content.answer, structured: content, contextRefs: built.refs });
          await repos.analytics.record({ workspaceId: project.workspaceId, projectId: project.id, userId: ctx.userId, name: 'assistant_answered', properties: { scope: input.scope, contextChars: built.stats.chars, commands: content.commands.length, needsArchitectureChange: content.needsArchitectureChange, grounding: content.grounding?.status ?? 'NONE', durationMs: Date.now() - started } }).catch(() => undefined);
          if (env.retrieval) await repos.knowledge.recordRetrieval({ projectId: project.id, userId: ctx.userId, scope: input.scope, technologySlugs: env.retrieval.query.technologySlugs, candidateCount: env.retrieval.stats.candidates, selectedCount: env.retrieval.stats.selected, durationMs: env.retrieval.stats.durationMs, technologyMatch: env.retrieval.stats.technologyMatch, versionMatch: env.retrieval.stats.versionMatch, groundingStatus: content.grounding!.status, citationCount: used.length }).catch(() => undefined);
          yield { type: 'done', message: stored };
          return;
        }
        throw Object.assign(new Error('empty'), { code: 'EMPTY_ANSWER' }); // the stream ended without a "done"
      } catch (e) {
        if (signal?.aborted) return;
        const code = isAiError(e) ? e.code : (e as { code?: string }).code === 'EMPTY_ANSWER' ? 'EMPTY_ANSWER' : 'INTERNAL_ERROR';
        if (code === 'INTERNAL_ERROR') logger.error({ err: e instanceof Error ? e.message : String(e) }, 'assistant failed');
        yield { type: 'error', code, message: SAFE_ERRORS[code] ?? 'The assistant could not answer. Your question is saved; try again.' };
      }
    },

    async getConversation(ctx: RequestContext, input: { projectId: string; scope: ConversationScope; scopeId?: string }) {
      const { project } = await requireProjectAccess(repos, ctx.userId, input.projectId, 'read');
      const scopeId = input.scope === 'PROJECT' ? project.id : input.scopeId ?? '';
      const c = await repos.conversations.find({ projectId: project.id, scope: input.scope, scopeId, userId: ctx.userId });
      return c ? { conversation: c, messages: await repos.conversations.list(c.id, 50) } : { conversation: null, messages: [] as MessageRecord[] };
    },

    async listMessages(ctx: RequestContext, conversationId: string, limit = 50) {
      const c = await repos.conversations.get(conversationId);
      if (!c || c.createdById !== ctx.userId) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation not found.');
      try { await requireProjectAccess(repos, ctx.userId, c.projectId, 'read'); } catch (e) { if (e instanceof DomainError && e.code === 'PROJECT_NOT_FOUND') throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation not found.'); throw e; }
      return { conversation: c, messages: await repos.conversations.list(conversationId, Math.min(limit, 100)) };
    },
  };
}
export type AssistantService = ReturnType<typeof createAssistantService>;
void STRUCTURED_DELIMITER;
