/**
 * Architecture-change evaluation. For four reference architectures it runs the REAL change analyzer, then the REAL change planner, applies the
 * planner's operations with the same deterministic applier the product uses, diffs the result, and prints everything for HUMAN review.
 *
 *   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run eval:change            # summaries + checks
 *   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run eval:change -- --deep  # + every impact note and operation
 *
 * With the default mock provider this only smoke-tests the harness: mock output says NOTHING about quality.
 * Checks are heuristics that point at things worth reading; they are not scores. Read the proposals.
 */
import { writeFileSync } from 'node:fs';
import { AnthropicLLMProvider, LLMGateway, MockLLMProvider, createChangeAi, type LLMProvider } from '@pitch2plan/ai';
import { planToDiffInput } from '@pitch2plan/domain';
import { applyChangeOperations, architecturePlanSchema, diffArchitectures, validateChangeAnalysis, type ArchitecturePlan, type ChangeAnalysis } from '@pitch2plan/schemas';

type FNode = { stableKey: string; name: string; technology: string; slug: string; category: string; criticality?: string; provider?: string | null; managed?: boolean; model?: string; purpose: string; config?: Array<{ key: string; value: string }> };
type FEdge = [string, string, string, string, string, string]; // source, target, protocol, communicationType, data, id
type FDec = { key: string; title: string; decision: string; rationale: string; nodes: string[]; drivers: string[]; reqs: string[] };
interface Fixture { summary: string; nodes: FNode[]; edges: FEdge[]; decisions: FDec[]; requirements: Array<{ code: string; category: string; statement: string; origin: string }>; drivers: Array<{ code: string; name: string; description: string; priority: string }> }
const REQ = (n: number, category: string, statement: string) => ({ code: `REQ-${String(n).padStart(3, '0')}`, category, statement, origin: 'USER_ANSWERED' });
const DRV = (n: number, name: string, description: string, priority: string) => ({ code: `DRV-${String(n).padStart(3, '0')}`, name, description, priority });

const toPlan = (f: Fixture): ArchitecturePlan => architecturePlanSchema.parse({
  summary: f.summary, assumptions: [], unresolvedQuestions: [], risks: [],
  nodes: f.nodes.map((n) => ({ stableKey: n.stableKey, name: n.name, technology: n.technology, technologySlug: n.slug, category: n.category, purpose: n.purpose, description: `${n.name} in this architecture.`, criticality: n.criticality ?? 'MEDIUM', managedService: n.managed ?? true, provider: n.provider === undefined ? 'AWS' : n.provider, deploymentModel: n.model ?? (n.managed === false ? 'CONTAINER' : 'MANAGED_SERVICE'), configuration: n.config ?? [], risks: [], alternatives: [], replacesStableKey: null })),
  edges: f.edges.map(([s, t, protocol, communicationType, data, id]) => ({ id, sourceStableKey: s, targetStableKey: t, label: `${s} to ${t}`, protocol, communicationType, dataDescription: data, synchronous: communicationType === 'REQUEST_RESPONSE', encrypted: true, criticality: 'MEDIUM' })),
  decisions: f.decisions.map((d) => ({ key: d.key, title: d.title, problem: `The architecture needs a choice about: ${d.title}.`, decision: d.decision, rationale: d.rationale.length >= 20 ? d.rationale : `${d.rationale} This is the agreed reasoning for the decision.`, status: 'ACCEPTED', tradeoffs: [], risks: [], alternatives: [], consequences: [], confidence: 0.8, driverCodes: d.drivers, requirementCodes: d.reqs, nodeStableKeys: d.nodes, edgeIds: [], supersedesKey: null })),
});
const view = (f: Fixture) => ({
  requirements: f.requirements, drivers: f.drivers,
  architecture: { summary: f.summary, assumptions: [] as string[], risks: [] as Array<{ text: string; severity: string; nodeStableKeys: string[] }>,
    nodes: f.nodes.map((n) => ({ stableKey: n.stableKey, name: n.name, technology: n.technology, technologySlug: n.slug, category: n.category, criticality: n.criticality ?? 'MEDIUM', deploymentModel: n.model ?? (n.managed === false ? 'CONTAINER' : 'MANAGED_SERVICE'), purpose: n.purpose, description: `${n.name} in this architecture.`, provider: n.provider === undefined ? 'AWS' : n.provider, managedService: n.managed ?? true, configuration: n.config ?? [], risks: [] as string[], alternatives: [] as Array<{ technology: string; reasoning: string }> })),
    edges: f.edges.map(([source, target, protocol, communicationType, dataDescription, id]) => ({ id, source, target, label: `${source} to ${target}`, protocol, communicationType, dataDescription, encrypted: true })),
    decisions: f.decisions.map((d) => ({ key: d.key, title: d.title, status: 'ACCEPTED', decision: d.decision, rationale: d.rationale, nodeStableKeys: d.nodes, driverCodes: d.drivers, requirementCodes: d.reqs })) },
});

