import { describe, expect, it } from 'vitest';
import { citationSupportsClaim, deriveGrounding, inspectCommand, stripInvalidMarkers, validateClaims, versionNoteText, provenanceForLabel, type ClaimInput } from '../src';

const TLS = { n: 1, title: 'PostgreSQL connection settings', text: 'Enable TLS on the server and require it for remote clients in the client authentication file.' };
const claim = (over: Partial<ClaimInput>): ClaimInput => ({ text: 'Require TLS for remote clients', label: 'DOCUMENTED', citations: [1], projectRefs: [], ...over });
const validate = (claims: ClaimInput[], refs: string[] = ['ADR-001']) => validateClaims({ claims, sources: [TLS], projectRefs: new Set(refs), identityTerms: ['postgresql'] });

describe('citationSupportsClaim (K3: valid is not the same as relevant)', () => {
  it('accepts a passage that says what the claim says', () => expect(citationSupportsClaim('Require TLS for remote clients', TLS.text)).toBe(true));
  it('rejects a real passage about something else', () => expect(citationSupportsClaim('Autovacuum workers scale with table size', TLS.text)).toBe(false));
  it('does not count the technology name as support', () => expect(citationSupportsClaim('PostgreSQL is great', 'PostgreSQL connection settings and TLS', ['postgresql'])).toBe(false));
  it('one shared word is not enough when the claim has several topical words', () => expect(citationSupportsClaim('Rotate the replication slot credentials weekly', 'Replication is supported.')).toBe(false));
  it('a claim with no topical words is never supported', () => expect(citationSupportsClaim('It is the best way to do this', TLS.text)).toBe(false));
});

describe('validateClaims', () => {
  it('keeps a supported documented claim', () => expect(validate([claim({})])[0]).toMatchObject({ label: 'DOCUMENTED', citations: [1] }));
  it('drops a citation number that was never retrieved and downgrades the claim', () => {
    const [c] = validate([claim({ citations: [7] })]);
    expect(c).toMatchObject({ label: 'UNVERIFIED', citations: [], downgradedFrom: 'DOCUMENTED' });
  });
  it('downgrades a claim whose cited passage does not support it', () => {
    expect(validate([claim({ text: 'Autovacuum workers scale with table size' })])[0]).toMatchObject({ label: 'UNVERIFIED', citations: [] });
  });
  it('keeps the supported number and drops the unsupported one', () => {
    const r = validateClaims({ claims: [claim({ citations: [1, 2] })], sources: [TLS, { n: 2, title: 'Unrelated', text: 'Backups are scheduled nightly.' }], projectRefs: new Set(), identityTerms: [] });
    expect(r[0]!.citations).toEqual([1]);
  });
  it('requires a real project reference for project labels (case-insensitive)', () => {
    expect(validate([claim({ label: 'ARCHITECTURE_DECISION', citations: [], projectRefs: ['adr-001'] })])[0]).toMatchObject({ label: 'ARCHITECTURE_DECISION', projectRefs: ['adr-001'] });
    expect(validate([claim({ label: 'PROJECT_FACT', citations: [], projectRefs: ['REQ-099'] })])[0]).toMatchObject({ label: 'UNVERIFIED', projectRefs: [] });
  });
  it('never upgrades: an UNVERIFIED claim with a valid citation stays UNVERIFIED', () => expect(validate([claim({ label: 'UNVERIFIED' })])[0]!.label).toBe('UNVERIFIED'));
  it('a recommendation stays a recommendation', () => expect(validate([claim({ label: 'RECOMMENDATION', citations: [] })])[0]!.label).toBe('RECOMMENDATION'));
});

describe('stripInvalidMarkers', () => {
  it('removes markers that point at nothing and keeps valid ones', () => expect(stripInvalidMarkers('Use TLS [1] and rotate keys [4].', new Set([1]))).toBe('Use TLS [1] and rotate keys.'));
  it('leaves code fences alone', () => expect(stripInvalidMarkers('See:\n```\nx[3] = 1\n```\nok [9]', new Set())).toBe('See:\n```\nx[3] = 1\n```\nok'));
});

