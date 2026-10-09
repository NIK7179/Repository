# Product state and invariants

Living summary of what Pitch2Plan is and the rules that must keep holding. Read this before changing behaviour. Each invariant names the test that enforces it.

## Where the product is

| Phase | Capability | State |
|---|---|---|
| 1 | Auth boundary, projects, pitch, IdeaInterpreter, AI gateway | done |
| 2 | Dynamic discovery, requirements (versioned, origin-tagged), Architecture Brief, confirmation | done |
| 3 | Architecture generation job (plan → validate → critique → repair), immutable versions, stable keys, traceability, canvas | done |
| 4 | Implementation plans bound to architecture versions, task progress, component workspace, Ask Architect | done |
| 5 | Change proposals, impact analysis, new architecture/plan versions, progress migration, production readiness review | done |
| 6 | Trusted knowledge: allow-listed documentation ingestion, retrieval, citations, server-side grounding | in this release |

## Invariants carried from earlier phases (do not weaken)

1. A READY architecture version is immutable (DB trigger). Change creates a new version.
2. Completion is `USER_CONFIRMED` unless an external system verified it. **Documentation is not verification** — `SYSTEM_VERIFIED` is never set from retrieved text.
3. No AI call approves, applies or executes anything. Commands are classified by deterministic rules, never run.
4. Authorization is checked on every project-scoped read and write; another workspace's ids answer "not found".
5. Jobs are idempotent: claim by compare-and-set, unique indexes for "one active run", stale-run recovery.

## Phase 6 invariants (lessons from the first, lost, implementation attempt)

**K1. Grounding status is determined by application code, not the LLM.**
The model may only point at numbered documents it was shown and label its own claims. `validateClaims` verifies every citation number against what was actually retrieved, and `GROUNDED | PARTIALLY_GROUNDED | UNGROUNDED | PROJECT_FACT_ONLY` is derived from that. A model-supplied status, URL or citation id is ignored. Citation URLs/titles are copied from stored source records.

**K2. Retrieval relevance must pass deterministic checks before a citation can support an answer.**
A chunk is eligible only if it shares real full-text terms with the question's topical terms (or a genuinely semantic embedding provider clears a calibrated threshold). The bundled local embedder is lexical hashing: it can re-rank but it cannot prove relevance. Insufficient relevance yields `PARTIALLY_GROUNDED` or `UNGROUNDED` — never a fabricated or filler citation.

**K3. A technically valid citation is not automatically a relevant citation.**
A real, trusted, correctly attributed AWS page can be completely irrelevant to the question. "The URL is allow-listed and the chunk exists" proves provenance, not relevance. Provenance checks (K1) and relevance checks (K2) are separate gates and both must pass.

**K4. Test categories that need different runtime topologies must not be mixed in one fragile suite.**
- `vitest.config.ts` — unit + integration (Postgres, in-process app, `ManualQueue`, mock AI, fixture fetcher).
- `vitest.ui.config.ts` — UI/HTTP tests against a real production `next start` server on its own port and database.
- `e2e/` — Playwright against a real browser (needs a browser binary).
Each has its own config, setup and port. Do not import one category's harness into another.

**K5. Only allow-listed hosts are ever fetched.** The registry in `packages/schemas/src/knowledge.ts` is the only source of hosts; the allow-list is re-checked on every redirect hop. The model never supplies a URL to fetch.

**K6. Retrieved text is untrusted data.** It is delimited, neutralized, scored for injection phrases, and the system prompt says it is reference material only. It can never change architecture, call tools, or reveal context.

**K7. Test fixtures are labelled and gated.** Fixture pages are titled "[Test fixture]", paraphrased (not copied vendor text), and the fixture fetcher refuses to run unless `ALLOW_FIXTURE_DOCS=true`. They are never presented as real documentation.

**K8. Citations are snapshots.** A citation keeps what the user saw when the answer was produced (append-only). Refreshing a document never rewrites an old answer's citations.

## Known gaps (honest list)
See "Known limitations" in `README.md` and ADR-012. In short: seed URLs were not verified against the live sites from the build environment; the local embedder is lexical; pgvector is not installed; no live model evaluation has run.
