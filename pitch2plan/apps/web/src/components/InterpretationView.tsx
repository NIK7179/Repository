import type { IdeaInterpretation } from '@pitch2plan/schemas';
import { Badge } from '@pitch2plan/ui';

function Origin({ origin }: { origin: 'USER_STATED' | 'AI_INFERRED' }) {
  return origin === 'USER_STATED' ? <Badge tone="accent">You said</Badge> : <Badge tone="warn">We inferred</Badge>;
}
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-panel p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      <div className="mt-3 text-sm">{children}</div>
    </section>
  );
}
const List = ({ items }: { items: string[] }) => items.length
  ? <ul className="list-disc space-y-1 pl-5">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
  : <p className="text-muted">Nothing identified.</p>;

/** Everything is rendered as plain text (React escapes it); model output is never injected as HTML. */
export function InterpretationView({ output }: { output: IdeaInterpretation }) {
  return (
    <div className="space-y-4" data-testid="interpretation">
      <Section title="Our understanding of your idea"><p className="text-base leading-relaxed">{output.summary}</p></Section>
      <Section title="Problem being solved"><p>{output.problemStatement}</p></Section>
      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Possible users">
          {output.targetUsers.length ? <ul className="space-y-2">{output.targetUsers.map((u, i) => <li key={i} className="flex items-center gap-2"><Origin origin={u.origin} />{u.text}</li>)}</ul> : <p className="text-muted">No users were named. We will ask.</p>}
        </Section>
        <Section title="Capabilities we detected">
          {output.possibleCapabilities.length ? <ul className="space-y-2">{output.possibleCapabilities.map((c, i) => <li key={i} className="flex items-center gap-2"><Origin origin={c.origin} />{c.text}</li>)}</ul> : <p className="text-muted">None detected yet.</p>}
        </Section>
      </div>
      <Section title="What you told us" hint="Quoted from your pitch.">
        {output.userStatedFacts.length ? <ul className="space-y-2">{output.userStatedFacts.map((f, i) => <li key={i} className="border-l-2 border-accent pl-3 text-muted">“{f.quote}”</li>)}</ul> : <p className="text-muted">Nothing quotable.</p>}
      </Section>
      <Section title="What we inferred" hint="These are our assumptions, not confirmed requirements. You will confirm or correct them next.">
        {output.inferredRequirements.length ? (
          <ul className="space-y-3">{output.inferredRequirements.map((r, i) => (
            <li key={i}>
              <div className="flex flex-wrap items-center gap-2"><Badge>{r.type.replace('_', ' ').toLowerCase()}</Badge><Badge tone="warn">We inferred</Badge><span className="text-xs text-muted">{Math.round(r.confidence * 100)}% confidence</span></div>
              <p className="mt-1">{r.description}</p><p className="text-xs text-muted">{r.rationale}</p>
            </li>))}
          </ul>) : <p className="text-muted">No inferences.</p>}
      </Section>
      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Assumptions we are making"><List items={output.assumptions} /></Section>
        <Section title="Things we still need to understand"><List items={output.unknowns} /></Section>
      </div>
      <Section title="Discovery will cover" hint="Next, we will ask a few targeted questions on these areas.">
        <div className="flex flex-wrap gap-2">{output.recommendedDiscoveryAreas.map((a, i) => <Badge key={i} tone="accent">{a}</Badge>)}</div>
      </Section>
    </div>
  );
}
