import { STRUCTURED_DELIMITER, stemWord, topicWords } from '@pitch2plan/schemas';
import { parseDataBlock } from '../prompts/util';

/**
 * Development/test heuristics. NOT product logic and not a quality signal: it derives a coherent, validated plan from the architecture
 * it is given (provider, managed vs self-hosted, connections, decisions) so the whole pipeline can run offline.
 */
interface Node { stableKey: string; name: string; technology: string; category: string; criticality: string; deploymentModel: string; provider: string | null; managedService: boolean; purpose: string; configuration: Array<{ key: string; value: string }> }
interface Edge { id: string; source: string; target: string; label: string; protocol: string; communicationType: string; dataDescription: string }
interface Decision { key: string; title: string; status: string; nodeStableKeys: string[]; requirementCodes: string[] }
interface Input { project: { name: string }; architecture: { nodes: Node[]; edges: Edge[]; decisions: Decision[] } }

const GROUPS: Array<{ key: string; name: string; objective: string; cats: string[] }> = [
  { key: 'data-layer', name: 'Data layer', objective: 'Stand up and secure the places data lives.', cats: ['DATABASE', 'OBJECT_STORAGE', 'DATA_WAREHOUSE', 'CACHE', 'SEARCH', 'VECTOR_DATABASE'] },
  { key: 'event-infrastructure', name: 'Event infrastructure', objective: 'Get events flowing reliably between producers and consumers.', cats: ['EVENT_STREAM', 'QUEUE'] },
  { key: 'processing', name: 'Processing', objective: 'Run the processing that turns incoming data into results.', cats: ['STREAM_PROCESSOR', 'BATCH_PROCESSOR'] },
  { key: 'application-services', name: 'Application services', objective: 'Build and configure the services users and systems talk to.', cats: ['API', 'APPLICATION_SERVICE', 'AUTH', 'AI_MODEL', 'OTHER'] },
  { key: 'client', name: 'Client', objective: 'Deliver the user-facing side.', cats: ['CLIENT', 'EDGE'] },
];
const FOUNDATION_CATS = ['OBSERVABILITY', 'SECURITY', 'CI_CD', 'NETWORK'];
const CODE_CATS = ['API', 'APPLICATION_SERVICE', 'CLIENT'];
const label = (c: string) => c.toLowerCase().replaceAll('_', ' ');

