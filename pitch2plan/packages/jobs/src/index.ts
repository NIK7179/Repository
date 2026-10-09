import { ARCHITECTURE_JOB, CHANGE_ANALYZE_JOB, CHANGE_APPLY_JOB, IMPLEMENTATION_JOB, type Application, type JobQueue } from '@pitch2plan/domain';
import PgBoss from 'pg-boss';

export interface JobLogger { info(f: Record<string, unknown>, m?: string): void; warn(f: Record<string, unknown>, m?: string): void; error(f: Record<string, unknown>, m?: string): void }
const quiet: JobLogger = { info() {}, warn() {}, error() {} };

/**
 * pg-boss adapter for the domain's JobQueue port. pg-boss runs on the existing PostgreSQL (schema "pgboss"); no new infrastructure.
 *
 * The queue uses policy "short" so a second job with the same singletonKey is refused (enqueue returns null). Under pg-boss's default
 * "standard" policy a duplicate singletonKey is NOT de-duplicated. Correctness never depends on this, though: the generation run is
 * claimed and finalized with compare-and-set in the database, so a duplicate or retried job is harmless.
 */
export class PgBossJobQueue implements JobQueue {
  private bossPromise?: Promise<PgBoss>;
  constructor(private readonly connectionString: string, private readonly opts: { schema?: string; logger?: JobLogger } = {}) {}

  private get logger() { return this.opts.logger ?? quiet; }

  getBoss(): Promise<PgBoss> {
    this.bossPromise ??= (async () => {
      const boss = new PgBoss({ connectionString: this.connectionString, schema: this.opts.schema ?? 'pgboss' });
      boss.on('error', (e) => this.logger.error({ err: String(e) }, 'pg-boss error'));
      await boss.start();
      for (const name of [ARCHITECTURE_JOB, IMPLEMENTATION_JOB, CHANGE_ANALYZE_JOB, CHANGE_APPLY_JOB]) await boss.createQueue(name, { name, policy: 'short', retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 20 * 60 });
      return boss;
    })().catch((e) => { this.bossPromise = undefined; throw e; });
    return this.bossPromise;
  }

  async enqueue(name: string, payload: { runId: string }, options: { singletonKey: string }): Promise<string | null> {
    return (await this.getBoss()).send(name, payload, { singletonKey: options.singletonKey });
  }

  /** Starts consuming architecture jobs and a sweeper that fails runs whose worker vanished, so projects never stay stuck in ARCHITECTURE_GENERATING. */
  async startWorker(app: Pick<Application, 'architecture' | 'implementation' | 'change'>, opts: { sweepEveryMs?: number } = {}): Promise<{ stop(): Promise<void> }> {
    const boss = await this.getBoss();
    await boss.work<{ runId: string }>(ARCHITECTURE_JOB, { pollingIntervalSeconds: 1, batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        const started = Date.now();
        const result = await app.architecture.runGeneration(job.data.runId);
        this.logger.info({ jobId: job.id, runId: job.data.runId, outcome: result.outcome, durationMs: Date.now() - started }, 'architecture job finished');
      }
    });
    await boss.work<{ runId: string }>(IMPLEMENTATION_JOB, { pollingIntervalSeconds: 1, batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        const started = Date.now();
        const result = await app.implementation.runGeneration(job.data.runId);
        this.logger.info({ jobId: job.id, runId: job.data.runId, outcome: result.outcome, durationMs: Date.now() - started }, 'implementation job finished');
      }
    });
    await boss.work<{ runId: string }>(CHANGE_ANALYZE_JOB, { pollingIntervalSeconds: 1, batchSize: 1 }, async (jobs) => {
      for (const job of jobs) { const started = Date.now(); const r = await app.change.runAnalysis(job.data.runId); this.logger.info({ jobId: job.id, proposalId: job.data.runId, outcome: r.outcome, durationMs: Date.now() - started }, 'change analysis job finished'); }
    });
    await boss.work<{ runId: string }>(CHANGE_APPLY_JOB, { pollingIntervalSeconds: 1, batchSize: 1 }, async (jobs) => {
      for (const job of jobs) { const started = Date.now(); const r = await app.change.runApplication(job.data.runId); this.logger.info({ jobId: job.id, runId: job.data.runId, outcome: r.outcome, durationMs: Date.now() - started }, 'change application job finished'); }
    });
    const sweep = () => Promise.all([app.architecture.recoverStale(), app.implementation.recoverStale(), app.change.recoverStale()]).then(([a, b, c]) => { if (a + b + c) this.logger.warn({ recovered: a + b + c }, 'recovered stale generation runs'); }).catch((e) => this.logger.error({ err: String(e) }, 'sweep failed'));
    void sweep();
    const timer = setInterval(sweep, opts.sweepEveryMs ?? 60_000);
    timer.unref?.();
    return { stop: async () => { clearInterval(timer); await this.stop(); } };
  }

  async stop(): Promise<void> {
    const p = this.bossPromise; this.bossPromise = undefined;
    if (p) await (await p).stop({ graceful: true, timeout: 5000 });
  }
}
