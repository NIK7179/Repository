import { parseDataBlock } from '../prompts/util';

/**
 * Development/test heuristics, NOT product logic and not a quality signal. They read the request and derive a coherent analysis/plan from the architecture they are given,
 * so the whole change chain (analyse -> approve -> apply -> diff -> plan migration) runs offline.
 */
interface Node { stableKey: string; name: string; technology: string; technologySlug: string; category: string; criticality: string; provider: string | null; managedService: boolean; deploymentModel: string; purpose: string; configuration: Array<{ key: string; value: string }> }
interface Dec { key: string; title: string; decision: string; status: string; nodeStableKeys: string[]; driverCodes: string[]; requirementCodes: string[]; rationale: string; tradeoffs?: string[] }
interface Arch { nodes: Node[]; edges: Array<{ id: string; source: string; target: string }>; decisions: Dec[] }
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const kebab = (s: string) => norm(s).replaceAll(' ', '-').slice(0, 40);
const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const findNode = (arch: Arch, term: string) => { const t = norm(term); return arch.nodes.find((n) => norm(`${n.name} ${n.technology} ${n.technologySlug} ${n.stableKey}`).includes(t) || t.split(' ').some((w) => w.length > 3 && norm(`${n.technology} ${n.technologySlug}`).split(' ').includes(w))); };
const impact = (direction: string, notes: string) => ({ direction, notes });
export type MockChangeKind = 'REPLACE' | 'MULTI_REGION' | 'REMOVE' | 'ADD' | 'OTHER';
export function classifyRequest(text: string): { kind: MockChangeKind; from?: string; to?: string; term?: string } {
  const r = /replace\s+(.+?)\s+with\s+(.+?)[.?!]*$/i.exec(text); if (r) return { kind: 'REPLACE', from: r[1], to: r[2] };
  const u = /use\s+(.+?)\s+instead\s+of\s+(.+?)[.?!]*$/i.exec(text); if (u) return { kind: 'REPLACE', from: u[2], to: u[1] };
  if (/multi.?region|multiple regions|across regions/i.test(text)) return { kind: 'MULTI_REGION' };
  const rm = /remove\s+(.+?)[.?!]*$/i.exec(text); if (rm) return { kind: 'REMOVE', term: rm[1] };
  const ad = /add\s+(?:a\s+|an\s+)?(.+?)[.?!]*$/i.exec(text); if (ad) return { kind: 'ADD', term: ad[1] };
  return { kind: 'OTHER' };
}

