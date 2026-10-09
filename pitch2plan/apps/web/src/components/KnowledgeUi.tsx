'use client';
import { useEffect, useState } from 'react';
import type { AssistantMessageContent, ClaimLabel, GroundingStatus, SourceType } from '@pitch2plan/schemas';
import { Alert, Badge, Button, Skeleton } from '@pitch2plan/ui';
import { ApiError, call, timeAgo, type CitationDetailDto, type DocsDto, type KnowledgeSearchDto } from '@/lib/api-client';

type Tone = 'neutral' | 'accent' | 'warn' | 'danger' | 'ok';
export const GROUNDING_COPY: Record<GroundingStatus, { label: string; tone: Tone; hint: string }> = {
  GROUNDED: { label: 'Grounded in official documentation', tone: 'ok', hint: 'The statements below are backed by the documentation cited.' },
  PARTIALLY_GROUNDED: { label: 'Partly grounded', tone: 'warn', hint: 'Some statements are backed by documentation or your project; others are not.' },
  UNGROUNDED: { label: 'Not grounded in documentation', tone: 'danger', hint: 'No official documentation supports this answer. Treat it as a suggestion and check it yourself.' },
  PROJECT_FACT_ONLY: { label: 'Based on your project', tone: 'accent', hint: 'This answer rests on your requirements and architecture decisions, not on external documentation.' },
};
export const CLAIM_COPY: Record<ClaimLabel, { label: string; tone: Tone }> = {
  PROJECT_FACT: { label: 'Project fact', tone: 'accent' },
  ARCHITECTURE_DECISION: { label: 'Architecture decision', tone: 'accent' },
  DOCUMENTED: { label: 'Documented guidance', tone: 'ok' },
  RECOMMENDATION: { label: 'Recommendation', tone: 'warn' },
  UNVERIFIED: { label: 'Unverified', tone: 'danger' },
};
export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  OFFICIAL_DOCS: 'Official documentation', OFFICIAL_API_DOCS: 'Official API reference', OFFICIAL_REPOSITORY: 'Official repository', OFFICIAL_RELEASE_NOTES: 'Official release notes', STANDARD: 'Standard', CURATED_INTERNAL: 'Curated by Pitch2Plan',
};
const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 'Unexpected error.'));

export function GroundingBadge({ status }: { status: GroundingStatus }) {
  const c = GROUNDING_COPY[status];
  return <span title={c.hint} data-testid="grounding-status" data-status={status}><Badge tone={c.tone}>{c.label}</Badge></span>;
}
export function ClaimChip({ label }: { label: ClaimLabel }) { const c = CLAIM_COPY[label]; return <Badge tone={c.tone}><span data-testid="claim-label" data-label={label}>{c.label}</span></Badge>; }

export function CitationChip({ n, title, onOpen }: { n: number; title: string; onOpen: (n: number) => void }) {
  return <button type="button" data-testid="citation-chip" aria-label={`Source ${n}: ${title}`} title={title} onClick={() => onOpen(n)} className="mx-0.5 inline-flex min-w-5 items-center justify-center rounded border border-accent/40 bg-accent/10 px-1 text-xs font-medium text-accent hover:bg-accent/20 focus-visible:outline-2 focus-visible:outline-accent">{n}</button>;
}

/** Turns the server-validated [n] markers into chips. Only numbers that have a stored citation become chips; anything else stays plain text. */
export function AnswerText({ text, citations, onOpen }: { text: string; citations: NonNullable<AssistantMessageContent['citations']>; onOpen: (n: number) => void }) {
  const by = new Map(citations.map((c) => [c.n, c]));
  const parts = text.split(/(\[\d{1,2}\])/g);
  return <p className="whitespace-pre-wrap">{parts.map((p, i) => { const m = /^\[(\d{1,2})\]$/.exec(p); const c = m ? by.get(Number(m[1])) : undefined; return c ? <CitationChip key={i} n={c.n} title={c.title} onOpen={onOpen} /> : <span key={i}>{p}</span>; })}</p>;
}

