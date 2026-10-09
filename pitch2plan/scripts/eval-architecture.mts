/**
 * Architecture quality evaluation. Runs four reference projects (curated, already-confirmed requirements and drivers) through the
 * REAL planner -> validate -> critic -> repair pipeline and prints, for HUMAN review, every component, connection and decision,
 * plus mechanical metrics.
 *
 *   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run eval:architecture            # summary + metrics
 *   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run eval:architecture -- --deep  # + full decisions, rationale, critic text
 *
 * With the default mock provider this only smoke-tests the harness. Mock output says NOTHING about architecture quality.
 *
 * The metrics are heuristics for comparing runs, NOT objective scores. A design can pass every metric and still be wrong for the
 * project, and a keyword being present proves nothing. The tendency checks flag things worth LOOKING at; the judgement is yours.
 */
import { writeFileSync } from 'node:fs';
import { AnthropicLLMProvider, LLMGateway, MockLLMProvider, createArchitectureAi, type LLMProvider } from '@pitch2plan/ai';
import { DEFAULT_PIPELINE_CONFIG, PipelineError, runArchitecturePipeline } from '@pitch2plan/domain';
import { computeComplexity, validateArchitectureStructure, type ArchitectureIssue, type ArchitecturePlan, type PlanInput } from '@pitch2plan/schemas';

type Req = PlanInput['requirements'][number]; type Drv = PlanInput['drivers'][number];
const R = (n: number, category: string, statement: string, origin = 'USER_ANSWERED'): Req => ({ code: `REQ-${String(n).padStart(3, '0')}`, category, statement, value: null, origin, confidence: null });
const D = (n: number, name: string, description: string, priority: string, reqs: number[]): Drv => ({ code: `DRV-${String(n).padStart(3, '0')}`, name, description, priority, requirementCodes: reqs.map((r) => `REQ-${String(r).padStart(3, '0')}`) });

interface Case { name: string; summary: string; requirements: Req[]; drivers: Drv[]; tendencies: Array<{ label: string; test: (p: ArchitecturePlan) => boolean }>; penalties: Array<{ label: string; test: (p: ArchitecturePlan) => boolean }> }
const cats = (p: ArchitecturePlan, ...c: string[]) => p.nodes.some((n) => c.includes(n.category));
const slug = (p: ArchitecturePlan, re: RegExp) => p.nodes.some((n) => re.test(`${n.technologySlug} ${n.technology}`));
const HEAVY = /kubernetes|k8s|kafka|kinesis|spark|flink|pulsar|hadoop|cassandra|airflow|microservice/i;

