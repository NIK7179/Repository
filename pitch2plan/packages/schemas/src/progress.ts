import type { PhaseStatus, TaskStatus } from './implementation';

// ---------------------------------------------------------------- progress transitions (explicit; history is recorded elsewhere)
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  NOT_STARTED: ['IN_PROGRESS', 'SKIPPED'],
  IN_PROGRESS: ['COMPLETED', 'BLOCKED', 'SKIPPED', 'NOT_STARTED'],
  BLOCKED: ['IN_PROGRESS', 'SKIPPED'],
  COMPLETED: ['IN_PROGRESS'], // reopen
  SKIPPED: ['NOT_STARTED'],
};
export const canTransitionTask = (from: TaskStatus, to: TaskStatus) => TASK_TRANSITIONS[from].includes(to);

export interface ProgressTask { key: string; status: TaskStatus; dependsOn: string[]; phaseKey: string; phaseSequence: number; sequence: number; title?: string; componentKeys?: string[] }

/** A dependency is satisfied when it is COMPLETED or SKIPPED. */
export const dependenciesSatisfied = (t: Pick<ProgressTask, 'dependsOn'>, byKey: Map<string, Pick<ProgressTask, 'status'>>) => t.dependsOn.every((d) => { const s = byKey.get(d)?.status; return s === 'COMPLETED' || s === 'SKIPPED'; });

export function taskReadiness(tasks: ProgressTask[]): Map<string, 'READY' | 'WAITING' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETED' | 'SKIPPED'> {
  const by = new Map(tasks.map((t) => [t.key, t]));
  return new Map(tasks.map((t) => [t.key, t.status === 'NOT_STARTED' ? (dependenciesSatisfied(t, by) ? 'READY' : 'WAITING') : t.status]));
}

export function phaseStatus(statuses: TaskStatus[]): PhaseStatus {
  const live = statuses.filter((s) => s !== 'SKIPPED');
  if (live.length === 0) return statuses.length ? 'COMPLETED' : 'NOT_STARTED';
  if (live.every((s) => s === 'COMPLETED')) return 'COMPLETED';
  if (live.some((s) => s === 'BLOCKED')) return 'BLOCKED';
  if (live.some((s) => s === 'IN_PROGRESS' || s === 'COMPLETED')) return 'IN_PROGRESS';
  return 'NOT_STARTED';
}

/**
 * RULE (documented, single): SKIPPED tasks are EXCLUDED from the denominator, they are not counted as completed.
 * progress = completed / (total - skipped). With no applicable tasks, progress is 100% only if something was skipped, else 0%.
 */
export function progressOf(statuses: TaskStatus[]) {
  const skipped = statuses.filter((s) => s === 'SKIPPED').length, applicable = statuses.length - skipped, completed = statuses.filter((s) => s === 'COMPLETED').length;
  return { total: statuses.length, applicable, completed, skipped, percent: applicable === 0 ? (skipped > 0 ? 100 : 0) : Math.round((100 * completed) / applicable) };
}

export function computeProgress(tasks: ProgressTask[]) {
  const phases = new Map<string, TaskStatus[]>(), components = new Map<string, TaskStatus[]>();
  for (const t of tasks) { phases.set(t.phaseKey, [...(phases.get(t.phaseKey) ?? []), t.status]); for (const c of t.componentKeys ?? []) components.set(c, [...(components.get(c) ?? []), t.status]); }
  return {
    overall: progressOf(tasks.map((t) => t.status)),
    byPhase: Object.fromEntries([...phases].map(([k, v]) => [k, { ...progressOf(v), status: phaseStatus(v) }])),
    byComponent: Object.fromEntries([...components].map(([k, v]) => [k, progressOf(v)])),
  };
}

/** Deterministic "what next": continue what is in progress, otherwise the earliest READY task (phase order, then sequence). No model involved. */
export function nextBestTask(tasks: ProgressTask[]): { task: ProgressTask; kind: 'CONTINUE' | 'START'; reason: string } | null {
  const by = new Map(tasks.map((t) => [t.key, t]));
  const ordered = [...tasks].sort((a, b) => a.phaseSequence - b.phaseSequence || a.sequence - b.sequence);
  const current = ordered.find((t) => t.status === 'IN_PROGRESS');
  if (current) return { task: current, kind: 'CONTINUE', reason: 'You already started this task.' };
  const ready = ordered.filter((t) => t.status === 'NOT_STARTED' && dependenciesSatisfied(t, by));
  if (!ready.length) return null;
  const task = ready[0]!;
  const done = task.dependsOn.map((d) => by.get(d)?.title).filter(Boolean) as string[];
  const unblocks = tasks.filter((t) => t.dependsOn.includes(task.key) && t.status !== 'COMPLETED' && t.status !== 'SKIPPED');
  const parts = [done.length ? `${done.slice(0, 3).join(', ')} ${done.length === 1 ? 'is' : 'are'} complete` : 'It has no prerequisites'];
  parts.push(unblocks.length ? `it unblocks ${unblocks.length} task${unblocks.length === 1 ? '' : 's'} (${unblocks.slice(0, 2).map((u) => u.title).join(', ')}${unblocks.length > 2 ? ', …' : ''})` : 'nothing else is waiting on it');
  return { task, kind: 'START', reason: `${parts[0]}, and ${parts[1]}.` };
}

