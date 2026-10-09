'use client';
import { useState } from 'react';
import { devSignInRequestSchema } from '@pitch2plan/schemas';
import { Alert, Button, Field, Input } from '@pitch2plan/ui';
import { ApiError, call } from '@/lib/api-client';

export function SignInForm() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e?: React.FormEvent, override?: { email: string; name: string }) {
    e?.preventDefault();
    const input = override ?? { email, name };
    const parsed = devSignInRequestSchema.safeParse(input);
    if (!parsed.success) return setError(parsed.error.issues[0]!.message);
    setBusy(true); setError(null);
    try { await call('/api/auth/dev-sign-in', { method: 'POST', body: parsed.data }); window.location.assign('/projects'); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Sign-in failed.'); setBusy(false); }
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <Alert tone="warn" title="Development sign-in">This local-only sign-in is a stand-in for a production auth provider. Any email creates an account.</Alert>
      <Field id="email" label="Email" error={error}>
        <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} invalid={!!error} placeholder="you@example.com" autoFocus />
      </Field>
      <Field id="name" label="Name (optional)"><Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} /></Field>
      <div className="flex items-center gap-3">
        <Button type="submit" loading={busy}>Sign in</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void submit(undefined, { email: 'demo@pitch2plan.dev', name: 'Demo User' })}>Use demo account</Button>
      </div>
    </form>
  );
}
