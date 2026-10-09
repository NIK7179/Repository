import { mockArchitectureFor } from './mock-architecture';
import { mockChangeFor } from './mock-change';
import { mockImplementationFor } from './mock-implementation';
import { mockDiscoveryFor } from './mock-discovery';
import { AIError, type LLMProvider, type LLMRequest, type LLMResult, type LLMStreamChunk } from '../types';

export type MockScriptItem = string | Error;
export interface MockOptions {
  /** Scripted responses, consumed in order (the last repeats). Strings are returned as-is; Errors are thrown. */
  script?: MockScriptItem[];
  delayMs?: number;
  model?: string;
}

/**
 * Deterministic provider for development and tests. With no script it derives a plausible,
 * schema-valid interpretation from the pitch text using simple heuristics. It is NOT a product
 * feature and contains no architecture knowledge.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  readonly calls: LLMRequest[] = [];
  constructor(private readonly opts: MockOptions = {}) {}

  async generate(req: LLMRequest): Promise<LLMResult> {
    const index = this.calls.push(req) - 1;
    if (this.opts.delayMs) await sleepAbortable(this.opts.delayMs, req.signal);
    const script = this.opts.script;
    let text: string;
    if (script?.length) {
      const item = script[Math.min(index, script.length - 1)]!;
      if (item instanceof Error) throw item;
      text = item;
    } else {
      const promptId = /PROMPT_ID: ([A-Z_]+?)_V\d+/.exec(req.system)?.[1];
      const last = req.messages.at(-1)?.content ?? '';
      const first = req.messages[0]?.content ?? '';
      const discovery = promptId ? (mockDiscoveryFor(promptId, first) ?? mockArchitectureFor(promptId, first) ?? mockImplementationFor(promptId, first, last) ?? mockChangeFor(promptId, first)) : undefined;
      text = typeof discovery === 'string' ? discovery : JSON.stringify(discovery ?? heuristicInterpretation(extractPitch(req)));
    }
    return {
      text, provider: this.name, model: req.model ?? this.opts.model ?? 'mock-1',
      usage: { inputTokens: Math.ceil(JSON.stringify(req.messages).length / 4), outputTokens: Math.ceil(text.length / 4) },
      stopReason: 'end_turn',
    };
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMStreamChunk> {
    const result = await this.generate(req);
    for (let i = 0; i < result.text.length; i += 40) yield { type: 'delta', text: result.text.slice(i, i + 40) };
    yield { type: 'done', result };
  }
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new AIError('AI_TIMEOUT', 'aborted', true)); }, { once: true });
  });
}

function extractPitch(req: LLMRequest): string {
  const m = /<user_pitch>\n([\s\S]*?)\n<\/user_pitch>/.exec(req.messages[0]?.content ?? '');
  return m?.[1] ?? '';
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function heuristicInterpretation(pitch: string) {
  const sentences = pitch.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const first = sentences[0] ?? pitch.trim();
  const userWords = /\b(customers?|users?|merchants?|developers?|teams?|patients?|students?|drivers?|sellers?|buyers?|clients?|employees?|analysts?|freelancers?)\b/gi;
  const verbs = /\b(process(?:es|ing)?|detect(?:s|ing)?|stor(?:e|es|ing)|publish(?:es|ing)?|analy[sz](?:e|es|ing)|track(?:s|ing)?|send(?:s|ing)?|notif(?:y|ies|ying)|recommend(?:s|ing)?|schedul(?:e|es|ing)|book(?:s|ing)?|match(?:es|ing)?|monitor(?:s|ing)?|generat(?:e|es|ing)|ingest(?:s|ing)?|collect(?:s|ing)?)\b(?: [\w-]+){1,5}/gi;
  const uniq = <T,>(arr: T[], key: (t: T) => string) => [...new Map(arr.map((a) => [key(a).toLowerCase(), a])).values()];

  const targetUsers = uniq([...pitch.matchAll(userWords)].map((m) => ({ text: m[0], origin: 'USER_STATED' as const, evidence: m[0] })), (u) => u.text).slice(0, 5);
  const possibleCapabilities = uniq([...pitch.matchAll(verbs)].map((m) => ({ text: clip(m[0], 280), origin: 'USER_STATED' as const, evidence: clip(m[0], 380) })), (c) => c.text).slice(0, 6);

  const rules: Array<[RegExp, string, string, number, string]> = [
    [/real[- ]?time|continuous|instant|live|streaming/i, 'NON_FUNCTIONAL', 'Low-latency processing is likely required.', 0.7, 'The pitch mentions real-time or continuous behaviour.'],
    [/million|billion|thousands of|high volume|at scale|\bscale\b/i, 'NON_FUNCTIONAL', 'The system must scale to high data or request volume.', 0.65, 'The pitch implies large volumes.'],
    [/fraud|payment|transaction|bank|financial|card/i, 'COMPLIANCE', 'Financial data may bring regulatory obligations such as PCI-DSS.', 0.45, 'Financial or payment data is mentioned.'],
    [/fraud|payment|transaction|bank|financial|card/i, 'SECURITY', 'Sensitive financial data needs encryption and strict access control.', 0.6, 'Financial or payment data is mentioned.'],
    [/user|customer|account|login|sign in/i, 'SECURITY', 'End users need authentication and authorization.', 0.5, 'End users or accounts are mentioned.'],
    [/analytics|report|dashboard|insight/i, 'DATA', 'Stored data must be queryable for analysis.', 0.55, 'Analytics or reporting is mentioned.'],
  ];
  const inferredRequirements = rules.filter(([re]) => re.test(pitch)).map(([, type, description, confidence, rationale]) => ({
    type, description, confidence, rationale, origin: 'AI_INFERRED' as const,
  }));
  inferredRequirements.push({ type: 'OPERATIONAL', description: 'Monitoring and alerting will be needed to run this in production.', confidence: 0.4, rationale: 'Applies to most production systems.', origin: 'AI_INFERRED' });

  return {
    summary: clip(`In the user's words: ${first}`, 600),
    problemStatement: clip(`The user wants to address this need: ${first}`, 600),
    targetUsers,
    possibleCapabilities,
    userStatedFacts: sentences.slice(0, 3).map((s) => ({ statement: clip(s, 290), quote: clip(s, 390) })),
    inferredRequirements,
    assumptions: [
      'Scale, latency and availability targets were not stated; a production-grade system is assumed.',
      ...(targetUsers.length ? [] : ['The intended users were not named in the pitch.']),
    ],
    unknowns: ['Expected data or request volume', 'Latency and availability expectations', 'Budget and team constraints', 'Cloud or platform preference', 'Security and compliance obligations'],
    recommendedDiscoveryAreas: ['Scale and volume', 'Latency and processing mode', 'Availability and reliability', 'Security and compliance', 'Budget and team', 'Platform preferences'],
  };
}
