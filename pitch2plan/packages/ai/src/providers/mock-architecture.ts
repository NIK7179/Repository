import { parseDataBlock } from '../prompts/util';

/**
 * Development/test heuristics for the architecture capabilities. NOT product logic and not a quality signal: it derives a small,
 * schema-valid, traceable architecture from the requirement text so the whole pipeline can run offline.
 */
type Req = { code: string; category: string; statement: string; value?: string | null };
type Driver = { code: string; name: string; description: string; requirementCodes: string[] };
type Input = { requirements: Req[]; drivers: Driver[]; brief?: { openQuestions?: Array<{ text: string }> } };

const node = (stableKey: string, name: string, technology: string, slug: string, category: string, purpose: string, over: Record<string, unknown> = {}) => ({
  stableKey, name, technology, technologySlug: slug, category, purpose, description: `${name} provides ${purpose.toLowerCase()} for this system.`, criticality: 'MEDIUM',
  managedService: false, provider: null, deploymentModel: 'CONTAINER', configuration: [], risks: [], alternatives: [], replacesStableKey: null, ...over,
});
const edge = (id: string, s: string, t: string, label: string, type: string, protocol: string, data: string, over: Record<string, unknown> = {}) => ({
  id, sourceStableKey: s, targetStableKey: t, label, protocol, communicationType: type, dataDescription: data, synchronous: type === 'REQUEST_RESPONSE' || type === 'DATABASE', encrypted: true, criticality: 'MEDIUM', ...over,
});

