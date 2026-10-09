export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';
export const statusLabel = (s: string) => s.replaceAll('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
export const statusTone = (s: string): Tone => (s === 'COMPLETED' ? 'ok' : s === 'IN_PROGRESS' ? 'accent' : s === 'BLOCKED' ? 'danger' : s === 'SKIPPED' ? 'neutral' : 'neutral');
export const readinessLabel = (r: string, unmet: number) => (r === 'READY' ? 'Ready' : r === 'WAITING' ? `Waiting on ${unmet}` : statusLabel(r));
export const typeLabel = (t: string) => t.toLowerCase().replaceAll('_', ' ');
export const riskTone = (r: string): Tone => (r === 'DESTRUCTIVE' ? 'danger' : r === 'MUTATING' ? 'warn' : 'ok');
export const riskLabel = (r: string) => (r === 'DESTRUCTIVE' ? 'Destructive' : r === 'MUTATING' ? 'Changes state' : 'Read-only');
export const newId = () => (globalThis.crypto?.randomUUID?.() ?? `cm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
