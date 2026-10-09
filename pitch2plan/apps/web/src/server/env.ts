import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  AUTH_PROVIDER: z.enum(['dev']).default('dev'),
  /** The dev auth provider is refused in production unless explicitly allowed. */
  ALLOW_DEV_AUTH: z.enum(['true', 'false']).default('false'),
  AUTH_SECRET: z.string().min(16, 'AUTH_SECRET must be at least 16 characters').optional(),
  AI_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** Standard discovery rounds before the brief is offered automatically (the user can always ask for more). */
  DISCOVERY_MAX_ROUNDS: z.coerce.number().int().min(1).max(10).default(3),
  DISCOVERY_MAX_QUESTIONS: z.coerce.number().int().min(1).max(10).default(6),
  /** inline = the web process also runs the job worker (default outside production); external = run `npm run worker` separately. */
  WORKER_MODE: z.enum(['inline', 'external']).optional(),
  ARCH_MAX_REPAIRS: z.coerce.number().int().min(0).max(5).default(2),
  ARCH_STALE_RUN_MS: z.coerce.number().int().positive().default(600_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Development only. Prompts may contain sensitive user data. */
  DEBUG_LOG_PROMPTS: z.enum(['true', 'false']).default('false'),
  /** Multiplies every rate limit. Test servers only: refused above 1 unless the throwaway dev auth is explicitly enabled. */
  RATE_LIMIT_SCALE: z.coerce.number().int().min(1).max(1000).default(1),
}).superRefine((e, ctx) => {
  if (e.RATE_LIMIT_SCALE > 1 && e.ALLOW_DEV_AUTH !== 'true') ctx.addIssue({ code: 'custom', path: ['RATE_LIMIT_SCALE'], message: 'RATE_LIMIT_SCALE above 1 is only allowed together with ALLOW_DEV_AUTH=true (test and demo servers).' });
  const prod = e.NODE_ENV === 'production';
  if (e.AI_PROVIDER === 'anthropic' && !e.ANTHROPIC_API_KEY) ctx.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: 'Required when AI_PROVIDER=anthropic' });
  if (prod && !e.AUTH_SECRET) ctx.addIssue({ code: 'custom', path: ['AUTH_SECRET'], message: 'Required in production' });
  if (prod && e.AUTH_PROVIDER === 'dev' && e.ALLOW_DEV_AUTH !== 'true') ctx.addIssue({ code: 'custom', path: ['AUTH_PROVIDER'], message: 'The dev auth provider is disabled in production. Integrate a real provider (see docs/ARCHITECTURE.md) or set ALLOW_DEV_AUTH=true for a throwaway demo.' });
});

export type Env = z.infer<typeof schema> & { AUTH_SECRET: string };
let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  cached = { ...parsed.data, AUTH_SECRET: parsed.data.AUTH_SECRET ?? 'dev-only-secret-change-me-please-0000' };
  return cached;
}