const SAAS: Fixture = { summary: 'A web app and API with one managed PostgreSQL database and an external email provider.', nodes: [
  { stableKey: 'web-app', name: 'Web app', technology: 'Next.js', slug: 'nextjs', category: 'CLIENT', provider: 'Vercel', criticality: 'HIGH', purpose: 'Booking pages for trainers and clients.' },
  { stableKey: 'api', name: 'API', technology: 'Next.js route handlers', slug: 'nextjs-api', category: 'API', provider: 'Vercel', criticality: 'HIGH', purpose: 'Business logic for availability and bookings.' },
  { stableKey: 'primary-database', name: 'Primary database', technology: 'Managed PostgreSQL', slug: 'managed-postgresql', category: 'DATABASE', criticality: 'CRITICAL', purpose: 'Stores trainers, availability, clients and bookings with relational integrity.', config: [{ key: 'backups', value: 'daily, 7 day retention' }] },
  { stableKey: 'email-provider', name: 'Email provider', technology: 'SendGrid', slug: 'sendgrid', category: 'EXTERNAL_SERVICE', provider: 'SendGrid', managed: false, model: 'EXTERNAL', purpose: 'Sends reminder emails.' }],
  edges: [['web-app', 'api', 'HTTPS', 'REQUEST_RESPONSE', 'Booking requests', 'web-api'], ['api', 'primary-database', 'TLS', 'REQUEST_RESPONSE', 'Booking records', 'api-db'], ['api', 'email-provider', 'HTTPS', 'REQUEST_RESPONSE', 'Reminder emails', 'api-email']],
  decisions: [{ key: 'adr-001', title: 'Use managed PostgreSQL', decision: 'Use a managed PostgreSQL database.', rationale: 'Relational bookings with integrity; small team, no database operations.', nodes: ['primary-database'], drivers: ['DRV-001'], reqs: ['REQ-001', 'REQ-005'] }, { key: 'adr-002', title: 'One API, no separate services', decision: 'Keep a single API.', rationale: 'Scale is modest.', nodes: ['api'], drivers: ['DRV-001'], reqs: ['REQ-003'] }, { key: 'adr-003', title: 'External email for reminders', decision: 'Use SendGrid.', rationale: 'Do not build email delivery.', nodes: ['email-provider', 'api'], drivers: ['DRV-002'], reqs: ['REQ-002'] }],
  requirements: [REQ(1, 'FUNCTIONAL', 'Trainers publish availability and clients book sessions'), REQ(2, 'FUNCTIONAL', 'Clients get a reminder email before a session'), REQ(3, 'TRAFFIC', 'About 500 trainers and 10,000 bookings a month'), REQ(4, 'BUDGET', 'Keep running costs as low as possible'), REQ(5, 'TEAM_CONSTRAINT', 'One or two developers')],
  drivers: [DRV(1, 'Simple to build and operate', 'Tiny team, modest scale', 'CRITICAL'), DRV(2, 'Low running cost', 'Budget is tight', 'HIGH')] };