describe('inspectCommand', () => {
  it('finds placeholders the user must replace', () => expect(inspectCommand('aws rds describe-db-instances --region <REGION> --db-instance-identifier ${DB_ID} --profile YOUR_PROFILE').placeholders).toEqual(expect.arrayContaining(['<REGION>', '${DB_ID}', 'YOUR_PROFILE'])));
  it('finds none in a concrete command', () => expect(inspectCommand('kubectl get pods -n default').hasPlaceholders).toBe(false));
});

describe('deriveGrounding: the status comes from validated claims only', () => {
  const v = (label: 'DOCUMENTED' | 'UNVERIFIED' | 'RECOMMENDATION' | 'ARCHITECTURE_DECISION') => ({ text: 'x', label, citations: label === 'DOCUMENTED' ? [1] : [], projectRefs: [] });
  const d = (labels: Array<Parameters<typeof v>[0]>, extra: Partial<Parameters<typeof deriveGrounding>[0]> = {}) => deriveGrounding({ claims: labels.map(v), retrievedCount: 2, uncitedCommands: 0, versionMatch: 'NO_VERSION_REQUESTED', ...extra });
  it('GROUNDED: documented claims only (a labelled recommendation is fine)', () => { expect(d(['DOCUMENTED']).status).toBe('GROUNDED'); expect(d(['DOCUMENTED', 'RECOMMENDATION']).status).toBe('GROUNDED'); });
  it('PARTIALLY_GROUNDED: any unverified statement or uncited state-changing command', () => { expect(d(['DOCUMENTED', 'UNVERIFIED']).status).toBe('PARTIALLY_GROUNDED'); expect(d(['DOCUMENTED'], { uncitedCommands: 1 }).status).toBe('PARTIALLY_GROUNDED'); });
  it('PARTIALLY_GROUNDED when the documentation is for another version', () => expect(d(['DOCUMENTED'], { versionMatch: 'MISMATCH' }).status).toBe('PARTIALLY_GROUNDED'));
  it('PROJECT_FACT_ONLY: project claims and nothing else', () => expect(d(['ARCHITECTURE_DECISION'], { retrievedCount: 0 }).status).toBe('PROJECT_FACT_ONLY'));
  it('project claims plus uncited technical advice is not PROJECT_FACT_ONLY', () => expect(d(['ARCHITECTURE_DECISION', 'RECOMMENDATION']).status).toBe('PARTIALLY_GROUNDED'));
  it('UNGROUNDED: no claims, only recommendations, or only unverified', () => { expect(d([]).status).toBe('UNGROUNDED'); expect(d(['RECOMMENDATION']).status).toBe('UNGROUNDED'); expect(d(['UNVERIFIED']).status).toBe('UNGROUNDED'); });
  it('explains why in plain language', () => expect(d([], { retrievedCount: 0 }).reasons.join(' ')).toMatch(/No relevant official documentation/));
});

describe('labels and version notes', () => {
  it('maps labels to provenance', () => { expect(provenanceForLabel('DOCUMENTED')).toBe('OFFICIAL_DOCUMENTATION'); expect(provenanceForLabel('UNVERIFIED')).toBe('SYSTEM_DERIVED'); expect(provenanceForLabel('RECOMMENDATION')).toBe('AI_RECOMMENDATION'); });
  it('only mismatch and unknown produce a version note', () => {
    expect(versionNoteText('MISMATCH', '16')).toMatch(/different version.*\(16\)/);
    expect(versionNoteText('DOC_VERSION_UNKNOWN', '16')).toMatch(/does not state a version/);
    expect(versionNoteText('MATCHED', '16')).toBeNull(); expect(versionNoteText('NONE', null)).toBeNull();
  });
});
