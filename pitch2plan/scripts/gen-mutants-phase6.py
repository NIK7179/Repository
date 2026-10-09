import json
K='packages/schemas/src/knowledge.ts'
T_CORE='packages/schemas/test/knowledge-core.test.ts'; T_RETR='packages/schemas/test/knowledge-retrieval.test.ts'
T_MODEL='test/integration/knowledge-model.test.ts'; T_ING='test/integration/knowledge-ingestion.test.ts'; T_IRET='test/integration/knowledge-retrieval.test.ts'; T_FETCH='test/unit/knowledge-fetcher.test.ts'
MIG='packages/db/prisma/migrations/20261010000000_knowledge/migration.sql'; REPO='packages/db/src/repositories-knowledge.ts'
FETCHER='packages/domain/src/knowledge-fetcher.ts'; SERVICE='packages/domain/src/knowledge.ts'; FIX='packages/domain/src/knowledge-fixtures.ts'
RETR='packages/domain/src/knowledge-retrieval.ts'
def m(id,what,file,old,new,tests): return dict(id=id,what=what,file=file,old=old,new=new,tests=tests)
M=[
 m('untrusted-source-accepted','allow-list host check removed',K,"if (!allowedDomains.some((a) => host === a || host.endsWith(`.${a}`))) return","if (false) return",[T_CORE]),
 m('https-only-removed','https-only rule removed',K,"if (u.protocol !== 'https:') return","if (false) return",[T_CORE]),
 m('source-domain-suffix-trick','subdomain match loosened to substring',K,"host === a || host.endsWith(`.${a}`)","host.includes(a)",[T_CORE]),
 m('redirect-hop-not-revalidated','redirect hops not re-validated',FETCHER,"if (!check.ok) throw new FetchError(hop === 0 ? 'URL_NOT_ALLOWED' : 'REDIRECT_NOT_ALLOWED', check.reason);","if (!check.ok && hop === 0) throw new FetchError('URL_NOT_ALLOWED', check.reason);\n      if (!check.ok) { return { finalUrl: current, contentType: 'text/html', body: '', lastModified: null }; }",[T_FETCH]),
 m('final-url-trusted','fetcher-reported final URL no longer validated',SERVICE,"if (!finalCheck.ok) throw new FetchError('REDIRECT_NOT_ALLOWED', finalCheck.reason);","",[T_ING]),
 m('fixtures-always-on','fixture fetcher runs without explicit permission',FIX,"if (!this.o.allow) throw","if (false) throw",[T_ING]),
 m('relevance-gate-removed','relevance gate removed',K,"const relevant = (matched >= required && wanted.size > 0) ||","const relevant = true ||",[T_RETR,T_IRET]),
 m('relevance-single-word','one shared word is enough again',K,"const required = wanted.size >= 2 ? 2 : 1;","const required = 1;",[T_RETR]),
 m('lexical-embedder-vouches','semantic threshold applies to non-semantic embedders',RETR,"semanticRelevance: embedder.semantic ? cfg.semanticRelevance : null","semanticRelevance: cfg.semanticRelevance",[T_IRET,T_RETR]),
 m('technology-filter-removed','technology filter removed from candidate search',REPO,'WHERE c."technologySlug" = ANY(${technologySlugs}::text[]) AND c.tsv','WHERE c.tsv',[T_MODEL,T_IRET]),
 m('technology-score-removed','technology match no longer scored',K,"const technology = c.technologySlug === primary ? 1 : q.technologySlugs.includes(c.technologySlug) ? 0.6 : 0;","const technology = 0;",[T_RETR]),
 m('version-filter-removed','version match no longer scored',K,"const version = versionNote === 'MATCHED' ? 1 : versionNote === 'MISMATCH' ? -1 : 0;","const version = 0;",[T_RETR]),
 m('version-unknown-reported-matched','unknown doc version reported as matched',K,"!docMajor ? 'DOC_VERSION_UNKNOWN'","!docMajor ? 'MATCHED'",[T_RETR,T_IRET]),
 m('stale-flag-removed','stale-source flag removed',K,"const stale = isStale(c.checkedAt, now, staleDays);","const stale = false;",[T_RETR,T_IRET]),
 m('quarantine-removed','instruction-like chunks no longer quarantined',K,"if (c.injectionScore >= budget.quarantineAt) { quarantined++; continue; }","",[T_RETR,T_IRET]),
 m('delimiter-neutralization-removed','retrieved text no longer neutralized',K,"s.replace(/</g, '‹').replace(/>/g, '›').replace(/^\\s*(system|assistant|human|user)\\s*:/gim, '$1 -');","s;",[T_CORE,T_RETR]),
 m('budget-per-document-removed','per-document cap removed',K,"if ((perDoc.get(c.documentId) ?? 0) >= budget.maxPerDocument) continue;","",[T_RETR]),
 m('one-active-ingestion-index-removed','one-active-ingestion unique index removed',MIG,'CREATE UNIQUE INDEX "KnowledgeIngestionRun_one_active_per_source" ON "KnowledgeIngestionRun"("sourceId") WHERE "status" IN (\'PENDING\',\'RUNNING\');',"",[T_MODEL,T_ING]),
 m('citation-append-only-removed','citation append-only trigger removed',MIG,'CREATE TRIGGER "p2p_citation_append_only" BEFORE UPDATE ON "KnowledgeCitation" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_citation"();',"",[T_MODEL]),
 m('version-immutability-removed','document-version immutability trigger removed',MIG,'CREATE TRIGGER "p2p_knowledge_version_immutable" BEFORE UPDATE ON "KnowledgeDocumentVersion" FOR EACH ROW EXECUTE FUNCTION "p2p_guard_knowledge_version"();',"",[T_MODEL]),
 m('version-on-hash-change-removed','unchanged content creates a new version',REPO,"if (active && active.contentHash === input.contentHash) return","if (false) return",[T_MODEL,T_ING]),
 m('superseded-chunks-kept','superseded chunks stay in the index',REPO,"await tx.knowledgeChunk.deleteMany({ where: { documentVersionId: active.id } });","",[T_MODEL,T_ING]),
 m('claim-cas-removed','run claim no longer compare-and-set',REPO,"where: { id, OR: [{ status: 'PENDING' }, { status: 'RUNNING', heartbeatAt: { lt: staleBefore } }] },","where: { id },",[T_MODEL,T_ING]),
 m('finish-cas-removed','finishing a run no longer compare-and-set',REPO,"updateMany({ where: { id, status: 'RUNNING' }, data })","updateMany({ where: { id }, data })",[T_MODEL]),
 m('ingestion-idempotency-removed','duplicate ingest request creates another run',SERVICE,"if (!created) return { run, created: false };","if (false) return { run, created: false };",[T_ING]),
]
G='packages/schemas/src/grounding.ts'; A='packages/domain/src/assistant.ts'; ACC='packages/domain/src/knowledge-access.ts'
T_GR='packages/schemas/test/grounding.test.ts'; T_GA='test/integration/grounded-assistant.test.ts'
M += [
 m('cp4-citation-number-trusted','any cited number is trusted (no check against retrieval)',G,"return !!s && citationSupportsClaim(c.text, `${s.title} ${s.text}`, input.identityTerms); });","return true; });",[T_GR,T_GA]),
 m('cp4-relevance-of-citation-skipped','a real citation is accepted without checking it supports the claim',G,"return !!s && citationSupportsClaim(c.text, `${s.title} ${s.text}`, input.identityTerms);","return !!s;",[T_GR,T_GA]),
 m('cp4-support-threshold-single-word','one shared word counts as support',G,"const required = wanted.length >= 2 ? 2 : 1;\n  return wanted.filter","const required = 1;\n  return wanted.filter",[T_GR]),
 m('cp4-documented-label-kept','unsupported DOCUMENTED claim keeps its label',G,"if (c.label === 'DOCUMENTED' && !citations.length) down(","if (false) down(",[T_GR,T_GA]),
 m('cp4-project-ref-unchecked','project labels accepted without a real reference',G,"(c.label === 'PROJECT_FACT' || c.label === 'ARCHITECTURE_DECISION') && !projectRefs.length","false",[T_GR,T_GA]),
 m('cp4-grounded-without-documentation','GROUNDED reachable with zero documented claims',G,"if (documented > 0) {","if (documented >= 0) {",[T_GR,T_GA]),
 m('cp4-grounded-despite-unverified','GROUNDED despite unverified statements',G,"if (unverified === 0 && i.uncitedCommands === 0) status = 'GROUNDED';","status = 'GROUNDED'; if (false) status = 'GROUNDED';",[T_GR,T_GA]),
 m('cp4-version-mismatch-ignored','version mismatch does not lower the status',G,"if (i.versionMatch === 'MISMATCH' && status === 'GROUNDED')","if (false)",[T_GR]),
 m('cp4-invalid-markers-kept','dangling [n] markers stay in the answer',G,"(valid.has(Number(n)) ? m : '')","m",[T_GR,T_GA]),
 m('cp4-placeholders-not-flagged','command placeholders not detected',G,"for (const re of PLACEHOLDER) for","for (const re of [] as RegExp[]) for",[T_GR,T_GA]),
 m('cp4-uncited-commands-ignored','uncited state-changing commands do not affect the status',A,"const uncited = commands.filter((c) => !c.documented && c.risk !== 'READ_ONLY').length + codeBlocks.filter((b) => !b.citations.length).length;","const uncited = 0;",[T_GA]),
 m('cp4-command-citation-unverified','a command may cite any number',A,"const cites = supported(`${c.purpose} ${c.command}`, c.citations);","const cites = c.citations;",[T_GA]),
 m('cp4-code-citation-unverified','a code block may cite any number',A,"citations: supported(`${b.purpose} ${b.filename ?? ''}`, b.citations) }));","citations: b.citations }));",[T_GA]),
 m('cp4-documents-not-given-to-model','retrieved documentation is not passed to the model',A,"history, question: input.message, documents, signal })","history, question: input.message, documents: undefined, signal })",[T_GA]),
 m('cp4-citations-from-all-retrieved','every retrieved passage is shown as a citation even if unused',A,"retrieved.filter((c) => usedNumbers.has(c.n))","retrieved",[T_GA]),
 m('cp4-citation-auth-removed','citations readable across workspaces',ACC,"try { await requireProjectAccess(repos, ctx.userId, rec.projectId, 'read'); }","try { }",[T_GA]),
 m('cp4-task-docs-auth-removed','task documentation readable across workspaces',ACC,"try { await requireProjectAccess(repos, ctx.userId, task.projectId, 'read'); }","try { }",[T_GA]),
 m('cp4-component-docs-auth-removed','component documentation readable across workspaces',ACC,"const { project } = await requireProjectAccess(repos, ctx.userId, projectId, 'read');","const project = (await repos.projects.findById(projectId))!;",[T_GA]),
 m('cp4-search-project-auth-removed','project-scoped search skips authorization',ACC,"if (input.projectId) await requireProjectAccess(repos, ctx.userId, input.projectId, 'read');","",[T_GA]),
 m('cp4-document-delimiter-neutralization-removed','retrieved text placed in the prompt un-neutralized',K,"${neutralizeUntrusted(texts.get(c.chunkId) ?? c.excerpt)}","${(texts.get(c.chunkId) ?? c.excerpt)}",[T_CORE,T_RETR,T_GA]),
]
json.dump(M,open('scripts/mutants-phase6.json','w'),indent=1); print(len(M))