const STREAM: Fixture = { summary: 'Producers publish to Apache Kafka on Amazon MSK; a processor enriches events and stores them in S3.', nodes: [
  { stableKey: 'event-producers', name: 'Transaction services', technology: 'Existing services', slug: 'existing-services', category: 'APPLICATION_SERVICE', provider: null, managed: false, model: 'OTHER', purpose: 'Emit transaction events.' },
  { stableKey: 'event-stream', name: 'Event stream', technology: 'Apache Kafka (Amazon MSK)', slug: 'apache-kafka-msk', category: 'EVENT_STREAM', criticality: 'CRITICAL', purpose: 'Durable event backbone with replay and several consumers.', config: [{ key: 'retention', value: '7 days' }, { key: 'replication factor', value: '3' }, { key: 'authentication', value: 'IAM or mutual TLS' }] },
  { stableKey: 'stream-processor', name: 'Stream processor', technology: 'ECS service consuming from Kafka', slug: 'ecs-consumer', category: 'STREAM_PROCESSOR', criticality: 'HIGH', managed: false, purpose: 'Enriches and routes events.' },
  { stableKey: 'analytics-storage', name: 'Analytics storage', technology: 'Amazon S3', slug: 'amazon-s3', category: 'OBJECT_STORAGE', purpose: 'Durable processed data.', config: [{ key: 'encryption', value: 'SSE-KMS' }] }],
  edges: [['event-producers', 'event-stream', 'TLS', 'EVENT', 'Transaction events', 'producers-stream'], ['event-stream', 'stream-processor', 'TLS', 'EVENT', 'Transaction events', 'stream-processor-in'], ['stream-processor', 'analytics-storage', 'HTTPS', 'BATCH', 'Processed records', 'processor-storage']],
  decisions: [{ key: 'adr-001', title: 'Use Kafka as the durable event backbone with 7 day replay', decision: 'Use Apache Kafka on Amazon MSK with 7 day retention and replication factor 3.', rationale: 'No event loss, replay for fixes, several independent consumers.', nodes: ['event-stream'], drivers: ['DRV-001', 'DRV-002'], reqs: ['REQ-001', 'REQ-003', 'REQ-005'] }, { key: 'adr-002', title: 'Encrypt in transit and at rest', decision: 'TLS everywhere, SSE-KMS on S3.', rationale: 'Financial data.', nodes: ['event-stream', 'analytics-storage'], drivers: ['DRV-003'], reqs: ['REQ-004'] }],
  requirements: [REQ(1, 'TRAFFIC', 'About 50 million events per day with 5x peaks'), REQ(2, 'LATENCY', 'Results within a few seconds'), REQ(3, 'DATA', 'Events replayable for 7 days'), REQ(4, 'SECURITY', 'Transaction data is sensitive financial data'), REQ(5, 'AVAILABILITY', 'Losing events is unacceptable')],
  drivers: [DRV(1, 'High-volume durable ingestion', '50M/day, no loss', 'CRITICAL'), DRV(2, 'Replay and multiple consumers', '7 day replay', 'HIGH'), DRV(3, 'Sensitive data', 'Encrypt and restrict', 'HIGH')] };

