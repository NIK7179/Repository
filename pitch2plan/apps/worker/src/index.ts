/**
 * Background worker entry point.
 *
 * Phase 1 has no job that genuinely needs a queue (interpretation runs inside the request, which is
 * well within its time budget), so nothing is registered and we deliberately do NOT add pg-boss yet.
 * Phase 3 (architecture generation) is the first real consumer: add pg-boss on the existing Postgres,
 * register the `architecture.generate` handler here, and keep it calling the same domain services.
 */
console.log(JSON.stringify({ service: 'pitch2plan-worker', msg: 'no jobs are registered in Phase 1; exiting' }));