const CASES: Case[] = [
  { name: 'CASE 1 — Real-time transaction analytics', summary: 'Collect transaction events from several applications, process continuously, store for analytics.',
    requirements: [R(1, 'FUNCTIONAL', 'Collect transaction events from multiple applications', 'USER_STATED'), R(2, 'FUNCTIONAL', 'Process the events continuously, as they arrive', 'USER_STATED'), R(3, 'DATA', 'Store processed data so analysts can query it later', 'USER_STATED'),
      R(4, 'TRAFFIC', 'About 50 million events per day, with peaks of five times the average'), R(5, 'LATENCY', 'Processed results are needed within a few seconds of the event'), R(6, 'DATA', 'Events must be replayable for 7 days so processing bugs can be fixed and re-run'),
      R(7, 'INTEGRATION', 'Several independent downstream systems (fraud checks, reporting) each need the same events'), R(8, 'SECURITY', 'Transaction data is sensitive financial data'), R(9, 'AVAILABILITY', 'Losing events is unacceptable; short processing delays are tolerable'), R(10, 'TEAM_CONSTRAINT', 'A small platform team of three engineers will run it')],
    drivers: [D(1, 'High-volume durable ingestion', '50M events/day with 5x peaks and no event loss', 'CRITICAL', [4, 9]), D(2, 'Independent consumers with replay', 'Multiple systems consume the same events; 7-day replay', 'HIGH', [6, 7]), D(3, 'Continuous low-latency processing', 'Results within seconds', 'HIGH', [2, 5]), D(4, 'Sensitive financial data', 'Protect data in transit and at rest', 'HIGH', [8]), D(5, 'Small operating team', 'Prefer managed services', 'MEDIUM', [10])],
    tendencies: [{ label: 'event ingestion component', test: (p) => cats(p, 'EVENT_STREAM', 'QUEUE') }, { label: 'stream/batch processing component', test: (p) => cats(p, 'STREAM_PROCESSOR', 'BATCH_PROCESSOR') }, { label: 'durable analytics store', test: (p) => cats(p, 'DATABASE', 'OBJECT_STORAGE', 'DATA_WAREHOUSE') }],
    penalties: [{ label: 'unencrypted connection despite sensitive data', test: (p) => p.edges.some((e) => e.encrypted === false) }] },
  { name: 'CASE 2 — Fitness trainer scheduling SaaS', summary: 'Scheduling app for independent fitness trainers and their clients.',
    requirements: [R(1, 'FUNCTIONAL', 'Trainers publish availability and clients book sessions', 'USER_STATED'), R(2, 'FUNCTIONAL', 'Clients get reminders before a session'), R(3, 'TRAFFIC', 'About 500 trainers and 10,000 bookings a month'), R(4, 'USERS', 'Used from phones and laptops'), R(5, 'BUDGET', 'Keep running costs as low as possible'), R(6, 'TEAM_CONSTRAINT', 'Built and run by one or two developers'), R(7, 'AVAILABILITY', 'A few minutes of downtime now and then is fine'), R(8, 'DATA', 'Store accounts, availability and bookings; modest data volume')],
    drivers: [D(1, 'Simple to build and operate', 'Tiny team, modest scale', 'CRITICAL', [3, 6]), D(2, 'Low running cost', 'Budget is tight', 'HIGH', [5, 7]), D(3, 'Reliable reminders', 'Reminders must actually be sent', 'MEDIUM', [2])],
    tendencies: [{ label: 'a database for accounts and bookings', test: (p) => cats(p, 'DATABASE') }, { label: 'a web client and an API/application service', test: (p) => cats(p, 'CLIENT') && cats(p, 'API', 'APPLICATION_SERVICE') }],
    penalties: [{ label: 'event streaming / stream or batch processing for 10k bookings a month', test: (p) => cats(p, 'EVENT_STREAM', 'STREAM_PROCESSOR', 'BATCH_PROCESSOR') }, { label: 'heavyweight technology (Kubernetes, Kafka, Spark, ...)', test: (p) => slug(p, HEAVY) }, { label: 'more than 8 components for a two-person project', test: (p) => p.nodes.length > 8 }] },
  { name: 'CASE 3 — Enterprise document Q&A', summary: 'Companies upload internal documents; employees ask questions about them.',
    requirements: [R(1, 'FUNCTIONAL', 'Company admins upload documents (PDF, Word, text)', 'USER_STATED'), R(2, 'FUNCTIONAL', 'Employees ask questions and get answers based on their company’s documents', 'USER_STATED'), R(3, 'FUNCTIONAL', 'Every answer shows which documents it came from'), R(4, 'PRIVACY', 'Documents are confidential; one company must never see another company’s documents'),
      R(5, 'TRAFFIC', 'About 200 companies, up to 50,000 documents each'), R(6, 'LATENCY', 'Answers within about five seconds'), R(7, 'AI_ML', 'Answers must be grounded in the documents, not invented'), R(8, 'SECURITY', 'Employees sign in with their company’s identity provider'), R(9, 'DATA_RETENTION', 'A company can delete its documents and they must really be removed')],
    drivers: [D(1, 'Strict tenant isolation', 'No cross-company access to documents or answers', 'CRITICAL', [4, 8]), D(2, 'Grounded, cited answers', 'Retrieval from the company’s own documents with citations', 'HIGH', [2, 3, 7]), D(3, 'Document ingestion at scale', 'Mixed file types, up to 50k documents per company', 'HIGH', [1, 5]), D(4, 'Interactive latency', 'About five seconds per answer', 'MEDIUM', [6]), D(5, 'Deletion', 'Removed documents must be removed everywhere', 'MEDIUM', [9])],
    tendencies: [{ label: 'document storage', test: (p) => cats(p, 'OBJECT_STORAGE') }, { label: 'retrieval over document content', test: (p) => cats(p, 'VECTOR_DATABASE', 'SEARCH') }, { label: 'a language model component', test: (p) => cats(p, 'AI_MODEL') }, { label: 'authentication / tenant isolation addressed', test: (p) => cats(p, 'AUTH', 'SECURITY') || p.decisions.some((d) => /tenant/i.test(`${d.title} ${d.decision}`)) }, { label: 'asynchronous ingestion (extraction/chunking)', test: (p) => p.nodes.some((n) => /extract|chunk|ingest|process|worker/i.test(`${n.name} ${n.purpose}`)) }],
    penalties: [{ label: 'Kubernetes / event streaming not asked for', test: (p) => slug(p, /kubernetes|kafka|spark|flink|pulsar/i) }] },
  { name: 'CASE 4 — Large social application', summary: 'A large consumer social app with feeds, posts, media and notifications.',
    requirements: [R(1, 'FUNCTIONAL', 'Users post text, photos and short videos', 'USER_STATED'), R(2, 'FUNCTIONAL', 'Users follow others and see a personalised feed', 'USER_STATED'), R(3, 'FUNCTIONAL', 'Users get notifications about activity on their posts'), R(4, 'TRAFFIC', '20 million registered users, 5 million daily active, feeds read far more than posts are written'), R(5, 'LATENCY', 'The feed must load in under a second'),
      R(6, 'AVAILABILITY', 'The service should be available around the clock; an outage is very costly'), R(7, 'GEOGRAPHY', 'Users are worldwide'), R(8, 'DATA', 'Photos and videos must be stored cheaply and delivered quickly everywhere'), R(9, 'SECURITY', 'Reports of abusive content must be reviewable')],
    drivers: [D(1, 'Read-heavy feed at low latency', 'Millions of feed reads with sub-second load', 'CRITICAL', [4, 5]), D(2, 'Global media storage and delivery', 'Photos/video delivered fast worldwide', 'HIGH', [7, 8]), D(3, 'High availability', 'Outages are very costly', 'HIGH', [6]), D(4, 'Asynchronous fan-out', 'Posts and notifications are processed in the background', 'MEDIUM', [2, 3]), D(5, 'Moderation', 'Abuse reports reviewable', 'MEDIUM', [9])],
    tendencies: [{ label: 'API / application services', test: (p) => cats(p, 'API', 'APPLICATION_SERVICE') }, { label: 'caching for feeds', test: (p) => cats(p, 'CACHE') }, { label: 'asynchronous processing (queue or stream)', test: (p) => cats(p, 'QUEUE', 'EVENT_STREAM', 'STREAM_PROCESSOR', 'BATCH_PROCESSOR') }, { label: 'media/object storage', test: (p) => cats(p, 'OBJECT_STORAGE') }, { label: 'edge/CDN delivery', test: (p) => cats(p, 'EDGE') || p.nodes.some((n) => /cdn|edge/i.test(`${n.name} ${n.technology}`)) }],
    penalties: [{ label: 'a single database/service with no redundancy for a critical component', test: (p) => p.nodes.some((n) => n.criticality === 'CRITICAL' && !n.managedService && !n.configuration.some((c) => /replica|cluster|redundan|failover|multi/i.test(`${c.key} ${c.value}`))) }] },
];

