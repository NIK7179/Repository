'use client';
import { useState } from 'react';
import { Button } from '@pitch2plan/ui';
import { call } from '@/lib/api-client';

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Button variant="ghost" loading={busy} onClick={async () => {
      setBusy(true);
      try { await call('/api/auth/sign-out', { method: 'POST' }); } finally { window.location.assign('/sign-in'); }
    }}>Sign out</Button>
  );
}