const DOCS: Fixture = { summary: 'Uploads go to S3; a worker embeds text into pgvector; the API retrieves passages and calls the Anthropic API; SSO via a managed identity provider.', nodes: [
  { stableKey: 'web-app', name: 'Web app', technology: 'React', slug: 'react', category: 'CLIENT', criticality: 'HIGH', purpose: 'Upload and ask.' },
  { stableKey: 'api', name: 'API', technology: 'Python FastAPI on ECS', slug: 'fastapi-ecs', category: 'API', criticality: 'HIGH', managed: false, purpose: 'Retrieval and answer orchestration.' },
  { stableKey: 'primary-database', name: 'Database with vectors', technology: 'Amazon RDS PostgreSQL with pgvector', slug: 'rds-pgvector', category: 'DATABASE', criticality: 'CRITICAL', purpose: 'Chunks, embeddings, tenants.' },
  { stableKey: 'identity-provider', name: 'Identity provider', technology: 'Managed OIDC provider', slug: 'auth0', category: 'AUTH', provider: 'Auth0', criticality: 'HIGH', purpose: 'Company single sign-on.' },
  { stableKey: 'llm', name: 'Language model', technology: 'Anthropic API', slug: 'anthropic-api', category: 'AI_MODEL', provider: 'Anthropic', managed: false, model: 'EXTERNAL', criticality: 'HIGH', purpose: 'Generates cited answers from retrieved passages.' }],
  edges: [['web-app', 'api', 'HTTPS', 'REQUEST_RESPONSE', 'Questions and uploads', 'web-api'], ['api', 'primary-database', 'TLS', 'REQUEST_RESPONSE', 'Passages', 'api-db'], ['api', 'llm', 'HTTPS', 'REQUEST_RESPONSE', 'Prompts and answers', 'api-llm'], ['web-app', 'identity-provider', 'HTTPS', 'REQUEST_RESPONSE', 'Sign-in', 'web-idp']],
  decisions: [{ key: 'adr-001', title: 'Row-level tenant isolation', decision: 'Scope every query and object key by company id.', rationale: 'No cross-company access.', nodes: ['api', 'primary-database'], drivers: ['DRV-001'], reqs: ['REQ-003'] }, { key: 'adr-002', title: 'Answer with the Anthropic API using retrieved passages and citations', decision: 'Call the Anthropic API with retrieved passages and require citations.', rationale: 'Grounded, cited answers.', nodes: ['llm', 'api'], drivers: ['DRV-002'], reqs: ['REQ-002', 'REQ-007'] }],
  requirements: [REQ(2, 'FUNCTIONAL', 'Answers cite their source documents'), REQ(3, 'PRIVACY', 'One company must never see another company\u2019s documents'), REQ(4, 'LATENCY', 'Answers within five seconds'), REQ(7, 'AI_ML', 'Answers must be grounded in the documents')],
  drivers: [DRV(1, 'Strict tenant isolation', 'No cross-company access', 'CRITICAL'), DRV(2, 'Grounded, cited answers', 'Retrieval with citations', 'HIGH')] };

const COMMERCE: Fixture = { summary: 'API gateway in front of order and payment services over Amazon MSK, with per-service PostgreSQL.', nodes: [
  { stableKey: 'api-gateway', name: 'API gateway', technology: 'Amazon API Gateway', slug: 'api-gateway', category: 'API', criticality: 'CRITICAL', purpose: 'Single public entry point.' },
  { stableKey: 'order-service', name: 'Order service', technology: 'ECS service', slug: 'ecs-order', category: 'APPLICATION_SERVICE', criticality: 'HIGH', managed: false, purpose: 'Takes and tracks orders.' },
  { stableKey: 'payment-service', name: 'Payment service', technology: 'ECS service', slug: 'ecs-payment', category: 'APPLICATION_SERVICE', criticality: 'CRITICAL', managed: false, purpose: 'Charges payments.' },
  { stableKey: 'event-bus', name: 'Event bus', technology: 'Amazon MSK', slug: 'amazon-msk', category: 'EVENT_STREAM', criticality: 'CRITICAL', purpose: 'Events between services.', config: [{ key: 'replication factor', value: '3 (single region)' }] },
  { stableKey: 'orders-db', name: 'Orders database', technology: 'Amazon RDS PostgreSQL', slug: 'rds-postgres', category: 'DATABASE', criticality: 'CRITICAL', purpose: 'Orders.', config: [{ key: 'availability', value: 'multi-AZ, single region' }] }],
  edges: [['api-gateway', 'order-service', 'HTTPS', 'REQUEST_RESPONSE', 'Orders', 'gw-order'], ['order-service', 'event-bus', 'TLS', 'EVENT', 'Order events', 'order-bus'], ['event-bus', 'payment-service', 'TLS', 'EVENT', 'Order events', 'bus-payment'], ['order-service', 'orders-db', 'TLS', 'REQUEST_RESPONSE', 'Orders', 'order-db']],
  decisions: [{ key: 'adr-001', title: 'Event-driven services over a durable bus', decision: 'Services communicate through MSK events.', rationale: 'Independent scaling and failure isolation.', nodes: ['event-bus', 'order-service', 'payment-service'], drivers: ['DRV-001'], reqs: ['REQ-003'] }, { key: 'adr-002', title: 'Single-region, multi-AZ deployment', decision: 'Run in one AWS region across availability zones.', rationale: 'Simplicity.', nodes: ['orders-db', 'event-bus', 'api-gateway'], drivers: ['DRV-003'], reqs: ['REQ-002'] }],
  requirements: [REQ(1, 'TRAFFIC', '20,000 orders per hour at peak'), REQ(2, 'AVAILABILITY', '99.95% availability within one region'), REQ(3, 'SCALABILITY', 'Services scale independently')],
  drivers: [DRV(1, 'Independent scaling', 'Separate services', 'HIGH'), DRV(3, 'Availability', 'Survive a zone failing', 'HIGH')] };

