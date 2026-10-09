/**
 * Grounding evaluation. Two stages, both printed for HUMAN review and written to JSON:
 *
 *   1. RETRIEVAL: for each case, does the indexed official documentation surface the right page, and does an off-topic question surface NOTHING?
 *   2. ANSWER GROUNDING (with --answers): the real assistant model is shown the retrieved documents; the server-side validators
 *      (validateClaims / deriveGrounding, the same code the product uses) then decide what is grounded. The report shows where the model's own
 *      labels were downgraded, which is the number to watch: a model that over-claims is caught here, not trusted.
 *
 *   npm run eval:grounding -- --fixtures              # OFFLINE smoke test: fixture pages + mock model. Proves the harness, says NOTHING about real quality.
 *   npm run eval:grounding                            # LIVE retrieval: fetches the real allow-listed vendor pages (needs outbound HTTPS).
 *   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run eval:grounding -- --answers   # + real model answers
 *
 * Needs DATABASE_URL (migrated). It indexes into that database: use a scratch database for --fixtures, which TRUNCATES knowledge tables.
 * The cases below are a small, hand-written set; passing them is evidence, not proof.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AnthropicLLMProvider, HashingEmbeddingProvider, IdeaInterpreter, LLMGateway, MockLLMProvider, createArchitectureAi, createAssistantAi, createChangeAi, createDiscoveryAi, createImplementationAi } from '@pitch2plan/ai';
import { createPrismaClient, createRepositories } from '@pitch2plan/db';
import { FixtureDocumentFetcher, HttpDocumentFetcher, createApplication, noopLogger, type DocumentFetcher, type JobQueue } from '@pitch2plan/domain';
import { DelimiterSplitter, assistantExtrasSchema, deriveGrounding, renderDocuments, validateClaims, type GroundingStatus } from '@pitch2plan/schemas';

const args = new Set(process.argv.slice(2));
const FIXTURES = args.has('--fixtures'); const ANSWERS = args.has('--answers');
const OUT = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? '/mnt/user-data/outputs/verification/eval-grounding.json';
const url = process.env.DATABASE_URL; if (!url) throw new Error('DATABASE_URL is required');

interface Case { name: string; technologies: Array<{ slug: string; provider?: string; version?: string; managedService?: boolean; name?: string }>; question: string; expectUrl?: string; expectNone?: boolean }
const CASES: Case[] = [
  { name: 'MSK: authenticate a Java client', technologies: [{ slug: 'aws-msk', provider: 'AWS', managedService: true }], question: 'How should my Java service authenticate to Kafka?', expectUrl: 'iam-access-control' },
  { name: 'RDS: backups', technologies: [{ slug: 'aws-rds', provider: 'AWS', managedService: true, version: '16' }, { slug: 'postgresql' }], question: 'How should I configure backups?', expectUrl: 'USER_WorkingWithAutomatedBackups' },
  { name: 'S3: encryption at rest', technologies: [{ slug: 'aws-s3', provider: 'AWS', managedService: true }], question: 'How do I encrypt objects at rest?', expectUrl: 'UsingEncryption' },
  { name: 'Kubernetes: expose a service', technologies: [{ slug: 'kubernetes' }], question: 'How do I expose this service outside the cluster?', expectUrl: 'services-networking/service' },
  { name: 'Anthropic: credential handling', technologies: [{ slug: 'anthropic-api', provider: 'Anthropic' }], question: 'How should API credentials be handled?', expectUrl: 'api/overview' },
  { name: 'OFF-TOPIC: MSK autoscaling by CPU', technologies: [{ slug: 'aws-msk', provider: 'AWS', managedService: true }], question: 'How do I configure autoscaling of consumer instances based on CPU?', expectNone: true },
  { name: 'OFF-TOPIC: generic question', technologies: [{ slug: 'aws-msk', provider: 'AWS', managedService: true }], question: 'What is the best way to do this?', expectNone: true },
];

const queued: string[] = [];
const queue: JobQueue = { async enqueue(_n, p) { queued.push(p.runId); return `job-${queued.length}`; } };
const prisma = createPrismaClient(url); const repos = createRepositories(prisma);
const provider = FIXTURES || process.env.AI_PROVIDER !== 'anthropic' ? new MockLLMProvider() : new AnthropicLLMProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, defaultModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5' });
const gateway = new LLMGateway({ provider, model: process.env.ANTHROPIC_MODEL ?? 'mock-1', timeoutMs: 120_000, maxRetries: 0, onUsage: async () => undefined });
const fetcher: DocumentFetcher = FIXTURES ? new FixtureDocumentFetcher({ allow: true }) : new HttpDocumentFetcher();
const assistantAi = createAssistantAi(gateway);
const app = createApplication({ repos, interpreter: new IdeaInterpreter(gateway), discoveryAi: createDiscoveryAi(gateway), architectureAi: createArchitectureAi(gateway), implementationAi: createImplementationAi(gateway), assistantAi, changeAi: createChangeAi(gateway), queue, logger: noopLogger, fetcher, embedder: new HashingEmbeddingProvider() });

if (FIXTURES) await prisma.$executeRawUnsafe('TRUNCATE "KnowledgeSource" CASCADE');
const slugs = [...new Set(CASES.flatMap((c) => c.technologies.map((t) => t.slug)))];
await app.knowledge.ensureIndexed(slugs);
for (const runId of queued.splice(0)) { const r = await app.knowledge.runIngestion(runId); console.log(`ingest ${runId.slice(0, 8)} → ${r.outcome}`); }

interface Result { name: string; pass: boolean; topUrl: string | null; selected: number; note: string; answer?: { modelClaims: number; downgraded: number; status: GroundingStatus; reasons: string[]; flag: string | null } }
const results: Result[] = [];
for (const c of CASES) {
  const r = await app.knowledge.retriever.retrieve({ question: c.question, technologies: c.technologies });
  const top = r.citations[0]?.url ?? null;
  const pass = c.expectNone ? r.citations.length === 0 : !!top && !!c.expectUrl && top.includes(c.expectUrl);
  const res: Result = { name: c.name, pass, topUrl: top, selected: r.stats.selected, note: c.expectNone ? 'expected NO citation' : `expected a URL containing "${c.expectUrl}"` };
  if (ANSWERS) {
    const splitter = new DelimiterSplitter();
    const context = { project: { name: 'Eval project' }, focusComponents: c.technologies.map((t) => ({ name: t.name ?? t.slug, technology: t.slug, provider: t.provider ?? null, deploymentModel: t.managedService ? 'MANAGED_SERVICE' : 'SELF_MANAGED' })), decisions: [], requirements: [] };
    const dummy = { workspaceId: '00000000-0000-4000-8000-000000000000', projectId: '00000000-0000-4000-8000-000000000000', userId: '00000000-0000-4000-8000-000000000000' };
    for await (const ev of assistantAi.stream({ context: dummy, projectContext: context, history: [], question: c.question, documents: r.citations.length ? renderDocuments(r.citations, r.texts) : undefined })) {
      if (ev.type === 'delta') splitter.push(ev.text);
    }
    const raw = splitter.finish().structured;
    let proposed = 0; let kept = 0; let claims: ReturnType<typeof validateClaims> = [];
    try {
      const ex = assistantExtrasSchema.parse(JSON.parse((raw ?? '{}').replace(/^```(?:json)?|```$/gm, '').trim()));
      proposed = ex.claims.length;
      claims = validateClaims({ claims: ex.claims, sources: r.citations.map((x) => ({ n: x.n, title: x.title, text: r.texts.get(x.chunkId) ?? x.excerpt })), projectRefs: new Set(), identityTerms: r.query.contextTerms });
      kept = claims.filter((x) => !x.downgradedFrom).length;
    } catch { /* unreadable structured part → no claims → UNGROUNDED, which is the safe outcome */ }
    const g = deriveGrounding({ claims, retrievedCount: r.citations.length, uncitedCommands: 0, versionMatch: r.stats.versionMatch });
    res.answer = { modelClaims: proposed, downgraded: proposed - kept, status: g.status, reasons: g.reasons,
      flag: c.expectNone && g.status === 'GROUNDED' ? 'GROUNDED with no expected documentation: investigate' : !c.expectNone && g.status === 'UNGROUNDED' ? 'UNGROUNDED although the expected page was retrievable' : null };
  }
  results.push(res);
}

for (const r of results) {
  console.log(`\n${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      top: ${r.topUrl ?? '(none)'}  selected: ${r.selected}  (${r.note})`);
  if (r.answer) console.log(`      answer: ${r.answer.status}; model proposed ${r.answer.modelClaims} claims, server downgraded ${r.answer.downgraded}${r.answer.flag ? `\n      !! ${r.answer.flag}` : ''}`);
}
const passed = results.filter((r) => r.pass).length;
console.log(`\nRetrieval: ${passed}/${results.length} cases as expected. Mode: ${FIXTURES ? 'FIXTURES (offline, mock model; not a quality signal)' : 'LIVE documentation'}${ANSWERS ? `, ${process.env.AI_PROVIDER === 'anthropic' && !FIXTURES ? 'real model' : 'mock model'} answers` : ''}.`);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), mode: FIXTURES ? 'fixtures' : 'live', answers: ANSWERS, passed, total: results.length, results }, null, 2));
console.log(`Written ${OUT}`);
await prisma.$disconnect();
// In --fixtures mode the mock model is not a quality signal, so only retrieval decides the exit code; flags are advisory there.
process.exit(passed === results.length && (FIXTURES || !results.some((r) => r.answer?.flag)) ? 0 : 1);