export function mockImplPlan(input: Input) {
  const { nodes, edges, decisions } = input.architecture;
  const external = nodes.filter((n) => n.category === 'EXTERNAL_SERVICE' && n.deploymentModel === 'EXTERNAL');
  const work = nodes.filter((n) => !external.includes(n));
  const provider = nodes.find((n) => n.provider)?.provider ?? 'your chosen platform';
  const nameOf = new Map(nodes.map((n) => [n.stableKey, n]));
  const groupOf = (n: Node) => (FOUNDATION_CATS.includes(n.category) ? 'foundation' : GROUPS.find((g) => g.cats.includes(n.category))?.key ?? 'application-services');
  const decisionsFor = (keys: string[]) => decisions.filter((d) => d.status === 'ACCEPTED' && d.nodeStableKeys.some((k) => keys.includes(k)));

  const phases = [{ key: 'foundation', name: 'Foundation', objective: `Prepare the environment and identity that everything in ${input.project.name} builds on.`, description: 'Repository, environments, access and secrets, before any component is built.' }];
  for (const g of GROUPS) if (work.some((n) => groupOf(n) === g.key)) phases.push({ key: g.key, name: g.name, objective: g.objective, description: `${g.name} components from the architecture: ${work.filter((n) => groupOf(n) === g.key).map((n) => n.name).join(', ')}.` });
  phases.push({ key: 'observability', name: 'Observability', objective: 'See what the important components are doing and be alerted when they misbehave.', description: 'Logs, metrics, health checks and alerts for the components the architecture marks as important.' });
  phases.push({ key: 'testing-and-launch', name: 'Testing and launch', objective: 'Prove the integrated system works, then ship it.', description: 'End-to-end validation and the production release.' });
  const phaseIdx = new Map(phases.map((p, i) => [p.key, i]));

  const tasks: Array<Record<string, unknown> & { key: string; phaseKey: string }> = [];
  const T = (t: Record<string, unknown> & { key: string; phaseKey: string }) => tasks.push({ complexity: 'MEDIUM', effort: 'MEDIUM', prerequisites: [], securityNotes: [], operationalNotes: [], commonProblems: [], steps: [], dependsOn: [], componentKeys: [], decisionKeys: [], requirementCodes: [], references: [], ...t });

  T({ key: 'prepare-environment', phaseKey: 'foundation', title: `Prepare the ${provider} environment and repository`, taskType: 'SETUP', complexity: 'LOW', effort: 'SMALL',
    objective: `Create the repository and the separate environments (development and production) that ${input.project.name} will be built and run in.`, description: `Set up the source repository and the accounts, projects or subscriptions on ${provider} that the architecture's components will live in.`,
    whyThisTask: 'Every component in the architecture needs a home and a way to be deployed repeatably before it can be provisioned.', instructions: `Create the repository, then create one development and one production environment on ${provider} and record their identifiers in the repository's documentation.`,
    expectedOutcome: 'A repository exists and two isolated environments are ready to receive components.', validationSteps: ['The repository is reachable by the whole team', 'Development and production environments exist and are separate'],
    steps: [{ title: 'Create the repository', instruction: 'Create the repository and add the team with the access each person needs.', expectedResult: 'The team can clone it.', validation: '' }, { title: 'Create the environments', instruction: `Create a development and a production environment on ${provider}.`, expectedResult: 'Two separate environments exist.', validation: '' }] });
  T({ key: 'configure-secrets-and-identity', phaseKey: 'foundation', title: 'Set up secrets storage and least-privilege access', taskType: 'SECURITY', objective: 'Decide where credentials live and who can reach what, before components start needing them.', description: `Every connection in this architecture needs credentials or roles. Create the secrets store and the access roles on ${provider} now so later tasks can use them.`,
    whyThisTask: 'The architecture has multiple connected components; without a secrets store, credentials end up in code or configuration files.', instructions: 'Create a secrets store per environment, one role per service, and grant each role only the access its connections in the architecture require.',
    expectedOutcome: 'A secrets store and per-service roles exist in each environment, with no shared administrator credentials in use by services.', validationSteps: ['Each service role exists and can read only its own secrets', 'No credential appears in the repository'],
    securityNotes: ['Give each service its own identity; do not share one credential across components.', 'Rotate any credential that was ever pasted into a chat, ticket or file.'], dependsOn: ['prepare-environment'] });

  const provisionKey = (n: Node) => `provision-${n.stableKey}`; const configureKey = (n: Node) => `configure-${n.stableKey}`;
  for (const n of work) {
    const phaseKey = groupOf(n); const ds = decisionsFor([n.stableKey]); const dKeys = ds.map((d) => d.key).slice(0, 6); const rCodes = [...new Set(ds.flatMap((d) => d.requirementCodes))].slice(0, 4);
    const infra = !CODE_CATS.includes(n.category); const where = n.managedService ? `${n.provider ?? provider}'s managed ${n.technology}` : `${n.technology} (${n.deploymentModel.toLowerCase().replaceAll('_', ' ')})`;
    const links = { componentKeys: [n.stableKey], decisionKeys: dKeys, requirementCodes: rCodes };
    T({ key: provisionKey(n), phaseKey, title: infra ? `${n.managedService ? 'Provision' : 'Set up'} ${n.name} (${n.technology})` : `Scaffold ${n.name} (${n.technology})`, taskType: infra ? 'INFRASTRUCTURE' : 'CODE', complexity: n.criticality === 'CRITICAL' ? 'HIGH' : 'MEDIUM', effort: infra ? 'MEDIUM' : 'LARGE',
      objective: `Make ${n.name} exist and be reachable as the architecture specifies: ${n.purpose.toLowerCase()}`, description: `${n.name} is ${where} in this architecture. ${n.purpose}`,
      whyThisTask: ds.length ? `Architecture decision ${ds[0]!.key.toUpperCase()} ("${ds[0]!.title}") puts ${n.name} in the design.` : `The architecture includes ${n.name} (${n.technology}) as a ${label(n.category)} component.`,
      instructions: n.managedService ? `Create ${n.technology} in ${n.provider ?? provider} for the ${n.name} component. It is a managed service, so there is nothing to install on your own servers; place it in the same network as the services that connect to it.` : `Run ${n.technology} yourself as the architecture specifies (${n.deploymentModel.toLowerCase().replaceAll('_', ' ')}), sized for the ${n.criticality.toLowerCase()} role this component has.`,
      expectedOutcome: `${n.name} exists in the development environment and reports healthy.`, validationSteps: [`${n.name} reports a healthy status`, `The services that connect to ${n.name} can reach it on the network`],
      commonProblems: n.managedService ? [{ problem: `A service cannot connect to ${n.name}`, resolution: 'Check that the network rules allow the connecting service and that both are in the same network.' }] : [{ problem: `${n.name} runs out of memory`, resolution: 'Check the resource limits against the sizing the architecture implies.' }],
      operationalNotes: n.managedService ? [`${n.name} is managed: patching and failover are handled by ${n.provider ?? provider}, but you still own its configuration and access.`] : [`You operate ${n.name} yourself: plan upgrades and backups.`],
      steps: [{ title: `Choose where ${n.name} will run`, instruction: `Pick the region and network for ${n.name} so it sits next to the services that use it.`, expectedResult: 'Region and network are decided.', validation: '' }, { title: `Create ${n.name}`, instruction: n.managedService ? `Create the ${n.technology} resource in ${n.provider ?? provider}.` : `Deploy ${n.technology} using the chosen deployment model.`, expectedResult: 'The resource exists.', validation: '' }, { title: 'Confirm it is healthy', instruction: `Open ${n.name}'s status view and wait for it to report healthy.`, expectedResult: 'Healthy status.', validation: '' }],
      dependsOn: [phaseKey === 'foundation' ? 'prepare-environment' : 'prepare-environment'], ...links });
    const touching = edges.filter((e) => e.source === n.stableKey || e.target === n.stableKey);
    const peers = [...new Set(touching.map((e) => nameOf.get(e.source === n.stableKey ? e.target : e.source)?.name).filter(Boolean))] as string[];
    T({ key: configureKey(n), phaseKey, title: `Configure and secure ${n.name}`, taskType: 'CONFIGURATION', complexity: 'MEDIUM', effort: 'SMALL',
      objective: `Apply ${n.name}'s settings and give only its connected components access.`, description: `Apply the configuration the architecture records for ${n.name} and restrict access to ${peers.length ? peers.join(', ') : 'the components that need it'}.`,
      whyThisTask: ds.length ? `Decision ${ds[0]!.key.toUpperCase()} depends on ${n.name} being configured as designed, not left at defaults.` : `${n.name} must be configured to match the architecture and limited to its connections.`,
      instructions: `${n.configuration.length ? `Apply these architecture settings: ${n.configuration.map((c) => `${c.key} = ${c.value}`).join('; ')}. ` : ''}Allow access only from ${peers.length ? peers.join(', ') : 'the components that connect to it'}, using the roles created in the secrets task, and use ${[...new Set(touching.map((e) => e.protocol))].join(' / ') || 'encrypted connections'} for those connections.`,
      expectedOutcome: `${n.name} is configured as the architecture records and only its connected components can reach it.`, validationSteps: [`${n.name}'s settings match the architecture${n.configuration.length ? ` (${n.configuration.map((c) => c.key).join(', ')})` : ''}`, `A component that is not connected to ${n.name} is refused`],
      securityNotes: [`Grant ${peers.length ? peers.join(' and ') : 'each connected service'} the minimum access to ${n.name}.`, 'Encrypt traffic in transit, as the architecture specifies.'],
      operationalNotes: n.criticality === 'CRITICAL' ? [`The architecture marks ${n.name} CRITICAL: confirm redundancy and recovery for it before launch.`] : [],
      dependsOn: [provisionKey(n), 'configure-secrets-and-identity'], componentKeys: [n.stableKey], decisionKeys: [], requirementCodes: [] });
  }
  const phaseOfTask = (k: string) => phaseIdx.get(tasks.find((t) => t.key === k)!.phaseKey)!;
  const integrationKeys: string[] = [];
  for (const e of edges) {
    const a = nameOf.get(e.source)!, b = nameOf.get(e.target)!; if (!a || !b) continue;
    const deps = [a, b].filter((n) => !external.includes(n)).map(configureKey);
    if (!deps.length) continue;
    const phaseKey = phases[Math.max(...deps.map(phaseOfTask))]!.key; const ds = decisionsFor([e.source, e.target]).filter((d) => d.nodeStableKeys.includes(e.source) && d.nodeStableKeys.includes(e.target));
    const key = `integrate-${e.id}`.slice(0, 70); integrationKeys.push(key);
    T({ key, phaseKey, title: `Connect ${a.name} to ${b.name} (${e.protocol})`, taskType: 'INTEGRATION', objective: `Make ${e.dataDescription.toLowerCase()} flow from ${a.name} to ${b.name}.`, description: `${e.label}: ${a.name} sends ${e.dataDescription} to ${b.name} using ${e.protocol} (${e.communicationType.toLowerCase().replaceAll('_', ' ')}).`,
      whyThisTask: ds.length ? `Decision ${ds[0]!.key.toUpperCase()} ("${ds[0]!.title}") relies on this connection.` : `The architecture defines this connection between ${a.name} and ${b.name}.`,
      instructions: `Configure ${a.name} to reach ${b.name} over ${e.protocol} with the credentials from the secrets store, then send one real ${e.dataDescription.toLowerCase()} message or request through it.`, expectedOutcome: `One real ${e.dataDescription.toLowerCase()} item travels from ${a.name} to ${b.name}.`,
      validationSteps: [`${b.name} received what ${a.name} sent`, 'The connection is encrypted as the architecture specifies'], commonProblems: [{ problem: 'The connection is refused', resolution: `Check ${b.name}'s access rules allow ${a.name} and that the credentials are the ones for ${a.name}.` }],
      dependsOn: [...new Set([...deps, 'configure-secrets-and-identity'])], componentKeys: [e.source, e.target].slice(0, 6), decisionKeys: ds.map((d) => d.key).slice(0, 3), requirementCodes: [] });
  }
  const important = work.filter((n) => n.criticality === 'CRITICAL' || n.criticality === 'HIGH').slice(0, 6);
  const monitorKeys: string[] = [];
  for (const n of important) {
    const signal = n.category === 'EVENT_STREAM' || n.category === 'QUEUE' ? 'consumer lag and message backlog' : n.category === 'API' || n.category === 'APPLICATION_SERVICE' ? 'request latency and error rate' : n.category === 'DATABASE' ? 'connections, query latency and storage' : n.category === 'OBJECT_STORAGE' ? 'error rate and storage growth' : 'health and error rate';
    const key = `monitor-${n.stableKey}`.slice(0, 70); monitorKeys.push(key);
    T({ key, phaseKey: 'observability', title: `Monitor ${n.name}: ${signal}`, taskType: 'OBSERVABILITY', complexity: 'LOW', effort: 'SMALL', objective: `Know when ${n.name} is unhealthy before users tell you.`, description: `Collect logs and metrics for ${n.name} and alert on ${signal}.`,
      whyThisTask: `The architecture marks ${n.name} as ${n.criticality.toLowerCase()}, so its failure would be felt quickly.`, instructions: `Send ${n.name}'s logs and metrics to your monitoring tool, add a dashboard showing ${signal}, and create an alert that notifies the team when ${signal} crosses a level you choose.`,
      expectedOutcome: `${n.name} has a dashboard and at least one alert on ${signal}.`, validationSteps: [`The dashboard shows live data for ${n.name}`, 'A test alert reaches the on-call channel'], operationalNotes: [`Watch ${signal}.`], dependsOn: [configureKey(n)], componentKeys: [n.stableKey], decisionKeys: [], requirementCodes: [] });
  }
  const configureAll = work.map(configureKey);
  T({ key: 'test-end-to-end', phaseKey: 'testing-and-launch', title: `Test ${input.project.name} end to end`, taskType: 'TESTING', complexity: 'MEDIUM', effort: 'MEDIUM', objective: 'Prove the connected components behave as the requirements say.', description: 'Run the main flows through every connection in the architecture and check the results.',
    whyThisTask: 'Components that work alone can still fail when connected.', instructions: `Run one realistic scenario through ${work.slice(0, 4).map((n) => n.name).join(', ')}${work.length > 4 ? ' and the rest of the chain' : ''} and compare the outcome with the confirmed requirements.`, expectedOutcome: 'The main flows work end to end in the development environment.',
    validationSteps: ['Each main flow produces the expected result', 'A deliberate failure is handled as the architecture intends'], dependsOn: integrationKeys.length ? integrationKeys : configureAll, componentKeys: work.slice(0, 6).map((n) => n.stableKey), decisionKeys: [], requirementCodes: [] });
  T({ key: 'deploy-and-launch', phaseKey: 'testing-and-launch', title: `Deploy ${input.project.name} to production`, taskType: 'DEPLOYMENT', complexity: 'MEDIUM', effort: 'MEDIUM', objective: 'Release the system to the production environment safely.', description: 'Repeat the verified setup in production, switch traffic over and watch it.',
    whyThisTask: 'The work is only valuable once it runs where users are.', instructions: `Apply the same provisioning and configuration in the production environment on ${provider}, run a smoke test, and release.`, expectedOutcome: 'The system runs in production with monitoring in place.',
    validationSteps: ['A smoke test passes in production', 'Monitoring shows healthy components after release'], dependsOn: ['test-end-to-end', ...monitorKeys], componentKeys: [], decisionKeys: [], requirementCodes: [] });

  return {
    summary: `${work.length} components to implement for ${input.project.name}, starting with environment and access, then each layer of the architecture, then monitoring, testing and launch.`,
    phases, tasks, componentCoverage: external.map((n) => ({ stableKey: n.stableKey, reason: `${n.name} is an external dependency: there is nothing to provision, only credentials and integration.` })).filter((c) => !tasks.some((t) => (t.componentKeys as string[]).includes(c.stableKey))),
  };
}

