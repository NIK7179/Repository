import type { ArchitectureService, AssistantService, BriefView, DiscoveryState, ImplementationService } from '@pitch2plan/domain';
import type { ApiErrorBody, ApiSuccessBody, IdeaInterpretation, ProjectStatus, TechnicalLevel } from '@pitch2plan/schemas';

export interface ProjectDto { id: string; workspaceId: string; name: string; description: string | null; status: ProjectStatus; createdAt: string; updatedAt: string }
export interface PitchDto { id: string; projectId: string; version: number; content: string; technicalLevel: TechnicalLevel | null; createdAt: string }
export interface InterpretationDto { id: string; projectId: string; pitchId: string; promptId: string; promptVersion: number; provider: string; model: string; output: IdeaInterpretation; createdAt: string }

export class ApiError extends Error {
  constructor(public code: string, message: string, public requestId?: string, public status?: number) { super(message); }
}

export async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? 'GET', credentials: 'same-origin',
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch { throw new ApiError('NETWORK_ERROR', 'Could not reach the server. Check your connection and try again.'); }
  let json: ApiSuccessBody<T> | ApiErrorBody | null = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || !json || 'error' in json) {
    const err = json && 'error' in json ? json.error : null;
    if (res.status === 401 && typeof window !== 'undefined') window.location.assign('/sign-in');
    throw new ApiError(err?.code ?? 'INTERNAL_ERROR', err?.message ?? `Request failed (${res.status}).`, err?.requestId, res.status);
  }
  return json.data;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const units: Array<[number, string]> = [[60, 'min'], [24, 'hour'], [30, 'day'], [12, 'month']];
  let v = s / 60;
  for (let i = 0; i < units.length; i++) {
    const [div, label] = units[i]!;
    if (v < div || i === units.length - 1) { const n = Math.floor(v); return `${n} ${label}${n === 1 ? '' : 's'} ago`; }
    v /= div;
  }
  return '';
}

/** Server records as they look after JSON serialisation (Dates become ISO strings). */
export type Json<T> = T extends Date ? string : T extends readonly (infer U)[] ? Json<U>[] : T extends object ? { [K in keyof T]: Json<T[K]> } : T;
export type DiscoveryStateDto = Json<DiscoveryState>;
export type BriefViewDto = Json<BriefView>;
export type RequirementDto = DiscoveryStateDto['requirements'][number];
export type RoundDto = DiscoveryStateDto['rounds'][number];
export type QuestionDto = RoundDto['questions'][number];
export type ConflictDto = DiscoveryStateDto['conflicts'][number];

export type ArchitectureOverviewDto = Json<Awaited<ReturnType<ArchitectureService['getOverview']>>>;
export type NodeInspectorDto = Json<Awaited<ReturnType<ArchitectureService['getNode']>>>;
export type RunDto = NonNullable<ArchitectureOverviewDto['run']>;
export type DecisionDto = NonNullable<ArchitectureOverviewDto['current']>['decisions'][number];

export type ImplementationOverviewDto = Json<Awaited<ReturnType<ImplementationService['getOverview']>>>;
export type PlanDto = NonNullable<ImplementationOverviewDto['plan']>;
export type PlanTaskDto = PlanDto['tasks'][number];
export type PlanPhaseDto = PlanDto['phases'][number];
export type TaskDetailDto = Json<Awaited<ReturnType<ImplementationService['getTask']>>>;
export type ComponentWorkspaceDto = Json<Awaited<ReturnType<ImplementationService['getComponent']>>>;
export type ConversationDto = Json<Awaited<ReturnType<AssistantService['getConversation']>>>;
export type MessageDto = ConversationDto['messages'][number];

import type { ChangeService } from '@pitch2plan/domain';
export type ProposalViewDto = Json<Awaited<ReturnType<ChangeService['get']>>>;
export type ProposalListItemDto = Json<Awaited<ReturnType<ChangeService['list']>>>[number];
export type VersionHistoryDto = Json<Awaited<ReturnType<ChangeService['versionHistory']>>>;
export type ArchitectureDiffDto = Json<Awaited<ReturnType<ChangeService['getDiff']>>>;
export type PlanDiffDto = Json<Awaited<ReturnType<ChangeService['planDiff']>>>;
export type ReviewDto = NonNullable<Json<Awaited<ReturnType<ChangeService['latestReview']>>>>;
export type FailureImpactDto = Json<Awaited<ReturnType<ChangeService['failureImpact']>>>;

import type { KnowledgeAccessService } from '@pitch2plan/domain';
export type DocsDto = Json<Awaited<ReturnType<KnowledgeAccessService['docsForComponent']>>>;
export type DocumentRefDto = DocsDto['documents'][number];
export type CitationDetailDto = Json<Awaited<ReturnType<KnowledgeAccessService['getCitation']>>>;
export type KnowledgeSearchDto = Json<Awaited<ReturnType<KnowledgeAccessService['search']>>>;