interface Case { name: string; request: string; fixture: Fixture; expects: string; checks: Array<{ label: string; test: (a: ChangeAnalysis, text: string, ops: string[]) => boolean }>; }
const allText = (a: ChangeAnalysis) => JSON.stringify(a).toLowerCase();
const CASES: Case[] = [
  { name: 'CASE 1 — Simple SaaS: PostgreSQL to DynamoDB', request: 'Replace PostgreSQL with DynamoDB.', fixture: SAAS, expects: 'Significant DATA-MODEL consequences (relational integrity, access patterns, queries), not just a swap.',
    checks: [{ label: 'the database component is directly affected', test: (a) => a.affectedNodes.some((n) => n.key === 'primary-database' && n.relation === 'DIRECT') }, { label: 'explains data-model / access-pattern consequences', test: (_a, t) => /data.?model|access pattern|relational|join|schema|query|transaction|integrity/.test(t) }, { label: 'migration impact is not NEUTRAL', test: (a) => a.migrationImpact.direction !== 'NEUTRAL' }, { label: 'a cost-driven small-team context is respected (recommendation is not blindly PROCEED)', test: (a) => a.recommendation.verdict !== 'PROCEED' }] },
  { name: 'CASE 2 — Streaming platform: Kafka to Kinesis', request: 'Replace Kafka with AWS Kinesis.', fixture: STREAM, expects: 'Producer, consumer, retention, monitoring, IAM and implementation impact.',
    checks: [{ label: 'the event stream is directly affected', test: (a) => a.affectedNodes.some((n) => n.key === 'event-stream' && n.relation === 'DIRECT') }, { label: 'producers and the processor are at least potentially affected', test: (a) => ['event-producers', 'stream-processor'].every((k) => a.affectedNodes.some((n) => n.key === k) || a.affectedEdges.length > 0) }, { label: 'mentions retention / replay', test: (_a, t) => /retention|replay/.test(t) }, { label: 'mentions IAM / authentication / security', test: (_a, t) => /iam|authenticat|credential|security/.test(t) }, { label: 'mentions monitoring', test: (_a, t) => /monitor|metric|lag|alarm|cloudwatch/.test(t) }, { label: 'mentions shards / throughput / partitions', test: (_a, t) => /shard|throughput|partition/.test(t) }] },
  { name: 'CASE 3 — Document AI: Anthropic to Azure OpenAI', request: 'Use Azure OpenAI instead of Anthropic.', fixture: DOCS, expects: 'Model integration, credentials, data handling, provider-specific impacts; NOT a redesign of everything.',
    checks: [{ label: 'the model component is directly affected', test: (a) => a.affectedNodes.some((n) => n.key === 'llm' && n.relation === 'DIRECT') }, { label: 'mentions credentials / keys / authentication', test: (_a, t) => /credential|api key|authenticat|secret|managed identity/.test(t) }, { label: 'mentions data handling / residency / privacy', test: (_a, t) => /data.?handling|residency|privacy|retention|compliance|region/.test(t) }, { label: 'does NOT over-reach: at most 2 components directly affected', test: (a) => a.affectedNodes.filter((n) => n.relation === 'DIRECT').length <= 2 }, { label: 'does NOT over-reach: at most 8 operations', test: (_a, _t, ops) => ops.length <= 8 }, { label: 'tenant isolation / the database is NOT marked directly affected', test: (a) => !a.affectedNodes.some((n) => n.key === 'primary-database' && n.relation === 'DIRECT') }] },
  { name: 'CASE 4 — Commerce platform: make it multi-region', request: 'Make the system multi-region.', fixture: COMMERCE, expects: 'Recognised as a MAJOR change and a REQUIREMENT change (availability), needing reconfirmation.',
    checks: [{ label: 'classified as a requirement change', test: (a) => a.changeType === 'REQUIREMENT_CHANGE' }, { label: 'proposes at least one requirement change', test: (a) => a.requirementChanges.length > 0 }, { label: 'several components are directly affected', test: (a) => a.affectedNodes.filter((n) => n.relation === 'DIRECT').length >= 2 }, { label: 'mentions replication / failover / data consistency', test: (_a, t) => /replicat|failover|consisten|latency|cross.?region|active/.test(t) }, { label: 'recommendation is cautious', test: (a) => a.recommendation.verdict !== 'PROCEED' }] },
];

