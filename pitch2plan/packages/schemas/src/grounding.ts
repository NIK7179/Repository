import { z } from 'zod';
import { CLAIM_LABELS, stemWord, topicWords, type ClaimLabel, type CitationDto, type GroundingStatus, type VersionNote } from './knowledge';

/**
 * GROUNDING IS A SERVER-SIDE PROPERTY (invariants K1, K3).
 * The model may only POINT at retrieved documents by number and PROPOSE a label for each claim. Everything else - whether a number exists,
 * whether the cited passage actually supports the claim, which label survives and the final grounding status - is decided here, deterministically.
 * A model-supplied status, URL, title or citation id is never read.
 */

export const claimSchema = z.object({
  text: z.string().trim().min(3).max(500),
  /** A proposal. The server may downgrade it; it never upgrades it. */
  label: z.enum(CLAIM_LABELS).default('UNVERIFIED'),
  /** Numbers of <document n="..."> blocks the claim rests on. */
  citations: z.array(z.number().int().min(1).max(50)).max(6).default([]),
  /** Codes like ADR-001, REQ-001 or a task key. */
  projectRefs: z.array(z.string().trim().max(40)).max(6).default([]),
});
export type ClaimInput = z.infer<typeof claimSchema>;

export interface ValidatedClaim { text: string; label: ClaimLabel; citations: number[]; projectRefs: string[]; downgradedFrom?: ClaimLabel; reason?: string }

export interface GroundingSource { n: number; text: string; title: string }
export interface GroundingResult {
  status: GroundingStatus;
  /** Plain-language reasons shown in the UI so the label is explainable. */
  reasons: string[];
  documentedClaims: number; unverifiedClaims: number; projectClaims: number; recommendationClaims: number;
}

/** Words that prove nothing about support (technology and provider identity). */
export function supportTerms(claimText: string, identity: string[] = []): string[] {
  const skip = new Set(identity.map(stemWord));
  return [...new Set(topicWords(claimText).map(stemWord))].filter((w) => !skip.has(w));
}

/**
 * A technically valid citation is not automatically a relevant one (K3). The cited passage must share topical words with the claim:
 * two when the claim has two or more, otherwise one. Identity words (e.g. the technology name) do not count.
 */
export function citationSupportsClaim(claimText: string, sourceText: string, identity: string[] = []): boolean {
  const wanted = supportTerms(claimText, identity);
  if (!wanted.length) return false;
  const stems = new Set(topicWords(sourceText).map(stemWord));
  const required = wanted.length >= 2 ? 2 : 1;
  return wanted.filter((w) => stems.has(w)).length >= required;
}

export interface ValidateClaimsInput {
  claims: ClaimInput[];
  /** Only these numbers exist. They come from the retrieval step, never from the model. */
  sources: GroundingSource[];
  /** Project codes that really exist (ADR-001, REQ-002, task keys). */
  projectRefs: Set<string>;
  identityTerms?: string[];
}

export function validateClaims(input: ValidateClaimsInput): ValidatedClaim[] {
  const byN = new Map(input.sources.map((s) => [s.n, s]));
  const refsUpper = new Set([...input.projectRefs].map((r) => r.toUpperCase()));
  return input.claims.map((c): ValidatedClaim => {
    const citations = [...new Set(c.citations)].filter((n) => { const s = byN.get(n); return !!s && citationSupportsClaim(c.text, `${s.title} ${s.text}`, input.identityTerms); });
    const projectRefs = [...new Set(c.projectRefs.map((r) => r.trim()))].filter((r) => refsUpper.has(r.toUpperCase()));
    const out: ValidatedClaim = { text: c.text, label: c.label, citations, projectRefs };
    const down = (to: ClaimLabel, reason: string) => { out.downgradedFrom = c.label; out.label = to; out.reason = reason; };
    if (c.label === 'DOCUMENTED' && !citations.length) down('UNVERIFIED', c.citations.length ? 'The cited documentation does not support this statement.' : 'No supporting documentation was cited.');
    else if ((c.label === 'PROJECT_FACT' || c.label === 'ARCHITECTURE_DECISION') && !projectRefs.length) down('UNVERIFIED', 'No matching project requirement or decision was referenced.');
    else if (c.label === 'RECOMMENDATION' && citations.length) { /* a recommendation that cites documentation stays a recommendation */ }
    return out;
  });
}

/** Removes [n] markers that do not point at a real, supporting citation. The reader must never see a marker that resolves to nothing. */
export function stripInvalidMarkers(answer: string, valid: Set<number>): string {
  const parts = answer.split(/(```[\s\S]*?```)/g);
  return parts.map((p, i) => (i % 2 === 1 ? p : p.replace(/\s?\[(\d{1,2})\]/g, (m, n: string) => (valid.has(Number(n)) ? m : '')))).join('');
}

