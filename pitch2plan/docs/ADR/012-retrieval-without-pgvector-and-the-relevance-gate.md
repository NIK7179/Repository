# ADR-012: Retrieval uses full-text search plus a relevance gate; semantic embeddings are optional and never vouch alone
**Status:** accepted

**Context.** pgvector is not available in every deployment, and the only embedder bundled with the repository is a deterministic lexical hashing embedder. A real, trusted, correctly attributed AWS page can be entirely irrelevant to the question asked: provenance (K5) is not relevance (K2, K3).

**Decision.**
1. **Candidates** come from Postgres full-text search (`tsvector` generated column, GIN index) restricted to the technologies in play (a managed variant also pulls in its base technology, e.g. MSK → Kafka). A chunk that shares no word with the question is never a candidate.
2. **Ranking** is hybrid and deterministic: semantic similarity (0.30), keyword coverage (0.25), technology (0.18), provider (0.04), version (0.08), trust (0.10), staleness (−0.06), injection (−0.25). Embeddings are stored as `DOUBLE PRECISION[]` and compared in application code.
3. **The relevance gate.** A chunk is eligible only if at least two topical stems of the question appear in it (one when the question has a single topical word), or a provider that declares `semantic=true` reaches cosine ≥ 0.35. Technology and provider names ("identity words") never count. Ineligible chunks score −1 and cannot become citations. The hashing embedder declares `semantic=false`: it can re-rank but cannot vouch.
4. **Vague questions** are anchored on the task and step titles; specific questions are never widened.
5. **Budget.** At most 6 chunks, 1800 tokens, 2 per document.
6. **Claim-level check.** After generation, each cited passage must again share topical words with the claim it is cited for (`citationSupportsClaim`).

**Consequences.** Precision is favoured over recall: paraphrased questions can miss, and the answer is then honestly ungrounded. Adding pgvector and a real embedding model later changes only `EmbeddingProvider` and the candidate query; the gate, the claim check and every test of them stay. Reindexing is a job (`knowledge.reindex`) keyed by embedding model version.
