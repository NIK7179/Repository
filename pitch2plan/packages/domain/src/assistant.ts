import {
  STRUCTURED_DELIMITER, DelimiterSplitter, assistantExtrasSchema, classifyCommand, type AskArchitectRequest, type AssistantMessageContent, type ConversationScope,
} from '@pitch2plan/schemas';
import { requireProjectAccess } from './authorization';
import { buildAssistantContext, type TaskLite } from './assistant-context';
import type { RequestContext } from './discovery';
import { DomainError } from './errors';
import { buildPlanView } from './implementation';
import { loadProjectKnowledge, type ProjectKnowledge } from './implementation-context';
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

export function createAssistantService(deps: { repos: Repositories; ai: AssistantAiPort; logger: Logger }) {
  const { repos, ai, logger } = deps;
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

  function finalize(raw: string | null, answer: string, tail: string, taskIds: Map<string, string>): { content: AssistantMessageContent } {
    const notices: string[] = [];
    let extras = assistantExtrasSchema.parse({});
    if (raw) {
      try { const parsed = assistantExtrasSchema.safeParse(JSON.parse(raw.replace(/^```(?:json)?|```$/gm, '').trim())); if (parsed.success) extras = parsed.data; else notices.push(NOTICES.structured); } catch { notices.push(NOTICES.structured); }
    } else notices.push(NOTICES.structured);
    // Risk is decided HERE, by deterministic rules. Whatever the model claims about safety is ignored.
    const commands = extras.commands.map((c) => { const r = classifyCommand(c.command); return { command: c.command, purpose: c.purpose, risk: r.risk, reasons: r.reasons }; });
    if (commands.some((c) => c.risk === 'DESTRUCTIVE')) notices.push(NOTICES.destructive); else if (commands.some((c) => c.risk === 'MUTATING')) notices.push(NOTICES.mutating);
    if (extras.codeBlocks.length) notices.push(NOTICES.code);
    if (extras.needsArchitectureChange) notices.push(NOTICES.change);
    const relatedTasks = extras.relatedTaskIds.filter((id) => taskIds.has(id)).map((id) => ({ id, title: taskIds.get(id)! }));
    return { content: { answer: (answer + tail).trim(), warnings: extras.warnings, commands, codeBlocks: extras.codeBlocks, validationSteps: extras.validationSteps, relatedTasks, architectureImpact: extras.architectureImpact, needsArchitectureChange: extras.needsArchitectureChange, notices } };
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

      const splitter = new DelimiterSplitter(); let streamed = ''; const started = Date.now();
      try {
        for await (const ev of ai.stream({ context: { workspaceId: project.workspaceId, projectId: project.id, userId: ctx.userId }, projectContext: built.context, history, question: input.message, signal })) {
          if (signal?.aborted) return; // the client went away: nothing is stored
          if (ev.type === 'delta') { const text = splitter.push(ev.text); if (text) { streamed += text; yield { type: 'delta', text }; } continue; }
          const rest = splitter.finish();
          if (rest.tail) { streamed += rest.tail; yield { type: 'delta', text: rest.tail }; }
          if (!streamed.trim()) throw Object.assign(new Error('empty'), { code: 'EMPTY_ANSWER' });
          const { content } = finalize(rest.structured, streamed, '', new Map(tasks.map((t) => [t.id, t.title])));
          const stored = await repos.conversations.addMessage({ conversationId: conversation.id, role: 'ASSISTANT', content: content.answer, structured: content, contextRefs: built.refs });
          await repos.analytics.record({ workspaceId: project.workspaceId, projectId: project.id, userId: ctx.userId, name: 'assistant_answered', properties: { scope: input.scope, contextChars: built.stats.chars, commands: content.commands.length, needsArchitectureChange: content.needsArchitectureChange, durationMs: Date.now() - started } }).catch(() => undefined);
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
