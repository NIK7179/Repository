# ADR-011: Documentation comes from allow-listed official sources, and grounding is decided by the server
**Status:** accepted

**Context.** Users act on the assistant's technical guidance. A fluent answer that invents a setting, cites a page that does not say it, or follows instructions hidden in a web page is worse than no answer. The first attempt at this phase was lost, and the lessons became invariants (K1–K8 in `docs/PRODUCT_STATE.md`).

**Decision.**
1. **Sources.** A curated registry names, per technology, the official hosts and seed URLs. A URL is fetchable only if it is https, has no credentials, port or IP literal, and its host equals an allowed domain or is a subdomain of one. The check runs before the first request, on every redirect hop, and on the final URL the fetcher reports. The model never supplies a URL.
2. **Storage.** Documents are versioned by content hash: a new version only when the hash changes, superseded chunks leave the index, and an unchanged refresh only bumps `checkedAt` (staleness is measured from it). Ingestion is an idempotent job (compare-and-set claim, one active run per source, stale-run recovery).
3. **Untrusted data.** Retrieved text is scored for instruction-like phrases, neutralized, numbered and placed in a delimited block that the prompt declares to be reference data. Chunks above the quarantine score never reach the model.
4. **Grounding is derived, not asserted.** The model proposes claims (text, label, citation numbers, project refs). The server verifies each number against what was actually retrieved, verifies that the cited passage supports the claim, verifies project refs against real codes, downgrades what fails, and computes `GROUNDED | PARTIALLY_GROUNDED | UNGROUNDED | PROJECT_FACT_ONLY`. Answers with no supported documentation say so and are never labelled grounded to satisfy a schema.
5. **Citations are append-only snapshots**, saved before the message that references them, readable only by members of the project's workspace.
6. **Documentation is not verification.** Nothing here sets `SYSTEM_VERIFIED`.

**Consequences.** A wrong or missing citation is visible as such; the model cannot upgrade its own answer; some correct answers will be shown as partly grounded because the index lacks the page. The registry must be maintained, and its URLs need checking against the live sites (`npm run eval:grounding`).