const live = process.env.AI_PROVIDER === 'anthropic';
const deep = process.argv.includes('--deep');
const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
const provider: LLMProvider = live ? new AnthropicLLMProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, defaultModel: model }) : new MockLLMProvider();
const tokens = { in: 0, out: 0, calls: 0 };
const gateway = new LLMGateway({ provider, model: live ? model : 'mock-1', timeoutMs: 240_000, maxRetries: 2, onUsage: (e) => { tokens.in += e.inputTokens ?? 0; tokens.out += e.outputTokens ?? 0; tokens.calls++; } });
const ai = createArchitectureAi(gateway);
const lines: string[] = [];
const say = (s = '') => { console.log(s); lines.push(s); };
const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${Math.round((100 * n) / d)}% (${n}/${d})`);

say(`# Architecture evaluation (${live ? `LIVE: ${model}` : 'MOCK provider: harness smoke test only, NOT a quality evaluation'})`);
say('Metrics are heuristics for comparing runs, not objective scores. Read the designs.\n');
const summary: string[] = [];

for (const c of CASES) {
  say(`\n## ${c.name}\n> ${c.summary}\n`);
  const input: PlanInput = { context: { workspaceId: 'eval', projectId: 'eval', userId: 'eval' }, project: { name: c.name }, brief: { projectSummary: c.summary }, requirements: c.requirements, drivers: c.drivers };
  const requirementTexts = c.requirements.map((r) => ({ code: r.code, category: r.category, statement: r.statement }));
  const ctx = { driverCodes: c.drivers.map((d) => d.code), requirementCodes: c.requirements.map((r) => r.code) };
  const started = Date.now();
  let plan: ArchitecturePlan | null = null; let issues: Array<ArchitectureIssue & { stage: string }> = []; let repairs = 0; let failure = '';
  try {
    const r = await runArchitecturePipeline(ai, { input, ...ctx, requirementTexts }, DEFAULT_PIPELINE_CONFIG);
    plan = r.plan; issues = r.issues; repairs = r.repairs;
  } catch (e) {
    failure = e instanceof PipelineError ? `${e.code}: ${e.message}` : `${(e as { code?: string }).code ?? 'ERROR'}: ${(e as Error).message}`;
    if (e instanceof PipelineError) issues = e.issues;
  }
  say(`Run: ${failure ? `FAILED (${failure})` : 'succeeded'} · ${Math.round((Date.now() - started) / 1000)}s · repairs=${repairs}`);
  if (!plan) { summary.push(`${c.name}: FAILED ${failure}`); continue; }

  const structural = validateArchitectureStructure(plan, ctx);
  const driverCovered = c.drivers.filter((d) => plan!.decisions.some((x) => x.driverCodes.includes(d.code)));
  const reqCovered = c.requirements.filter((r) => plan!.decisions.some((x) => x.requirementCodes.includes(r.code) || x.driverCodes.some((dc) => c.drivers.find((d) => d.code === dc)?.requirementCodes.includes(r.code))));
  const accepted = plan.decisions.filter((d) => d.status === 'ACCEPTED');
  const withDriver = accepted.filter((d) => d.driverCodes.length > 0);
  const cx = computeComplexity(plan);
  const finalIssues = issues.filter((i) => i.stage === 'FINAL');
  const bySev = (s: string) => finalIssues.filter((i) => i.severity === s).length;
  const metrics = {
    'schema validity': 'valid (required for success)', 'structural integrity': structural.length === 0 ? 'clean' : `${structural.length} issue(s): ${structural.map((i) => i.code).join(', ')}`,
    'driver coverage': pct(driverCovered.length, c.drivers.length), 'requirement coverage (direct or via driver)': pct(reqCovered.length, c.requirements.length),
    'decision traceability (accepted decisions with a driver)': pct(withDriver.length, accepted.length), 'orphan components': String(structural.filter((i) => i.code === 'ORPHAN_NODE').length),
    'decisions without a driver': String(accepted.length - withDriver.length), 'complexity heuristic': `${cx.label} (score ${cx.score}: ${cx.nodes} components, ${cx.edges} connections, ${cx.heavyweight} heavyweight)`,
    'final review findings': `CRITICAL ${bySev('CRITICAL')} · HIGH ${bySev('HIGH')} · MEDIUM ${bySev('MEDIUM')} · LOW ${bySev('LOW')}`, 'decisions with alternatives': pct(plan.decisions.filter((d) => d.alternatives.length > 0).length, plan.decisions.length),
  };
  say('### Metrics'); for (const [k, v] of Object.entries(metrics)) say(`- ${k}: ${v}`);
  say('\n### Tendency checks (things worth looking for; absence is a prompt to look, not a verdict)');
  for (const t of c.tendencies) say(`- [${t.test(plan) ? 'present' : 'ABSENT '}] ${t.label}`);
  for (const t of c.penalties) say(`- [${t.test(plan) ? 'FLAGGED' : 'ok     '}] ${t.label}`);

  say(`\n### Design: ${plan.summary}`);
  say('Components:'); for (const n of plan.nodes) say(`- ${n.stableKey} [${n.category} · ${n.criticality}] ${n.name} = ${n.technology}${n.managedService ? ` (managed${n.provider ? `, ${n.provider}` : ''})` : ''} — ${n.purpose}`);
  say('Connections:'); for (const e of plan.edges) say(`- ${e.sourceStableKey} -> ${e.targetStableKey} [${e.communicationType} · ${e.protocol}${e.encrypted === false ? ' · UNENCRYPTED' : ''}] ${e.dataDescription}`);
  say('Decisions:');
  for (const d of plan.decisions) {
    say(`- ${d.key.toUpperCase()} [${d.status}] ${d.title}  (drivers: ${d.driverCodes.join(', ') || 'none'}; requirements: ${d.requirementCodes.join(', ') || 'none'}; components: ${d.nodeStableKeys.join(', ')})`);
    if (deep) { say(`    why: ${d.rationale}`); for (const a of d.alternatives) say(`    alternative ${a.technology}: ${a.reasoning}`); for (const t of d.tradeoffs) say(`    trade-off: ${t}`); }
  }
  if (plan.unresolvedQuestions.length) say(`Unresolved questions: ${plan.unresolvedQuestions.join(' | ')}`);
  if (finalIssues.length) { say('Remaining review findings:'); for (const i of finalIssues) say(`- [${i.severity} · ${i.category} · ${i.source}] ${i.description}`); }
  summary.push(`${c.name}: ${plan.nodes.length} components, ${plan.decisions.length} decisions, ${cx.label} complexity, driver coverage ${pct(driverCovered.length, c.drivers.length)}, repairs ${repairs}`);
}
say('\n## Summary'); for (const s of summary) say(`- ${s}`);
say(`Model calls: ${tokens.calls} · tokens ${tokens.in} in / ${tokens.out} out`);
say('\n## HUMAN REVIEW CHECKLIST (the part that matters)');
say('1. Requirement alignment: does each requirement visibly shape a component or decision? Is anything stated simply ignored?');
say('2. Complexity: is any technology there without a driver? For CASE 2 especially, anything beyond a web app, API and database needs strong justification.');
say('3. Traceability: do the cited drivers and requirements actually cause each decision, or are the links decorative?');
say('4. Technology justification: are rationales and alternatives specific to THIS project, or generic ("scalable", "popular")?');
say('5. Missing components: authentication, observability, backups, tenant isolation, media delivery, where the requirements call for them.');
say('6. Unnecessary technologies: kubernetes, event streaming, big-data engines that no requirement needs.');
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
if (out) writeFileSync(out, lines.join('\n') + '\n');
