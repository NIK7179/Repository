import clsx from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

export const cn = clsx;

type Variant = 'primary' | 'secondary' | 'ghost';
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90 border-transparent',
  secondary: 'bg-panel text-fg border-border hover:bg-subtle',
  ghost: 'bg-transparent text-muted border-transparent hover:bg-subtle hover:text-fg',
};

export function Button({ variant = 'primary', loading, className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn('inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3.5 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50', variants[variant], className)}
    >
      {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

const control = 'w-full rounded-md border bg-panel px-3 text-sm text-fg placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-60';

export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      {children}
      {error ? <p id={`${id}-error`} role="alert" className="text-sm text-danger">{error}</p> : hint ? <p id={`${id}-hint`} className="text-sm text-muted">{hint}</p> : null}
    </div>
  );
}
export function Input({ invalid, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...rest} aria-invalid={invalid || undefined} className={cn(control, 'h-9', invalid ? 'border-danger' : 'border-border', className)} />;
}
export function Textarea({ invalid, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea {...rest} aria-invalid={invalid || undefined} className={cn(control, 'min-h-40 resize-y py-2 leading-relaxed', invalid ? 'border-danger' : 'border-border', className)} />;
}

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';
const tones: Record<Tone, string> = {
  neutral: 'bg-subtle text-muted border-border', accent: 'bg-accent/10 text-accent border-accent/30',
  ok: 'bg-ok/10 text-ok border-ok/30', warn: 'bg-warn/10 text-warn border-warn/30', danger: 'bg-danger/10 text-danger border-danger/30',
};
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium', tones[tone], className)}>{children}</span>;
}

const STATUS: Record<string, [string, Tone]> = {
  IDEA: ['Idea', 'neutral'], DISCOVERY: ['Discovery', 'accent'], REQUIREMENTS_CONFIRMED: ['Requirements confirmed', 'accent'],
  ARCHITECTURE_GENERATING: ['Generating architecture', 'warn'], ARCHITECTURE_READY: ['Architecture ready', 'ok'],
  IMPLEMENTING: ['Implementing', 'ok'], ARCHIVED: ['Archived', 'neutral'],
};
export function StatusBadge({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? [status, 'neutral' as Tone];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded bg-subtle', className)} />;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border px-6 py-14 text-center">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'danger', title, children, action }: { tone?: 'danger' | 'warn' | 'neutral'; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-start justify-between gap-4 rounded-md border p-4 text-sm', tones[tone === 'neutral' ? 'neutral' : tone])}>
      <div><p className="font-medium">{title}</p>{children && <p className="mt-1 opacity-90">{children}</p>}</div>
      {action}
    </div>
  );
}
