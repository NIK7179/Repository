'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantMessageContent } from '@pitch2plan/schemas';
import { Alert, Badge, Button } from '@pitch2plan/ui';
import { ApiError, call, type ConversationDto } from '@/lib/api-client';
import { streamAsk, type AskInput } from '@/lib/assistant-client';
import { newId, riskLabel, riskTone } from '@/lib/impl-labels';

interface Item { id: string; role: 'USER' | 'ASSISTANT'; text: string; structured?: AssistantMessageContent | null }
export interface AskArchitectProps { projectId: string; scope: 'PROJECT' | 'COMPONENT' | 'TASK'; scopeId?: string; stepId?: string | null; suggestions?: string[]; onClearStep?: () => void }
const DEFAULT_SUGGESTIONS = ['Why do I need this?', 'How do I validate this?', 'What comes next?', 'What happens if I skip this?'];

function Structured({ projectId, m, proposeHref }: { projectId: string; m: AssistantMessageContent; proposeHref?: string }) {
  return (
    <div className="mt-3 space-y-3">
      {m.notices.map((n, i) => <Alert key={i} tone="warn" title="Please note">{n}</Alert>)}
      {m.needsArchitectureChange && (
        <div data-testid="needs-change-banner" className="rounded-md border border-warn/40 bg-warn/10 p-3 text-sm">
          <p className="font-medium">An architecture change would be required</p>
          {m.architectureImpact && <p className="mt-1 text-muted">{m.architectureImpact}</p>}
          <p className="mt-1 text-xs text-muted">Nothing was changed. Your architecture is exactly as it was.</p>
          {proposeHref && <Link href={proposeHref} data-testid="propose-change" className="mt-2 inline-block rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90">Propose Architecture Change</Link>}
          <p className="mt-1 text-xs text-muted">You will review and edit the proposal before anything is created.</p>
        </div>
      )}
      {m.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm">{m.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      {m.commands.map((c, i) => (
        <div key={i} data-testid="assistant-command" className="rounded-md border border-border bg-subtle p-3">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={riskTone(c.risk)}><span data-testid="command-risk">{riskLabel(c.risk)}</span></Badge><span className="text-xs text-muted">{c.purpose}</span></div>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs"><code>{c.command}</code></pre>
          <p className="mt-1 text-xs text-muted">{c.risk === 'DESTRUCTIVE' ? 'Destructive: this can permanently delete or overwrite things. ' : ''}Pitch2Plan never runs commands. You run it yourself, if you choose to.</p>
        </div>
      ))}
      {m.codeBlocks.map((b, i) => (
        <figure key={i} data-testid="assistant-code" className="rounded-md border border-border">
          <figcaption className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs"><span>{b.filename ?? b.language} · {b.purpose}</span><Badge tone="warn">Review before use</Badge></figcaption>
          <pre className="overflow-x-auto p-3 text-xs"><code>{b.content}</code></pre>
        </figure>
      ))}
      {m.validationSteps.length > 0 && <div><h4 className="text-xs font-semibold uppercase tracking-wide text-muted">How to check</h4><ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{m.validationSteps.map((v, i) => <li key={i}>{v}</li>)}</ul></div>}
      {m.relatedTasks.length > 0 && <p className="text-sm"><span className="text-muted">Related: </span>{m.relatedTasks.map((t) => <Link key={t.id} href={`/projects/${projectId}/implementation/tasks/${t.id}`} className="mr-2 text-accent underline">{t.title}</Link>)}</p>}
    </div>
  );
}

