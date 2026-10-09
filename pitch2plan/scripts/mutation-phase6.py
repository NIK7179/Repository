#!/usr/bin/env python3
"""Phase 6 mutation checks. Works on a COPY of the repo (so it never touches the working tree), restores each mutated file in `finally`,
runs one mutant at a time with a timeout, and writes the result to /mnt/user-data/outputs/verification/mutation-phase6.json.
Usage: python3 scripts/mutation-phase6.py <copy-dir> [only-substring]
"""
import json, os, subprocess, sys, time

COPY = sys.argv[1]; ONLY = sys.argv[2] if len(sys.argv) > 2 else ''
OUT = '/mnt/user-data/outputs/verification/mutation-phase6.json'
K_SCHEMA = 'packages/schemas/src/knowledge.ts'
T_CORE = 'packages/schemas/test/knowledge-core.test.ts'
T_RETR = 'packages/schemas/test/knowledge-retrieval.test.ts'
T_MODEL = 'test/integration/knowledge-model.test.ts'
T_ING = 'test/integration/knowledge-ingestion.test.ts'
T_IRET = 'test/integration/knowledge-retrieval.test.ts'
T_FETCH = 'test/unit/knowledge-fetcher.test.ts'
MIG = 'packages/db/prisma/migrations/20261010000000_knowledge/migration.sql'
REPO = 'packages/db/src/repositories-knowledge.ts'
FETCHER = 'packages/domain/src/knowledge-fetcher.ts'
SERVICE = 'packages/domain/src/knowledge.ts'

MUTANTS = json.load(open(os.path.join(os.path.dirname(__file__), 'mutants-phase6.json')))

def run(files):
    env = dict(os.environ, TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/pitch2plan_mut')
    try:
        p = subprocess.run(['npx', 'vitest', 'run', *files], cwd=COPY, env=env, capture_output=True, text=True, timeout=240)
        return p.returncode, (p.stdout + p.stderr)[-600:]
    except subprocess.TimeoutExpired:
        return -9, 'TIMEOUT'

results = []
if os.path.exists(OUT): results = json.load(open(OUT))
done = {r['id'] for r in results}
for m in MUTANTS:
    if ONLY and ONLY not in m['id']: continue
    if m['id'] in done: continue
    path = os.path.join(COPY, m['file'])
    original = open(path).read()
    if m['old'] not in original:
        results.append({'id': m['id'], 'status': 'INVALID', 'note': 'pattern not found'}); json.dump(results, open(OUT, 'w'), indent=1); continue
    t0 = time.time()
    try:
        open(path, 'w').write(original.replace(m['old'], m['new'], 1))
        code, tail = run(m['tests'])
    finally:
        open(path, 'w').write(original)
    results.append({'id': m['id'], 'what': m['what'], 'status': 'KILLED' if code != 0 else 'SURVIVED', 'seconds': round(time.time() - t0, 1), 'tail': tail if code == 0 else ''})
    json.dump(results, open(OUT, 'w'), indent=1)
    print(m['id'], results[-1]['status'], flush=True)
print('DONE', sum(r['status'] == 'KILLED' for r in results), '/', len(results), flush=True)