export function mockChangeAnalysis(input: { requestedChange: string; architecture: Arch; plan: null | { tasks: Array<{ key: string; status: string; componentKeys: string[] }> }; requirements: Array<{ code: string; category: string }>; drivers: Array<{ code: string }> }) {
  const arch = input.architecture; const c = classifyRequest(input.requestedChange);
  const aff = (key: string, relation: 'DIRECT' | 'POTENTIAL', reason: string) => ({ key, relation, reason });
  let direct: Node[] = [];
  if (c.kind === 'REPLACE' || c.kind === 'REMOVE') { const n = findNode(arch, (c.from ?? c.term)!); if (n) direct = [n]; }
  if (c.kind === 'MULTI_REGION') direct = arch.nodes.filter((n) => ['DATABASE', 'OBJECT_STORAGE', 'EVENT_STREAM', 'API'].includes(n.category) && ['CRITICAL', 'HIGH'].includes(n.criticality)).slice(0, 3);
  const keys = new Set(direct.map((n) => n.stableKey));
  const decisions = arch.decisions.filter((d) => d.nodeStableKeys.some((k) => keys.has(k)));
  const edges = arch.edges.filter((e) => keys.has(e.source) || keys.has(e.target));
  const reqs = [...new Set(decisions.flatMap((d) => d.requirementCodes))]; const drvs = [...new Set(decisions.flatMap((d) => d.driverCodes))];
  const tasks = (input.plan?.tasks ?? []).filter((t) => t.componentKeys.some((k) => keys.has(k)));
  const names = direct.map((n) => n.name).join(', ') || 'the architecture';
  const changeType = c.kind === 'REPLACE' ? 'TECHNOLOGY_REPLACEMENT' : c.kind === 'MULTI_REGION' ? 'REQUIREMENT_CHANGE' : c.kind === 'REMOVE' ? 'COMPONENT_REMOVE' : c.kind === 'ADD' ? 'COMPONENT_ADD' : 'OTHER';
  const done = tasks.filter((t) => t.status === 'COMPLETED').length;
  return {
    summary: c.kind === 'REPLACE' ? `Replace ${direct[0]?.technology ?? c.from} with ${c.to} as the technology of ${names}, keeping its role in the architecture.` : c.kind === 'MULTI_REGION' ? `Make ${names} available across more than one region, which is a change to the availability requirements.` : `Apply the requested change: ${input.requestedChange}`.slice(0, 400),
    changeType, whatChanges: [c.kind === 'REPLACE' ? `${names}: ${direct[0]?.technology ?? c.from} becomes ${c.to}` : c.kind === 'MULTI_REGION' ? 'Availability across regions for the critical components' : input.requestedChange.slice(0, 280)],
    whatStaysTheSame: arch.nodes.filter((n) => !keys.has(n.stableKey)).slice(0, 4).map((n) => `${n.name} (${n.technology}) is untouched`),
    affectedNodes: direct.map((n) => aff(n.stableKey, 'DIRECT', c.kind === 'REPLACE' ? `${n.name} is the component being replaced` : `${n.name} must change for this request`)),
    affectedEdges: edges.map((e) => aff(e.id, 'POTENTIAL', 'Connected to a component that changes; protocol, credentials and data format must be re-checked')),
    affectedDecisions: decisions.map((d) => aff(d.key, 'DIRECT', `${d.key.toUpperCase()} was made for ${names}`)),
    affectedDrivers: drvs.map((k) => aff(k, 'POTENTIAL', 'The decision serving this driver changes, so it must still be met')),
    affectedRequirements: reqs.map((k) => aff(k, 'POTENTIAL', 'Must still be satisfied after the change')),
    affectedTasks: tasks.map((t) => aff(t.key, 'DIRECT', `Implements ${names}`)),
    requirementChanges: c.kind === 'MULTI_REGION' ? [{ kind: 'ADD', requirementCode: null, category: 'AVAILABILITY', statement: 'The system must stay available if an entire cloud region fails (multi-region availability).', value: null, reason: 'The request asks for multi-region operation.' }] : [],
    newRisks: [{ text: c.kind === 'REPLACE' ? `Migrating from ${direct[0]?.technology ?? 'the current technology'} to ${c.to} can disrupt producers and consumers while both are in use.` : 'The change introduces new operational complexity.', severity: 'MEDIUM' }], resolvedRisks: [],
    performanceImpact: impact('MIXED', `Throughput and latency behave differently on the new setup for ${names}; validate against the traffic requirements.`),
    securityImpact: impact('MIXED', 'Identity, credentials and network access for the affected components must be redone and re-reviewed.'),
    reliabilityImpact: impact(c.kind === 'MULTI_REGION' ? 'IMPROVES' : 'MIXED', c.kind === 'MULTI_REGION' ? 'A regional outage no longer takes the critical components down, at the price of replication complexity.' : 'Failure behaviour changes with the technology; retention, replay and recovery must be re-verified.'),
    costImpact: impact('UNKNOWN', 'Cost direction depends on volume and pricing model; no figure is given without real pricing data.'),
    complexityImpact: impact(c.kind === 'MULTI_REGION' ? 'WORSENS' : 'MIXED', 'There is a one-off migration, and the steady-state complexity depends on the new technology.'),
    operationalImpact: impact('MIXED', 'Monitoring, alerts and runbooks for the affected components need to be rewritten.'), migrationImpact: impact('WORSENS', `${done} completed task(s) on the affected components may become obsolete or need revalidation.`),
    implementationImpact: impact('WORSENS', 'New provisioning and integration work is required, and some completed work may not carry forward.'),
    newWork: [`Provision and configure the new setup for ${names}`, 'Update the connections that touch it', 'Update monitoring and security for it'], reusableWork: ['Identity and network design may partly carry forward'],
    recommendation: { verdict: 'PROCEED_WITH_CAUTION', rationale: c.kind === 'OTHER' ? 'The request does not clearly map to a component; review the scope before approving.' : `The change is feasible. Review the completed work at risk (${done} task(s)) and the new work before approving.` }, confidence: c.kind === 'OTHER' ? 0.4 : 0.75,
  };
}