// ---------------------------------------------------------------- command safety (deterministic; the model never decides)
export type CommandRisk = 'READ_ONLY' | 'MUTATING' | 'DESTRUCTIVE';
const SPLIT = /\s*(?:&&|\|\||;|\|)\s*/;
const DESTRUCTIVE: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive|-r)\b/i, /\b(aws\s+s3\s+rb|s3\s+rb)\b/i, /--force\b/i, /\bdelete\b/i, /\bdestroy\b/i, /\bdrop\s+(table|database|schema|index)\b/i, /\btruncate\b/i,
  /\bterminate[-\s]/i, /\bkubectl\s+delete\b/i, /\bterraform\s+destroy\b/i, /\bgit\s+(push\s+.*--force|reset\s+--hard|clean\s+-[a-z]*f)/i, /\bdocker\s+(system\s+prune|volume\s+rm|rm\s+-f)/i,
  /\bmkfs\b/i, /\bdd\s+if=/i, /\bdelete-\w+/i, /\bflushall\b|\bflushdb\b/i, />\s*\/dev\/(sd|nvme)/i, /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, /\bchmod\s+-R\s+777\b/i,
];
const MUTATING: RegExp[] = [
  /\b(apply|create|put|update|patch|install|upgrade|run|start|stop|restart|enable|disable|attach|detach|add|set|write|copy|cp|mv|sync|mb|push|publish|deploy|init|migrate|grant|revoke|alter|insert|chmod|chown|scale|rollout|annotate|label|taint|cordon|drain|import|export|exec|useradd|sudo)\b/i, />>?\s*\S/, /\$\(|`/,
];
const READ_ONLY_VERB = /^(?:sudo\s+)?(?:[\w./-]+\s+)*?(get|describe|list|ls|show|cat|head|tail|less|echo|pwd|whoami|which|version|--version|-v|help|--help|validate|plan|fmt|diff|status|logs|top|df|du|ps|env|printenv|history|grep|find|wc|date|dig|nslookup|ping|host|stat|tree|test|check|inspect|explain|query|select|head-object|(?:list|describe|get|head)-[\w-]+)(?:\s|$)/i;

export function classifyCommand(command: string): { risk: CommandRisk; reasons: string[] } {
  const reasons: string[] = []; let rank = 0; const RANK: CommandRisk[] = ['READ_ONLY', 'MUTATING', 'DESTRUCTIVE'];
  const bump = (r: number, why: string) => { rank = Math.max(rank, r); reasons.push(why); };
  const whole = command.trim();
  if (!whole) return { risk: 'MUTATING', reasons: ['Empty command; treated conservatively.'] };
  for (const re of DESTRUCTIVE) if (re.test(whole)) bump(2, `Matches a destructive pattern (${re.source.slice(0, 40)}).`);
  for (const part of whole.split(SPLIT).filter(Boolean)) {
    const p = part.trim();
    if (DESTRUCTIVE.some((re) => re.test(p))) { bump(2, `Destructive step: ${p.slice(0, 60)}`); continue; }
    // "terraform plan", "kubectl get", "aws ... describe-*" are read-only even though other verbs appear elsewhere in the line.
    if (/\bterraform\s+(plan|validate|fmt|show|output)\b/i.test(p) || READ_ONLY_VERB.test(p)) { if (!/\b(apply|create|put|delete|update|patch|install|run|exec)\b/i.test(p) || /\bterraform\s+(plan|validate)\b/i.test(p)) continue; }
    if (MUTATING.some((re) => re.test(p))) bump(1, `Changes state: ${p.slice(0, 60)}`);
    else bump(1, `Not recognised as read-only, treated as mutating: ${p.slice(0, 60)}`);
  }
  if (/\$\(|`/.test(whole)) bump(1, 'Contains command substitution.');
  return { risk: RANK[rank]!, reasons: [...new Set(reasons)] };
}

// ---------------------------------------------------------------- streaming: split "answer text" from the structured trailer
export const STRUCTURED_DELIMITER = '<<<STRUCTURED>>>';
/**
 * Streams answer text as it arrives, holding back just enough characters to never emit a partial delimiter.
 * After the delimiter, everything is collected as the structured JSON trailer.
 */
export class DelimiterSplitter {
  private buffer = ''; private after = ''; private seen = false;
  push(chunk: string): string {
    if (this.seen) { this.after += chunk; return ''; }
    this.buffer += chunk;
    const i = this.buffer.indexOf(STRUCTURED_DELIMITER);
    if (i >= 0) { this.seen = true; this.after = this.buffer.slice(i + STRUCTURED_DELIMITER.length); const out = this.buffer.slice(0, i); this.buffer = ''; return out; }
    const hold = Math.min(this.buffer.length, STRUCTURED_DELIMITER.length - 1);
    let keep = 0;
    for (let n = hold; n > 0; n--) if (STRUCTURED_DELIMITER.startsWith(this.buffer.slice(this.buffer.length - n))) { keep = n; break; }
    const out = this.buffer.slice(0, this.buffer.length - keep); this.buffer = this.buffer.slice(this.buffer.length - keep); return out;
  }
  finish(): { tail: string; structured: string | null } { const tail = this.seen ? '' : this.buffer; this.buffer = ''; return { tail, structured: this.seen ? this.after.trim() : null }; }
}
