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
