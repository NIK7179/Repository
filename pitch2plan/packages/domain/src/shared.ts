import { createHash } from 'node:crypto';
import type { RequirementSnapshot } from '@pitch2plan/schemas';
import { DomainError } from './errors';
import type { Logger } from './logger';
import type { ProjectRecord, RequirementRecord } from './ports';

export interface DiscoveryConfig { maxDiscoveryRounds: number; maxQuestionsPerRound: number }
export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = { maxDiscoveryRounds: 3, maxQuestionsPerRound: 6 };

export function isAiError(e: unknown): e is { code: string; message: string; details?: unknown } {
  return !!e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' && (e as { code: string }).code.startsWith('AI_');
}

/** Normalises provider/validation failures into DomainErrors so route handlers need no AI knowledge. */
export async function callAi<T>(logger: Logger, label: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (isAiError(e)) {
      logger.warn({ label, errorCode: e.code }, 'ai call failed');
      throw new DomainError(e.code as 'AI_OUTPUT_INVALID', e.message, e.details);
    }
    throw e;
  }
}

export const toSnapshot = (r: RequirementRecord): RequirementSnapshot => ({
  id: r.id, key: r.key, category: r.category, statement: r.statement, value: r.value, origin: r.origin,
  confidence: r.confidence, tags: r.tags, version: r.version,
});

/** Identifies exactly which requirement versions a brief was built from. Any edit, new answer or resolution changes it. */
export function requirementsFingerprint(active: Pick<RequirementRecord, 'id' | 'version'>[]): string {
  return createHash('sha256').update(active.map((r) => `${r.id}:${r.version}`).sort().join('|')).digest('hex').slice(0, 32);
}

export function requireStatus(project: Pick<ProjectRecord, 'status'>, ...allowed: ProjectRecord['status'][]): void {
  if (!allowed.includes(project.status)) {
    throw new DomainError('INVALID_STATE', `This isn't available while the project is in ${project.status.replaceAll('_', ' ').toLowerCase()}.`, { status: project.status });
  }
}