/** The contextual architect. Context (project, component, task, step) is assembled on the server; the user never repeats it. */
export function AskArchitect({ projectId, scope, scopeId, stepId, suggestions = DEFAULT_SUGGESTIONS, onClearStep }: AskArchitectProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const last = useRef<AskInput | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const busy = streaming !== null;
  /** Prefills a change proposal from this answer. The user reviews and edits it; nothing is created here. */
  const proposalHref = (m: Item, prev?: Item) => {
    const q = new URLSearchParams({ text: (prev?.text ?? '').slice(0, 1500), ...(m.structured?.architectureImpact ? { reason: m.structured.architectureImpact.slice(0, 1000) } : {}), ...(conversationId ? { conversation: conversationId } : {}), ...(m.id && !m.id.startsWith('local-') ? { message: m.id } : {}) });
    return `/projects/${projectId}/changes/new?${q}`;
  };

  useEffect(() => {
    let live = true; setLoaded(false); setItems([]);
    const q = new URLSearchParams({ scope, ...(scopeId ? { scopeId } : {}) });
    call<ConversationDto>(`/api/projects/${projectId}/conversation?${q}`)
      .then((r) => {
        if (!live) return;
        const loaded = r.messages.filter((m) => m.status === 'COMPLETE').map((m) => ({ id: m.id, role: m.role === 'USER' ? 'USER' as const : 'ASSISTANT' as const, text: m.structured?.answer ?? m.content, structured: m.structured as AssistantMessageContent | null }));
        setItems((cur) => (cur.length ? cur : loaded)); // never overwrite a question the user already sent while history was loading
        setConversationId((c) => c ?? r.conversation?.id ?? null);
      })
      .catch(() => undefined).finally(() => live && setLoaded(true));
    return () => { live = false; abort.current?.abort(); };
  }, [projectId, scope, scopeId]);
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: 'end' }); }, [items, streaming]);

  const run = useCallback(async (input: AskInput) => {
    last.current = input; setError(null); setStreaming('');
    const ac = new AbortController(); abort.current = ac; let acc = '';
    try {
      await streamAsk(input, {
        onStart: (e) => setConversationId(e.conversationId),
        onDelta: (t) => { acc += t; setStreaming(acc); },
        onDone: (m) => { setItems((xs) => [...xs, { id: m.id, role: 'ASSISTANT', text: m.structured?.answer ?? m.content, structured: m.structured }]); last.current = null; },
        onError: (e) => setError(e),
      }, ac.signal);
    } catch (e) { setError({ code: e instanceof ApiError ? e.code : 'INTERNAL_ERROR', message: e instanceof ApiError ? e.message : 'Something went wrong. Try again.' }); }
    finally { setStreaming(null); abort.current = null; }
  }, []);

  function send(text: string) {
    const message = text.trim(); if (!message || busy) return;
    setItems((xs) => [...xs, { id: `local-${xs.length}`, role: 'USER', text: message }]); setDraft('');
    void run({ projectId, scope, scopeId, stepId: stepId ?? undefined, message, clientMessageId: newId() });
  }
  const retry = () => { if (last.current && !busy) void run(last.current); }; // same clientMessageId: the stored question is reused, not duplicated
  const cancel = () => { abort.current?.abort(); setStreaming(null); setError(null); last.current = null; };

  return (
    <section data-testid="ask-architect" aria-label="Ask Architect" className="flex h-full min-h-[24rem] flex-col rounded-lg border border-border bg-panel">
      <header className="border-b border-border px-4 py-2.5"><h2 className="text-sm font-semibold">Ask Architect</h2><p className="text-xs text-muted">Knows this project{scope === 'TASK' ? ', this task' : scope === 'COMPONENT' ? ' and this component' : ''}{stepId ? ' and the selected step' : ''}. You don’t need to explain it.</p>
        {stepId && <p className="mt-1 text-xs"><Badge tone="accent">About the selected step</Badge> <button className="ml-1 text-muted underline" onClick={onClearStep}>clear</button></p>}</header>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3" aria-live="polite">
        {loaded && items.length === 0 && !busy && <div><p className="text-sm text-muted">Ask anything about this part of your project.</p><div className="mt-2 flex flex-wrap gap-2">{suggestions.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-border px-3 py-1 text-xs hover:bg-subtle">{s}</button>)}</div></div>}
        {items.map((m, idx) => m.role === 'USER'
          ? <div key={m.id} data-testid="user-message" className="ml-8 rounded-lg bg-accent/10 px-3 py-2 text-sm">{m.text}</div>
          : <div key={m.id} data-testid="assistant-message" className="mr-4 rounded-lg border border-border px-3 py-2 text-sm"><p className="whitespace-pre-wrap">{m.text}</p>{m.structured && <Structured projectId={projectId} m={m.structured} proposeHref={m.structured.needsArchitectureChange ? proposalHref(m, items[idx - 1]) : undefined} />}</div>)}
        {streaming !== null && <div data-testid="ask-stream" role="status" aria-label="Answer in progress" className="mr-4 rounded-lg border border-border px-3 py-2 text-sm"><p className="whitespace-pre-wrap">{streaming || 'Thinking…'}</p></div>}
        {error && (
          <div data-testid="ask-error"><Alert title="The architect couldn’t finish that answer" action={<Button variant="secondary" data-testid="ask-retry" onClick={retry}>Try again</Button>}>{error.message}</Alert></div>
        )}
        <div ref={bottom} />
      </div>
      <form className="border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); send(draft); }}>
        <label htmlFor={`ask-${scope}-${scopeId ?? 'p'}`} className="sr-only">Your question</label>
        <textarea id={`ask-${scope}-${scopeId ?? 'p'}`} data-testid="ask-input" value={draft} maxLength={4000} rows={2} placeholder="Ask a question…  (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft); } }}
          className="w-full resize-none rounded-md border border-border bg-bg p-2 text-sm focus-visible:outline-2 focus-visible:outline-accent" />
        <div className="mt-2 flex justify-end gap-2">
          {busy && <Button type="button" variant="ghost" data-testid="ask-cancel" onClick={cancel}>Stop</Button>}
          <Button type="submit" data-testid="ask-send" disabled={busy || !draft.trim()}>{busy ? 'Answering…' : 'Ask'}</Button>
        </div>
      </form>
    </section>
  );
}