export function mockPlan(input: Input) {
  const text = input.requirements.map((r) => `${r.category} ${r.statement} ${r.value ?? ''}`).join(' \n ').toLowerCase();
  const large = /very large|large|millions|hundreds of thousands|million/.test(text);
  const streaming = large && /real[- ]?time|immediately|event|stream|transaction/.test(text);
  const rag = /document|retriev|embedding|llm|ask question|knowledge/.test(text);
  const cloud = /aws|amazon/.test(text) ? 'AWS' : /azure/.test(text) ? 'Azure' : /gcp|google cloud/.test(text) ? 'Google Cloud' : 'Cloud provider (to be chosen)';
  const db = node('primary-database', 'Primary database', 'Managed PostgreSQL', 'postgresql', 'DATABASE', 'Durable relational storage', { criticality: 'CRITICAL', managedService: true, provider: cloud, deploymentModel: 'MANAGED_SERVICE', alternatives: [{ technology: 'MongoDB', reasoning: 'The data here is relational and a document store would add little over PostgreSQL.' }] });
  const nodes: ReturnType<typeof node>[] = [node('web-app', 'Web application', 'Next.js', 'nextjs', 'CLIENT', 'User interface', { criticality: 'HIGH', deploymentModel: 'SERVERLESS' }), node('api', 'Application API', 'Node.js service', 'nodejs', 'API', 'Business logic and API', { criticality: 'HIGH' })];
  const edges = [edge('web-api', 'web-app', 'api', 'Browser to API', 'REQUEST_RESPONSE', 'HTTPS', 'User requests and responses')];
  const dec: Array<{ title: string; problem: string; decision: string; nodes: string[]; edges: string[]; kind: string }> = [
    { title: 'Use a conventional web application with an API', problem: 'Users need an interface backed by business logic.', decision: 'A web client talks to a single application API.', nodes: ['web-app', 'api'], edges: ['web-api'], kind: 'app' },
  ];
  if (streaming) {
    nodes.push(
      node('event-producers', 'Event producers', 'Source applications', 'source-applications', 'EXTERNAL_SERVICE', 'Emit events', { deploymentModel: 'EXTERNAL', managedService: false }),
      node('event-stream', 'Event stream', 'Managed event streaming', 'managed-event-stream', 'EVENT_STREAM', 'Durable, replayable event ingestion', { criticality: 'CRITICAL', managedService: true, provider: cloud, deploymentModel: 'MANAGED_SERVICE', alternatives: [{ technology: 'Database-backed queue', reasoning: 'Too slow for the stated volume and offers no independent replay.' }] }),
      node('stream-processor', 'Stream processor', 'Managed stream processing', 'managed-stream-processing', 'STREAM_PROCESSOR', 'Continuous processing of events', { criticality: 'HIGH', managedService: true, provider: cloud, deploymentModel: 'MANAGED_SERVICE' }),
      node('object-storage', 'Analytics storage', 'Object storage', 'object-storage', 'OBJECT_STORAGE', 'Durable storage of processed data', { managedService: true, provider: cloud, deploymentModel: 'MANAGED_SERVICE' }));
    edges.push(edge('producers-stream', 'event-producers', 'event-stream', 'Events published', 'EVENT', 'TLS', 'Transaction events'), edge('stream-processor-in', 'event-stream', 'stream-processor', 'Events consumed', 'STREAM', 'TLS', 'Event stream'),
      edge('processor-storage', 'stream-processor', 'object-storage', 'Processed data stored', 'FILE', 'HTTPS', 'Processed records'), edge('api-db', 'api', 'primary-database', 'Reads and writes', 'DATABASE', 'TLS', 'Application data'));
    dec.push({ title: 'Ingest through a durable event stream', problem: 'Events arrive continuously at high volume and must not be lost.', decision: 'Publish events to a managed, replayable stream.', nodes: ['event-producers', 'event-stream'], edges: ['producers-stream'], kind: 'volume' },
      { title: 'Process events continuously and store results for analytics', problem: 'Results are needed quickly and must be kept for analysis.', decision: 'A stream processor consumes events and writes to object storage.', nodes: ['stream-processor', 'object-storage'], edges: ['stream-processor-in', 'processor-storage'], kind: 'latency' });
  } else if (rag) {
    nodes.push(
      node('document-store', 'Document store', 'Object storage', 'object-storage', 'OBJECT_STORAGE', 'Stores uploaded documents', { managedService: true, provider: cloud, deploymentModel: 'MANAGED_SERVICE' }),
      node('document-processor', 'Document processor', 'Background worker', 'background-worker', 'APPLICATION_SERVICE', 'Extracts text, chunks and embeds documents'),
      node('vector-index', 'Vector index', 'Managed vector search', 'managed-vector-search', 'VECTOR_DATABASE', 'Similarity search over chunks', { managedService: true, provider: cloud, deploymentModel: 'MANAGED_SERVICE' }),
      node('language-model', 'Language model', 'Hosted language model', 'hosted-llm', 'AI_MODEL', 'Answers questions from retrieved text', { criticality: 'HIGH', deploymentModel: 'EXTERNAL', provider: 'Model provider' }),
      node('auth', 'Authentication', 'Managed identity', 'managed-identity', 'AUTH', 'Sign-in and tenant isolation', { managedService: true, provider: cloud, deploymentModel: 'MANAGED_SERVICE' }));
    edges.push(edge('api-auth', 'api', 'auth', 'Verify identity', 'REQUEST_RESPONSE', 'HTTPS', 'Tokens'), edge('api-documents', 'api', 'document-store', 'Upload documents', 'FILE', 'HTTPS', 'Uploaded files'),
      edge('documents-processor', 'document-store', 'document-processor', 'New document', 'EVENT', 'HTTPS', 'Document reference'), edge('processor-index', 'document-processor', 'vector-index', 'Store embeddings', 'DATABASE', 'TLS', 'Chunks and embeddings'),
      edge('api-index', 'api', 'vector-index', 'Retrieve context', 'DATABASE', 'TLS', 'Relevant chunks'), edge('api-model', 'api', 'language-model', 'Ask the model', 'MODEL_INFERENCE', 'HTTPS', 'Question and context'), edge('api-db', 'api', 'primary-database', 'Reads and writes', 'DATABASE', 'TLS', 'Accounts and metadata'));
    dec.push({ title: 'Ingest documents asynchronously', problem: 'Documents must be processed without blocking users.', decision: 'Store uploads, then process them in a background worker.', nodes: ['document-store', 'document-processor'], edges: ['api-documents', 'documents-processor'], kind: 'data' },
      { title: 'Answer questions by retrieval plus a language model', problem: 'Answers must come from the company’s own documents.', decision: 'Retrieve relevant chunks, then ask the model.', nodes: ['vector-index', 'language-model'], edges: ['processor-index', 'api-index', 'api-model'], kind: 'ai' },
      { title: 'Isolate tenants behind managed authentication', problem: 'Companies must not see each other’s documents.', decision: 'All access goes through authenticated, tenant-scoped requests.', nodes: ['auth'], edges: ['api-auth'], kind: 'security' });
  } else {
    edges.push(edge('api-db', 'api', 'primary-database', 'Reads and writes', 'DATABASE', 'TLS', 'Application data'));
  }
  nodes.push(db);
  dec.push({ title: 'Store application data in a managed relational database', problem: 'Application data must be durable and queryable.', decision: 'Use a managed PostgreSQL database.', nodes: ['primary-database'], edges: ['api-db'], kind: 'data' });

  const firstDriver = input.drivers[0]?.code;
  const firstReq = input.requirements[0]?.code;
  const pickDriver = (kind: string) => {
    const re = kind === 'volume' ? /volume|scale|traffic|events|large/i : kind === 'latency' ? /latenc|real|fast|quick/i : kind === 'security' ? /secur|sensitive|tenant|isolation|privacy/i : kind === 'ai' ? /ai|model|document|answer/i : kind === 'data' ? /data|store|retention/i : /./;
    return (input.drivers.find((d) => re.test(`${d.name} ${d.description}`)) ?? input.drivers[0])?.code;
  };
  const decisions = dec.map((d, i) => {
    const driver = pickDriver(d.kind) ?? firstDriver;
    return {
      key: `adr-${String(i + 1).padStart(3, '0')}`, title: d.title, problem: d.problem, decision: d.decision,
      rationale: `This follows from the confirmed requirements and the driver ${driver ?? 'above'}; a simpler alternative would not meet them as directly.`,
      status: driver || firstReq ? 'ACCEPTED' : 'PROPOSED', tradeoffs: ['Adds a component to operate and monitor.'], risks: [], consequences: ['The team must understand this component to run the system.'],
      alternatives: [{ technology: 'A simpler single-service design', reasoning: 'Considered, but it would not satisfy the drivers cited here as cleanly.' }], confidence: 0.7,
      driverCodes: driver ? [driver] : [], requirementCodes: !driver && firstReq ? [firstReq] : [], nodeStableKeys: d.nodes, edgeIds: d.edges,
    };
  });
  return {
    summary: `${streaming ? 'An event-driven pipeline' : rag ? 'A retrieval-based question-answering system' : 'A simple web application'} sized to the confirmed requirements, using managed services where practical.`,
    nodes, edges, decisions, risks: [{ text: 'Estimates of load come from the confirmed requirements and should be validated early.', severity: 'MEDIUM', nodeStableKeys: [] }],
    assumptions: ['Traffic and data volumes are as stated in the confirmed brief.'], unresolvedQuestions: (input.brief?.openQuestions ?? []).slice(0, 5).map((q) => q.text),
  };
}