export const mockImplCritic = () => ({ assessment: 'The mock reviewer found no blocking problems. This is not a real review.', issues: [] });

type Iss = { index: number; severity: string; code: string; taskKeys: string[]; componentKeys: string[]; description: string };
export function mockImplRepair(input: { plan: { tasks: Array<{ key: string; dependsOn: string[] }> }; issues: Iss[]; mustAddress: number[] }) {
  const patch = { changes: [] as Array<{ issueIndex: number; description: string }>, phases: { add: [], update: [], remove: [] }, tasks: { add: [], update: [] as unknown[], remove: [] }, coverage: { add: [] as unknown[], remove: [] } };
  const fixed = new Set<string>();
  for (const i of input.issues) {
    if (i.severity !== 'CRITICAL' && i.severity !== 'HIGH') continue;
    let note = 'Reviewed and recorded.';
    if (i.code === 'DEPENDENCY_CYCLE' && i.taskKeys[0] && !fixed.has(i.taskKeys[0])) { fixed.add(i.taskKeys[0]); patch.tasks.update.push({ key: i.taskKeys[0], set: { dependsOn: [] } }); note = 'Cleared the dependencies that formed the cycle.'; }
    else if (i.code === 'PHASE_ORDER' && i.taskKeys.length === 2) { const t = input.plan.tasks.find((x) => x.key === i.taskKeys[0]); if (t && !fixed.has(t.key)) { fixed.add(t.key); patch.tasks.update.push({ key: t.key, set: { dependsOn: t.dependsOn.filter((d) => d !== i.taskKeys[1]) } }); note = 'Removed the dependency on a later phase.'; } }
    else if (i.code === 'UNCOVERED_COMPONENT' && i.componentKeys[0]) { patch.coverage.add.push({ stableKey: i.componentKeys[0], reason: 'Reviewed: nothing to implement for this component beyond what other tasks already cover.' }); note = 'Recorded why no work is needed.'; }
    patch.changes.push({ issueIndex: i.index, description: note });
  }
  for (const n of input.mustAddress) if (!patch.changes.some((c) => c.issueIndex === n)) patch.changes.push({ issueIndex: n, description: 'Reviewed and accepted with a note.' });
  return patch;
}