/** The source inspector: what exactly was cited, where it came from, when it was fetched, and the stored excerpt. */
export function SourceInspector({ citation, onClose }: { citation: NonNullable<AssistantMessageContent['citations']>[number]; onClose: () => void }) {
  const [detail, setDetail] = useState<CitationDetailDto | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    let live = true;
    call<{ citation: CitationDetailDto }>(`/api/knowledge/citations/${citation.id}`).then((r) => live && setDetail(r.citation)).catch((e) => live && setError(asError(e)));
    return () => { live = false; };
  }, [citation.id]);
  return (
    <aside role="dialog" aria-label={`Source ${citation.n}`} data-testid="source-inspector" className="rounded-md border border-border bg-panel p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Source {citation.n}</p><h4 className="mt-0.5 font-medium" data-testid="source-title">{citation.title}</h4></div>
        <Button variant="ghost" onClick={onClose} aria-label="Close source">Close</Button>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">Type</dt><dd data-testid="source-type">{SOURCE_TYPE_LABEL[citation.sourceType]}</dd>
        <dt className="text-muted">Publisher</dt><dd>{citation.provider}</dd>
        <dt className="text-muted">Technology</dt><dd>{citation.technologySlug}</dd>
        <dt className="text-muted">Documentation version</dt><dd data-testid="source-version">{citation.version ?? 'Not stated by the page'}</dd>
        {citation.sectionTitle && <><dt className="text-muted">Section</dt><dd>{citation.sectionTitle}</dd></>}
        <dt className="text-muted">Retrieved</dt><dd data-testid="source-retrieved">{timeAgo(citation.retrievedAt)}{citation.stale && <span className="ml-1"><Badge tone="warn">may be out of date</Badge></span>}</dd>
        <dt className="text-muted">Link</dt><dd className="break-all"><a href={citation.url} target="_blank" rel="noopener noreferrer" data-testid="source-link" className="text-accent underline">{citation.url}</a></dd>
      </dl>
      <blockquote data-testid="source-excerpt" className="mt-2 border-l-2 border-border pl-3 text-xs text-muted">{citation.excerpt}</blockquote>
      {error && <p className="mt-2 text-xs text-muted">The full passage could not be loaded ({error.message}). The excerpt above is what was cited.</p>}
      {detail?.fullText && detail.fullText !== citation.excerpt && <div className="mt-2"><button className="text-xs text-accent underline" onClick={() => setFull((f) => !f)} aria-expanded={full}>{full ? 'Hide full passage' : 'Show full passage'}</button>{full && <p data-testid="source-full" className="mt-1 whitespace-pre-wrap text-xs">{detail.fullText}</p>}</div>}
      <p className="mt-2 text-xs text-muted">This is a snapshot of what the answer relied on. The page may have changed since.</p>
    </aside>
  );
}