export function mockChangePlan(input: { requestedChange: string; analysis: { affectedNodes: Array<{ key: string; relation: string }>; affectedDecisions: Array<{ key: string; relation: string }> }; architecture: Arch; requirements: Array<{ code: string; category: string; statement: string }>; drivers: Array<{ code: string; name: string }> }) {
  const arch = input.architecture; const c = classifyRequest(input.requestedChange); const ops: unknown[] = [];
  const directNodes = input.analysis.affectedNodes.filter((n) => n.relation === 'DIRECT').map((n) => arch.nodes.find((x) => x.stableKey === n.key)!).filter(Boolean);
  const dec = (d: Dec, over: Record<string, unknown>) => ({ title: d.title, problem: 'The decision had to be revisited because of an approved change request.', decision: d.decision, rationale: `${d.rationale} Revised after an approved change.`.slice(0, 1100), status: 'ACCEPTED', confidence: 0.7, tradeoffs: d.tradeoffs ?? [], risks: [], alternatives: [], consequences: [], driverCodes: d.driverCodes, requirementCodes: d.requirementCodes, nodeStableKeys: d.nodeStableKeys, edgeIds: [], ...over });
  if (c.kind === 'REPLACE' && directNodes[0]) {
    const n = directNodes[0]; const tech = title(c.to ?? 'New technology'); const aws = /aws|amazon|kinesis|dynamo|sqs|sns|s3|rds|msk|lambda|elasticache/i.test(c.to ?? ''); const azure = /azure/i.test(c.to ?? '');
    ops.push({ op: 'REPLACE_NODE', stableKey: n.stableKey, keepRole: true, newStableKey: null, node: { name: n.name, technology: tech.length >= 2 ? tech : 'New technology', technologySlug: kebab(tech) || 'new-technology', purpose: n.purpose.length >= 5 ? n.purpose : `${n.name} purpose`,
      description: `${n.name} now runs on ${tech}, keeping the same role in the architecture.`, managedService: aws || azure, deploymentModel: aws || azure ? 'MANAGED_SERVICE' : 'SELF_HOSTED', provider: aws ? 'AWS' : azure ? 'Azure' : n.provider, configuration: [{ key: 'migration', value: `Replaces ${n.technology}` }], risks: [], alternatives: [] } });
    for (const d of arch.decisions.filter((x) => x.nodeStableKeys.includes(n.stableKey) && input.analysis.affectedDecisions.some((a) => a.key === x.key))) {
      const swap = (s: string) => s.replace(new RegExp(n.technology.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), tech);
      ops.push({ op: 'SUPERSEDE_DECISION', key: d.key, decision: dec(d, { title: (swap(d.title) === d.title ? `${d.title} using ${tech}` : swap(d.title)).slice(0, 190).padEnd(5, '.'), decision: swap(d.decision).slice(0, 590), rationale: `Replace ${n.technology} with ${tech} as approved: the same role is kept, with the trade-offs reviewed in the change analysis.` }) });
    }
  } else if (c.kind === 'MULTI_REGION' && directNodes.length) {
    for (const n of directNodes) ops.push({ op: 'UPDATE_NODE', stableKey: n.stableKey, set: { configuration: [...n.configuration, { key: 'regions', value: 'active in two regions with replication' }].slice(0, 12) } });
    const req = input.requirements.find((r) => /region/i.test(r.statement)); const drv = input.drivers.find((d) => /changed requirement/i.test(d.name));
    ops.push({ op: 'ADD_DECISION', decision: { title: 'Operate the critical components across two regions', problem: 'A regional outage must not take the critical components down.', decision: 'Replicate the critical components into a second region and fail over between them.', rationale: 'The confirmed requirement is multi-region availability, so the critical components must exist in more than one region.',
      status: 'ACCEPTED', confidence: 0.7, tradeoffs: ['More operational complexity', 'Higher running cost'], risks: [], alternatives: [], consequences: [], driverCodes: drv ? [drv.code] : [], requirementCodes: req ? [req.code] : [], nodeStableKeys: directNodes.map((n) => n.stableKey), edgeIds: [] } });
  } else if (c.kind === 'REMOVE' && directNodes[0]) {
    ops.push({ op: 'REMOVE_NODE', stableKey: directNodes[0].stableKey });
    for (const d of arch.decisions.filter((x) => x.nodeStableKeys.length === 1 && x.nodeStableKeys[0] === directNodes[0]!.stableKey)) ops.push({ op: 'SUPERSEDE_DECISION', key: d.key, decision: dec(d, { title: `Operate without ${directNodes[0]!.name}`.slice(0, 190), decision: `The ${directNodes[0]!.name} component is removed from the architecture.`, rationale: 'The component was removed by an approved change; the work it did is no longer part of the system.', status: 'PROPOSED', nodeStableKeys: [] }) });
  } else if (c.kind === 'ADD') {
    const t = title(c.term ?? 'Added component');
    ops.push({ op: 'ADD_NODE', node: { stableKey: kebab(t) || 'added-component', name: t.length >= 2 ? t : 'Added component', technology: t.length >= 2 ? t : 'Added component', technologySlug: kebab(t) || 'added-component', category: 'OTHER', purpose: `Added by an approved change: ${t}`, description: `${t} was added to the architecture by an approved change request.`, criticality: 'MEDIUM', managedService: false, deploymentModel: 'OTHER', provider: null, configuration: [], risks: [], alternatives: [], replacesStableKey: null } });
  } else {
    ops.push({ op: 'ADD_DECISION', decision: { title: 'Record the requested change for follow-up', problem: 'A change was approved that does not map to a specific component.', decision: `Track this approved request: ${input.requestedChange}`.slice(0, 590), rationale: 'The request is recorded as a proposed decision so the team can refine it into concrete changes.', status: 'PROPOSED', confidence: 0.4, tradeoffs: [], risks: [], alternatives: [], consequences: [], driverCodes: [], requirementCodes: [], nodeStableKeys: [], edgeIds: [] } });
  }
  return { summary: `Apply the approved change: ${input.requestedChange}`.slice(0, 1100).padEnd(20, '.'), operations: ops, assumptionsAdded: [], risksAdded: [] };
}
export const mockReview = () => ({ assessment: 'The mock reviewer found nothing beyond the deterministic checks. This is not a real review.', findings: [] });

export function mockChangeFor(promptId: string, first: string): unknown | undefined {
  if (promptId === 'CHANGE_ANALYZER') return mockChangeAnalysis(parseDataBlock(first, 'change_analysis_input')!);
  if (promptId === 'CHANGE_PLANNER') return mockChangePlan(parseDataBlock(first, 'change_plan_input')!);
  if (promptId === 'ARCHITECTURE_REVIEWER') return mockReview();
  return undefined;
}
