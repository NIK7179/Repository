import type {
  CreateProjectRequest, InterpretRequest, SubmitPitchRequest,
} from '@pitch2plan/schemas';
import { canWrite, requireProjectAccess } from './authorization';
import { DomainError } from './errors';
import type { Logger } from './logger';
import type { ArchitectureAiPort, AssistantAiPort, ChangeAiPort, DiscoveryAiPort, ImplementationAiPort, ExternalIdentity, IdeaInterpreterPort, JobQueue, Repositories } from './ports';
import { createArchitectureService, DEFAULT_ARCHITECTURE_CONFIG, type ArchitectureConfig } from './architecture';
import { createAssistantService } from './assistant';
import { createChangeService, DEFAULT_CHANGE_CONFIG, type ChangeConfig } from './change';
import { createImplementationService, DEFAULT_IMPLEMENTATION_CONFIG, type ImplementationConfig } from './implementation';
import { createBriefService } from './brief';
import { createDiscoveryService, type RequestContext } from './discovery';
import { DEFAULT_DISCOVERY_CONFIG, type DiscoveryConfig } from './shared';

export type { RequestContext };
export interface ApplicationDeps {
  repos: Repositories; interpreter: IdeaInterpreterPort; discoveryAi: DiscoveryAiPort; architectureAi: ArchitectureAiPort; implementationAi: ImplementationAiPort; assistantAi: AssistantAiPort; changeAi: ChangeAiPort; queue: JobQueue; logger: Logger;
  discoveryConfig?: Partial<DiscoveryConfig>; architectureConfig?: Partial<ArchitectureConfig>; implementationConfig?: Partial<ImplementationConfig>; changeConfig?: Partial<ChangeConfig>;
}

function isAiError(e: unknown): e is { code: string; message: string; details?: unknown } {
  return !!e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' && (e as { code: string }).code.startsWith('AI_');
}

export function createApplication({ repos, interpreter, discoveryAi, architectureAi, implementationAi, assistantAi, changeAi, queue, logger, discoveryConfig, architectureConfig, implementationConfig, changeConfig }: ApplicationDeps) {
  const config: DiscoveryConfig = { ...DEFAULT_DISCOVERY_CONFIG, ...discoveryConfig };
  const discovery = createDiscoveryService({ repos, ai: discoveryAi, logger, config });
  const briefs = createBriefService({ repos, ai: discoveryAi, logger, discovery });
  const audit = (ctx: RequestContext, workspaceId: string, action: string, extra: { projectId?: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> } = {}) =>
    repos.audit.record({ workspaceId, actorId: ctx.userId, action, requestId: ctx.requestId, ...extra });

  const architecture = createArchitectureService({ repos, ai: architectureAi, queue, logger, config: { ...DEFAULT_ARCHITECTURE_CONFIG, ...architectureConfig } });

  const implementation = createImplementationService({ repos, ai: implementationAi, queue, logger, config: { ...DEFAULT_IMPLEMENTATION_CONFIG, ...implementationConfig } });
  const assistant = createAssistantService({ repos, ai: assistantAi, logger });
  const change = createChangeService({ repos, ai: changeAi, architectureAi, implementation, queue, logger, config: { ...DEFAULT_CHANGE_CONFIG, ...changeConfig } });

  return {
    discovery,
    briefs,
    architecture,
    implementation,
    assistant,
    change,
    config,
    users: {
      provision: (identity: ExternalIdentity) => repos.users.provision(identity),
      findById: (id: string) => repos.users.findById(id),
    },

    projects: {
      async create(ctx: RequestContext, input: CreateProjectRequest) {
        const memberships = await repos.workspaces.listMemberships(ctx.userId);
        const target = input.workspaceId
          ? memberships.find((m) => m.workspaceId === input.workspaceId)
          : (memberships.find((m) => m.workspace.isPersonal && m.role === 'OWNER') ?? memberships.find((m) => canWrite(m.role)));
        // A workspace id from the browser is only honoured if the caller is a writer in it.
        if (!target || !canWrite(target.role)) throw new DomainError('FORBIDDEN', 'You cannot create projects in this workspace.');
        const project = await repos.projects.create({
          workspaceId: target.workspaceId, createdById: ctx.userId, name: input.name, description: input.description,
        });
        await audit(ctx, project.workspaceId, 'project.created', { projectId: project.id, entityType: 'Project', entityId: project.id });
        return project;
      },

      async list(ctx: RequestContext) {
        const memberships = await repos.workspaces.listMemberships(ctx.userId);
        return repos.projects.listForWorkspaces(memberships.map((m) => m.workspaceId));
      },

      async get(ctx: RequestContext, projectId: string) {
        const { project, role } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
        const latestPitch = await repos.pitches.latest(project.id);
        return { project, latestPitch, role };
      },

      async softDelete(ctx: RequestContext, projectId: string) {
        const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'manage');
        await repos.projects.softDelete(project.id);
        await audit(ctx, project.workspaceId, 'project.deleted', { projectId: project.id, entityType: 'Project', entityId: project.id });
      },
    },

    pitches: {
      async submit(ctx: RequestContext, projectId: string, input: SubmitPitchRequest) {
        const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
        const pitch = await repos.pitches.append({
          projectId: project.id, authorId: ctx.userId, content: input.content, technicalLevel: input.technicalLevel,
        });
        await repos.projects.touch(project.id);
        await audit(ctx, project.workspaceId, 'pitch.submitted', {
          projectId: project.id, entityType: 'IdeaPitch', entityId: pitch.id, metadata: { version: pitch.version },
        });
        return pitch;
      },
    },

    interpretation: {
      async interpret(ctx: RequestContext, projectId: string, input: InterpretRequest) {
        const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'write');
        const pitch = input.pitchId ? await repos.pitches.findById(input.pitchId) : await repos.pitches.latest(project.id);
        if (input.pitchId && (!pitch || pitch.projectId !== project.id)) throw new DomainError('PITCH_NOT_FOUND', 'Pitch not found for this project.');
        if (!pitch) throw new DomainError('NO_PITCH', 'Submit an idea pitch before requesting an interpretation.');

        let result;
        try {
          result = await interpreter.interpret({
            projectId: project.id, workspaceId: project.workspaceId, userId: ctx.userId,
            pitch: pitch.content, technicalLevel: input.technicalLevel ?? pitch.technicalLevel ?? undefined,
          });
        } catch (e) {
          if (isAiError(e)) {
            logger.warn({ requestId: ctx.requestId, projectId, errorCode: e.code }, 'idea interpretation failed');
            throw new DomainError(e.code as 'AI_OUTPUT_INVALID', e.message, e.details);
          }
          throw e;
        }
        // Only validated output reaches this point; malformed output is never persisted.
        const record = await repos.interpretations.create({
          projectId: project.id, pitchId: pitch.id, promptId: result.promptId, promptVersion: result.promptVersion,
          provider: result.provider, model: result.model, output: result.output,
        });
        await repos.projects.touch(project.id);
        await audit(ctx, project.workspaceId, 'idea.interpreted', {
          projectId: project.id, entityType: 'IdeaInterpretation', entityId: record.id,
          metadata: { promptId: result.promptId, promptVersion: result.promptVersion, pitchVersion: pitch.version },
        });
        return record;
      },

      async getLatest(ctx: RequestContext, projectId: string) {
        const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');
        const record = await repos.interpretations.latest(project.id);
        if (!record) throw new DomainError('INTERPRETATION_NOT_FOUND', 'This project has not been interpreted yet.');
        return record;
      },
    },
  };
}
export type Application = ReturnType<typeof createApplication>;