export function mockCritic() { return { assessment: 'The mock reviewer found no blocking problems. This is not a real review.', issues: [] }; }

type Issue = { index: number; severity: string; category: string; code: string; description: string; affectedNodeStableKeys: string[]; affectedDecisionKeys: string[] };
export function mockRepair(input: { issues: Issue[]; mustAddress: number[] }) {
  const patch = { changes: [] as Array<{ issueIndex: number; description: string }>, nodes: { add: [], update: [] as unknown[], remove: [] as string[] }, edges: { add: [], update: [], remove: [] as string[] }, decisions: { add: [], update: [] as unknown[], remove: [] }, addRisks: [], addAssumptions: [] as string[] };
  for (const i of input.issues) {
    if (i.severity !== 'CRITICAL' && i.severity !== 'HIGH') continue;
    let note = 'Recorded the concern as an assumption.';
    if (i.code === 'ORPHAN_NODE') { patch.nodes.remove.push(...i.affectedNodeStableKeys); note = 'Removed the unconnected component.'; }
    else if (i.code === 'DECISION_WITHOUT_DRIVER') { for (const k of i.affectedDecisionKeys) patch.decisions.update.push({ key: k, set: { status: 'PROPOSED' } }); note = 'Marked the unsupported decision as proposed.'; }
    else if (i.code === 'SELF_EDGE' || i.code === 'DUPLICATE_EDGE') { const m = /"([a-z0-9-]+)"/.exec(i.description.split('and').pop() ?? ''); if (m) patch.edges.remove.push(m[1]!); note = 'Removed the redundant edge.'; }
    else if (i.affectedNodeStableKeys.length) { for (const k of i.affectedNodeStableKeys) patch.nodes.update.push({ stableKey: k, set: { configuration: [{ key: 'replicas', value: '2 or more', note: 'Run redundantly with automatic failover.' }] } }); note = 'Added redundancy.'; }
    else patch.addAssumptions.push(`Addressed in review: ${i.description.slice(0, 120)}`);
    patch.changes.push({ issueIndex: i.index, description: note });
  }
  for (const n of input.mustAddress) if (!patch.changes.some((c) => c.issueIndex === n)) patch.changes.push({ issueIndex: n, description: 'Reviewed and accepted with a note.' });
  patch.nodes.remove = [...new Set(patch.nodes.remove)];
  return patch;
}

export function mockArchitectureFor(promptId: string, content: string): unknown | undefined {
  if (promptId === 'ARCHITECTURE_PLANNER') return mockPlan(parseDataBlock(content, 'plan_input')!);
  if (promptId === 'ARCHITECTURE_CRITIC') return mockCritic();
  if (promptId === 'ARCHITECTURE_REPAIRER') return mockRepair(parseDataBlock(content, 'repair_input')!);
  return undefined;
}