/** A grounded assistant reply for development and tests. */
export function mockAssistantAnswer(userContent: string): string {
  const ctx = (parseDataBlock<Record<string, unknown>>(userContent, 'project_context') ?? {}) as { focusComponents?: Array<{ name: string; technology: string; deploymentModel: string; provider: string | null }>; decisions?: Array<{ key: string; title: string }>; requirements?: Array<{ code: string; statement: string }>; currentTask?: { title: string; instructions: string; validationSteps: string[]; commonProblems: Array<{ problem: string; resolution: string }> }; relatedTasks?: Array<{ id: string }>; project?: { name: string } };
  const q = userContent.split('Question: ').pop() ?? '';
  const comp = ctx.focusComponents?.[0]; const task = ctx.currentTask; const dec = ctx.decisions?.[0]; const req = ctx.requirements?.[0];
  const where = comp ? `${comp.name} (${comp.technology}${comp.provider ? ` on ${comp.provider}` : ''}, ${comp.deploymentModel.toLowerCase().replaceAll('_', ' ')})` : `the ${ctx.project?.name ?? 'project'} architecture`;
  const extras = { warnings: [] as string[], commands: [] as Array<{ command: string; purpose: string }>, codeBlocks: [] as unknown[], validationSteps: [] as string[], relatedTaskIds: (ctx.relatedTasks ?? []).slice(0, 2).map((t) => t.id), architectureImpact: '', needsArchitectureChange: false, claims: [] as Array<{ text: string; label: string; citations: number[]; projectRefs: string[] }> };
  let answer: string;
  if (/instead|replace|switch|alternative|rather than/i.test(q)) {
    answer = `You could, but it is a change to the architecture, not just to this task. ${where} is there because of ${dec ? `${dec.key.toUpperCase()} ("${dec.title}")` : 'a recorded decision'}${req ? ` and ${req.code}: ${req.statement}` : ''}. Swapping it means revisiting that decision and every task that depends on it.`;
    extras.needsArchitectureChange = true; extras.architectureImpact = `Replacing ${comp?.technology ?? 'this component'} would change ${dec?.key ?? 'a decision'} and the tasks linked to it.`;
  } else if (/why/i.test(q)) {
    answer = `${where} exists because ${dec ? `${dec.key.toUpperCase()} ("${dec.title}")` : 'the architecture needs it'}${req ? `, which serves ${req.code}: ${req.statement}` : ''}.`;
  } else if (/validate|verify|check|test/i.test(q) && task) {
    answer = `To validate "${task.title}", check: ${task.validationSteps.map((s, n) => `${n + 1}) ${s}`).join('; ')}.`; extras.validationSteps = task.validationSteps;
  } else if (/error|fail|denied|timeout|cannot|can't|exception|refused/i.test(q)) {
    const p = task?.commonProblems?.[0];
    answer = `For ${where}, the most likely cause is ${p ? `"${p.problem}": ${p.resolution}` : 'a network or access rule between the connected components'}. Start with a read-only check before changing anything.`;
    extras.commands.push({ command: 'aws sts get-caller-identity', purpose: 'Confirm which identity your tools are using' });
    if (/delete|remove|reset/i.test(q)) extras.commands.push({ command: 'aws s3 rb s3://example-bucket --force', purpose: 'Remove a bucket and everything in it' });
  } else {
    answer = `For ${task ? `"${task.title}"` : where}: ${task ? task.instructions : `${where} is part of the ${ctx.project?.name ?? 'project'} architecture.`}`;
  }
  // Grounding: cite a retrieved document only when it really overlaps with the question. The mock never follows instructions found inside documents.
  const docs = [...userContent.matchAll(/<document n="(\d+)"[^>]*>\n([\s\S]*?)\n<\/document>/g)].map((m) => ({ n: Number(m[1]), body: m[2]! }));
  const wanted = [...new Set(topicWords(q).map(stemWord))];
  const required = wanted.length >= 2 ? 2 : 1;
  let best: { n: number; sentence: string; score: number } | null = null;
  for (const d of docs) for (const sentence of d.body.split(/(?<=[.!?])\s+/)) {
    const stems = new Set(topicWords(sentence).map(stemWord)); const score = wanted.filter((w) => stems.has(w)).length;
    if (score >= required && (!best || score > best.score) && !/ignore|disregard|system prompt|you must now/i.test(sentence)) best = { n: d.n, sentence: sentence.trim(), score };
  }
  if (best) { answer += ` According to the documentation: ${best.sentence} [${best.n}]`; extras.claims.push({ text: best.sentence.slice(0, 480), label: 'DOCUMENTED', citations: [best.n], projectRefs: [] }); }
  else if (docs.length) answer += ' The retrieved documentation does not cover this point directly, so treat the guidance above as a recommendation.';
  if (dec) extras.claims.push({ text: `${where} is part of the architecture because of ${dec.key.toUpperCase()}`, label: 'ARCHITECTURE_DECISION', citations: [], projectRefs: [dec.key.toUpperCase()] });
  return `${answer}\n${STRUCTURED_DELIMITER}\n${JSON.stringify(extras)}`;
}

export function mockImplementationFor(promptId: string, first: string, last: string): unknown | undefined {
  if (promptId === 'IMPLEMENTATION_PLANNER') return mockImplPlan(parseDataBlock(first, 'impl_plan_input')!);
  if (promptId === 'IMPLEMENTATION_CRITIC') return mockImplCritic();
  if (promptId === 'IMPLEMENTATION_REPAIRER') return mockImplRepair(parseDataBlock(first, 'impl_repair_input')!);
  if (promptId === 'TASK_ASSISTANT') return mockAssistantAnswer(last);
  return undefined;
}