export interface CommandInspection { placeholders: string[]; hasPlaceholders: boolean }
const PLACEHOLDER = [/<[A-Za-z][A-Za-z0-9_ -]{0,40}>/g, /\$\{[A-Z][A-Z0-9_]{1,40}\}/g, /\bYOUR[_-][A-Z0-9_-]+\b/g, /\b(?:example|my)-(?:bucket|cluster|db|database|stack|topic|role|queue|instance)[\w-]*/gi, /\bXXXX+\b/g];
/** Commands copied blindly are the dangerous ones: surface every value the user must replace. */
export function inspectCommand(command: string): CommandInspection {
  const found = new Set<string>();
  for (const re of PLACEHOLDER) for (const m of command.matchAll(re)) found.add(m[0]);
  return { placeholders: [...found].slice(0, 8), hasPlaceholders: found.size > 0 };
}

export interface DeriveInput { claims: ValidatedClaim[]; retrievedCount: number; uncitedCommands: number; versionMatch: VersionNote | 'NONE' }

export function deriveGrounding(i: DeriveInput): GroundingResult {
  const count = (l: ClaimLabel) => i.claims.filter((c) => c.label === l).length;
  const documented = count('DOCUMENTED'), unverified = count('UNVERIFIED'), project = count('PROJECT_FACT') + count('ARCHITECTURE_DECISION'), rec = count('RECOMMENDATION');
  const reasons: string[] = [];
  let status: GroundingStatus;
  if (documented > 0) {
    if (unverified === 0 && i.uncitedCommands === 0) status = 'GROUNDED';
    else { status = 'PARTIALLY_GROUNDED'; if (unverified) reasons.push(`${unverified} statement${unverified === 1 ? '' : 's'} could not be tied to documentation or the project.`); if (i.uncitedCommands) reasons.push(`${i.uncitedCommands} command${i.uncitedCommands === 1 ? ' is' : 's are'} not backed by documentation.`); }
  } else if (project > 0 && unverified === 0 && rec === 0 && i.uncitedCommands === 0) {
    status = 'PROJECT_FACT_ONLY'; reasons.push('This answer rests on your project\'s requirements and decisions, not on external documentation.');
  } else if (project > 0) {
    status = 'PARTIALLY_GROUNDED'; reasons.push('Only the project-specific statements are backed by your requirements and decisions; the technical guidance is not backed by documentation.');
  } else {
    status = 'UNGROUNDED';
    reasons.push(i.retrievedCount === 0 ? 'No relevant official documentation was found for this question.' : 'The retrieved documentation did not support any statement in this answer.');
  }
  if (i.versionMatch === 'MISMATCH' && status === 'GROUNDED') { status = 'PARTIALLY_GROUNDED'; reasons.push('The documentation is for a different version than your architecture specifies.'); }
  return { status, reasons, documentedClaims: documented, unverifiedClaims: unverified, projectClaims: project, recommendationClaims: rec };
}

export function versionNoteText(note: VersionNote | 'NONE', requested: string | null): string | null {
  switch (note) {
    case 'MISMATCH': return `The documentation found is for a different version than${requested ? ` the one in your architecture (${requested})` : ' your architecture'}. Check the behaviour against your version.`;
    case 'DOC_VERSION_UNKNOWN': return `The documentation does not state a version${requested ? `, so it could not be matched to ${requested}` : ''}. Confirm the details for your version.`;
    default: return null;
  }
}

export const provenanceForLabel = (l: ClaimLabel): 'PROJECT_REQUIREMENT' | 'ARCHITECTURE_DECISION' | 'OFFICIAL_DOCUMENTATION' | 'AI_RECOMMENDATION' | 'SYSTEM_DERIVED' =>
  l === 'PROJECT_FACT' ? 'PROJECT_REQUIREMENT' : l === 'ARCHITECTURE_DECISION' ? 'ARCHITECTURE_DECISION' : l === 'DOCUMENTED' ? 'OFFICIAL_DOCUMENTATION' : l === 'RECOMMENDATION' ? 'AI_RECOMMENDATION' : 'SYSTEM_DERIVED';

export interface MessageGrounding {
  status: GroundingStatus; reasons: string[]; versionNote: string | null;
  availability: 'READY' | 'PREPARING' | 'UNAVAILABLE' | 'NOT_COVERED' | 'NONE';
  retrievedCount: number;
}
export type MessageCitation = CitationDto;