/** Grounding summary, per-statement provenance labels and the list of sources for one assistant answer. */
export function GroundingPanel({ m }: { m: AssistantMessageContent }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!m.grounding) return null;
  const g = m.grounding; const citations = m.citations ?? []; const claims = m.claims ?? [];
  const current = citations.find((c) => c.n === open);
  return (
    <div data-testid="grounding-panel" className="space-y-2 rounded-md border border-border bg-subtle p-3">
      <div className="flex flex-wrap items-center gap-2"><GroundingBadge status={g.status} />{citations.length > 0 && <span className="text-xs text-muted">{citations.length} source{citations.length === 1 ? '' : 's'}</span>}</div>
      <p className="text-xs text-muted">{GROUNDING_COPY[g.status].hint}</p>
      {g.reasons.length > 0 && <ul data-testid="grounding-reasons" className="list-disc space-y-0.5 pl-5 text-xs">{g.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      {g.versionNote && <p data-testid="version-note" className="rounded border border-warn/40 bg-warn/10 p-2 text-xs">{g.versionNote}</p>}
      {claims.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-medium">What each statement rests on</summary>
          <ul data-testid="claims" className="mt-1 space-y-1.5">{claims.map((c, i) => (
            <li key={i} className="text-xs"><ClaimChip label={c.label} /> <span>{c.text}</span>
              {c.citations.map((n) => { const ci = citations.find((x) => x.n === n); return ci ? <CitationChip key={n} n={n} title={ci.title} onOpen={setOpen} /> : null; })}
              {c.projectRefs.length > 0 && <span className="ml-1 text-muted">{c.projectRefs.join(', ')}</span>}
              {c.reason && <span className="ml-1 text-muted">({c.reason})</span>}</li>))}</ul>
        </details>
      )}
      {citations.length > 0 && <ul data-testid="citation-list" className="flex flex-wrap gap-2">{citations.map((c) => <li key={c.id}><CitationChip n={c.n} title={c.title} onOpen={setOpen} /> <span className="text-xs">{c.title}</span></li>)}</ul>}
      {current && <SourceInspector citation={current} onClose={() => setOpen(null)} />}
    </div>
  );
}

const AVAILABILITY_COPY: Record<string, string> = {
  UNAVAILABLE: 'Official documentation could not be loaded right now. Try again in a few minutes.',
  NOT_COVERED: 'Official documentation for this technology is not in the knowledge base yet.',
  NONE: 'No documented technologies are linked here, so there is nothing to look up.',
};

/** Official documentation for a task or a component. Shows a clear "preparing" state and polls briefly while the first ingestion runs. */
export function DocumentationSection({ url, label, onLoaded }: { url: string; label: string; onLoaded?: (d: DocsDto) => void }) {
  const [d, setD] = useState<DocsDto | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (n: number) => call<{ docs: DocsDto }>(url).then((r) => {
      if (!live) return; setD(r.docs); setError(null); onLoaded?.(r.docs);
      if (r.docs.availability === 'PREPARING' && n < 20) timer = setTimeout(() => { setTries(n + 1); load(n + 1); }, 3000);
    }).catch((e) => live && setError(asError(e)));
    setD(null); setTries(0); void load(0);
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [url]);

  if (error) return <Alert tone="warn" title={`We couldn’t load documentation for this ${label}`}>{error.message}</Alert>;
  if (!d) return <div role="status" aria-label="Loading documentation" className="space-y-2"><Skeleton className="h-4 w-64" /><Skeleton className="h-4 w-48" /></div>;
  if (d.availability === 'PREPARING' && d.documents.length === 0) return <p role="status" data-testid="docs-preparing" className="text-sm text-muted">Preparing official documentation… {tries >= 20 ? 'This is taking longer than expected; check back later.' : 'This usually takes a moment.'}</p>;
  if (d.documents.length === 0) return <p data-testid="docs-empty" className="text-sm text-muted">{AVAILABILITY_COPY[d.availability] ?? 'No official documentation was found for this yet.'}</p>;
  return (
    <div data-testid="docs-list">
      <p className="text-xs text-muted">{d.generalReference ? 'General reference for the technologies used here. Nothing in the index matches this exactly.' : 'Official documentation that matches this work.'}</p>
      {d.availability === 'PREPARING' && <p role="status" className="mt-1 text-xs text-muted">More documentation is still being prepared…</p>}
      <ul className="mt-2 space-y-2">{d.documents.map((x) => (
        <li key={x.url} data-testid="doc-item" className="rounded-md border border-border p-2.5">
          <div className="flex flex-wrap items-center gap-2"><a href={x.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline">{x.title}</a>
            <Badge tone={x.matched ? 'ok' : 'neutral'}>{x.matched ? 'Matches this' : 'General reference'}</Badge>{x.stale && <Badge tone="warn">may be out of date</Badge>}</div>
          <p className="mt-0.5 text-xs text-muted">{SOURCE_TYPE_LABEL[x.sourceType]} · {x.sourceTitle} · {x.version ? `version ${x.version}` : 'version not stated'} · checked {timeAgo(x.retrievedAt)}</p>
        </li>))}</ul>
      <p className="mt-2 text-xs text-muted">Links open the vendor’s own site. Pitch2Plan only indexes pages from allow-listed official hosts.</p>
    </div>
  );
}