const live = process.env.AI_PROVIDER === 'anthropic'; const deep = process.argv.includes('--deep'); const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
const provider: LLMProvider = live ? new AnthropicLLMProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, defaultModel: model }) : new MockLLMProvider();
const tokens = { in: 0, out: 0, calls: 0 };
const ai = createChangeAi(new LLMGateway({ provider, model: live ? model : 'mock-1', timeoutMs: 240_000, maxRetries: 2, onUsage: (e) => { tokens.in += e.inputTokens ?? 0; tokens.out += e.outputTokens ?? 0; tokens.calls++; } }));
const lines: string[] = []; const say = (s = '') => { console.log(s); lines.push(s); };
const MONEY = /\$\s?\d|\b\d[\d,.]*\s?(usd|dollars|eur|per month|\/month|a month)\b|\b\d+\s?%\s?(cheaper|more expensive|savings)/i;

say(`# Change evaluation (${live ? `LIVE: ${model}` : 'MOCK provider: harness smoke test only, NOT a quality evaluation'})`);
say('Checks are heuristics that point at things worth reading, not scores. Read the proposals.\n');
const summary: string[] = [];
for (const c of CASES) {
  say(`\n## ${c.name}\n> Request: "${c.request}"\n> Expected: ${c.expects}\n`);
  const ctx = { workspaceId: 'eval', projectId: 'eval', userId: 'eval' }; const v = view(c.fixture);
  let analysis: ChangeAnalysis | null = null; const started = Date.now();
  try {
    const out = await ai.analyze({ context: ctx, requestedChange: c.request, reason: null, ...v, plan: null });
    analysis = out.output;
  } catch (e) { say(`ANALYSIS FAILED: ${(e as { code?: string }).code ?? 'ERROR'}: ${(e as Error).message}`); summary.push(`${c.name}: analysis FAILED`); continue; }
  const a = analysis; const text = allText(a);
  const base = toPlan(c.fixture);
  const bad = validateChangeAnalysis(a, { nodeKeys: c.fixture.nodes.map((n) => n.stableKey), edgeIds: c.fixture.edges.map((e) => e[5]), decisionKeys: c.fixture.decisions.map((d) => d.key), driverCodes: c.fixture.drivers.map((d) => d.code), requirementCodes: c.fixture.requirements.map((r) => r.code), taskKeys: [] });
  say(`Analysis (${Math.round((Date.now() - started) / 1000)}s): ${a.changeType} · recommendation ${a.recommendation.verdict} · confidence ${Math.round(a.confidence * 100)}%${bad.length ? ` · REFERENCE PROBLEMS: ${bad.join(' | ')}` : ''}`);
  say(`Summary: ${a.summary}`); for (const w of a.whatChanges) say(`  changes: ${w}`); for (const w of a.whatStaysTheSame.slice(0, 3)) say(`  stays: ${w}`);
  say(`Affected: ${a.affectedNodes.map((n) => `${n.key}(${n.relation[0]})`).join(', ') || 'none'} | decisions ${a.affectedDecisions.map((d) => d.key).join(', ') || 'none'} | requirements ${a.affectedRequirements.map((r) => r.key).join(', ') || 'none'}`);
  const impacts = { performance: a.performanceImpact, security: a.securityImpact, reliability: a.reliabilityImpact, cost: a.costImpact, complexity: a.complexityImpact, operational: a.operationalImpact, migration: a.migrationImpact, implementation: a.implementationImpact };
  say(`Trade-offs: ${Object.entries(impacts).map(([k, i]) => `${k} ${i.direction}`).join(' · ')}`); if (deep) for (const [k, i] of Object.entries(impacts)) say(`    ${k}: ${i.notes}`);
  if (a.requirementChanges.length) for (const r of a.requirementChanges) say(`  REQUIREMENT CHANGE (${r.kind}, ${r.category}): ${r.statement}`);
  for (const r of a.newRisks.slice(0, deep ? 8 : 3)) say(`  new risk [${r.severity}]: ${r.text}`); for (const w of a.newWork.slice(0, deep ? 15 : 4)) say(`  new work: ${w}`); for (const w of a.reusableWork.slice(0, deep ? 15 : 3)) say(`  reusable: ${w}`);
  say(`Recommendation: ${a.recommendation.rationale}`);

  let ops: string[] = []; let diffSentences: string[] = []; let applyErrors: string[] = [];
  try {
    const planned = await ai.plan({ context: ctx, requestedChange: c.request, analysis: a, basePlan: base, ...v });
    ops = planned.output.operations.map((o) => `${o.op}${'stableKey' in o ? ` ${o.stableKey}` : 'key' in o ? ` ${o.key}` : ''}`);
    const applied = applyChangeOperations(base, planned.output); applyErrors = applied.errors;
    diffSentences = diffArchitectures(planToDiffInput(base), planToDiffInput(applied.plan)).summary.sentences;
    say(`\nChange plan: ${planned.output.summary}`); for (const o of ops) say(`  op: ${o}`);
    say(`Applied by the deterministic applier: ${applyErrors.length ? `ERRORS: ${applyErrors.join(' | ')}` : 'no errors'}`); say(`Resulting diff: ${diffSentences.join('; ') || 'no differences'}`);
    if (deep) for (const o of planned.output.operations) say(`    ${JSON.stringify(o).slice(0, 400)}`);
  } catch (e) { say(`CHANGE PLAN FAILED: ${(e as { code?: string }).code ?? 'ERROR'}: ${(e as Error).message}`); }

  say('\n### Checks (look at the ones marked MISSING)');
  const results = c.checks.map((k) => ({ label: k.label, ok: k.test(a, text, ops) }));
  for (const r of results) say(`- [${r.ok ? 'ok     ' : 'MISSING'}] ${r.label}`);
  const money = MONEY.test(JSON.stringify([a.costImpact, a.implementationImpact, a.migrationImpact])); say(`- [${money ? 'FLAGGED' : 'ok     '}] no invented cost figures (pricing data is not available)`);
  say(`- [${applyErrors.length ? 'FLAGGED' : 'ok     '}] the planner's operations apply cleanly`);
  summary.push(`${c.name}: ${a.changeType}, ${a.recommendation.verdict}, ${results.filter((r) => r.ok).length}/${results.length} checks${money ? ', COST FIGURES FLAGGED' : ''}${applyErrors.length ? ', APPLY ERRORS' : ''}`);
}
say('\n## Summary'); for (const s of summary) say(`- ${s}`); say(`Model calls: ${tokens.calls} · tokens ${tokens.in} in / ${tokens.out} out`);
say('\n## HUMAN REVIEW CHECKLIST (the part that matters)');
say('1. Is every affected component, decision and requirement real, and is anything important missing?');
say('2. Does the analysis explain the CONSEQUENCES (data model, retention, IAM, credentials, data handling), or just restate the request?');
say('3. Is the change proportionate? CASE 3 must not become a redesign; CASE 4 must be recognised as major and as a requirement change.');
say('4. Are the trade-offs honest and qualitative, with no invented prices or percentages?');
say('5. Would the resulting operations leave the architecture coherent (edges, decisions, technology), and is the diff what you would expect?');
const out = process.argv.find((x) => x.startsWith('--out='))?.slice(6); if (out) writeFileSync(out, lines.join('\n') + '\n');