/** Search across indexed official documentation for a technology the project uses. */
export function DocSearch({ projectId, technologies }: { projectId?: string; technologies: Array<{ slug: string; name: string }> }) {
  const [q, setQ] = useState(''); const [picked, setPicked] = useState('');
  // The list arrives asynchronously: the selection is derived, never frozen from the first (empty) render.
  const tech = technologies.some((t) => t.slug === picked) ? picked : technologies[0]?.slug ?? '';
  const [res, setRes] = useState<KnowledgeSearchDto | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  if (technologies.length === 0) return <p className="text-sm text-muted">No documented technologies in this component, so there is nothing to search.</p>;
  async function go(e: React.FormEvent) {
    e.preventDefault(); if (q.trim().length < 2) return; setBusy(true); setError(null); setOpen(null);
    try { const p = new URLSearchParams({ q: q.trim(), technology: tech, ...(projectId ? { projectId } : {}) }); setRes(await call<KnowledgeSearchDto>(`/api/knowledge/search?${p}`)); }
    catch (err) { setError(asError(err)); } finally { setBusy(false); }
  }
  return (
    <div data-testid="doc-search" className="space-y-3">
      <form onSubmit={go} className="flex flex-wrap items-center gap-2">
        <label htmlFor="doc-search-q" className="sr-only">Search documentation</label>
        <input id="doc-search-q" data-testid="doc-search-input" value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} placeholder="Search the official documentation…" className="h-9 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-sm" />
        {technologies.length > 1 && <><label htmlFor="doc-search-tech" className="sr-only">Technology</label><select id="doc-search-tech" value={tech} onChange={(e) => setPicked(e.target.value)} className="h-9 rounded-md border border-border bg-bg px-2 text-sm">{technologies.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}</select></>}
        <Button type="submit" disabled={busy || q.trim().length < 2} loading={busy}>Search</Button>
      </form>
      {error && <Alert tone="warn" title="Search failed">{error.message}</Alert>}
      {res && (res.results.length === 0
        ? <p data-testid="doc-search-empty" className="text-sm text-muted">{res.availability === 'PREPARING' ? 'Documentation is still being prepared. Try again in a moment.' : res.availability === 'NOT_COVERED' ? AVAILABILITY_COPY.NOT_COVERED : 'No passage in the indexed official documentation answers that. Try different words.'}</p>
        : <ul data-testid="doc-search-results" className="space-y-2">{res.results.map((r) => (
          <li key={`${r.url}-${r.n}`} className="rounded-md border border-border p-2.5 text-sm">
            <a href={r.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline">{r.title}</a>{r.sectionTitle && <span className="ml-2 text-xs text-muted">{r.sectionTitle}</span>}
            <p className="mt-1 text-xs text-muted">{r.excerpt}</p>
            <button className="mt-1 text-xs text-accent underline" onClick={() => setOpen(open === r.n ? null : r.n)}>{open === r.n ? 'Hide details' : 'Source details'}</button>
            {open === r.n && <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs"><dt className="text-muted">Type</dt><dd>{SOURCE_TYPE_LABEL[r.sourceType]}</dd><dt className="text-muted">Version</dt><dd>{r.version ?? 'Not stated by the page'}</dd><dt className="text-muted">Retrieved</dt><dd>{timeAgo(r.retrievedAt)}</dd></dl>}
          </li>))}</ul>)}
    </div>
  );
}
