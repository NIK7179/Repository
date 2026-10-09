import pino from 'pino';
import { getEnv } from './env';

let logger: pino.Logger | undefined;
export function getLogger(): pino.Logger {
  return (logger ??= pino({
    level: getEnv().LOG_LEVEL,
    base: { service: 'pitch2plan-web' },
    // Never log credentials, even by accident.
    redact: { paths: ['*.apiKey', '*.authorization', '*.cookie', 'headers.cookie', 'headers.authorization', 'ANTHROPIC_API_KEY'], censor: '[redacted]' },
  }));
}

/** Never throws, even if env validation itself is what failed. Used on error paths. */
export function safeLogger(): { info(o: Record<string, unknown>, m?: string): void; error(o: Record<string, unknown>, m?: string): void } {
  try { return getLogger(); } catch {
    return {
      info: (o, m) => console.log(JSON.stringify({ msg: m, ...o })),
      error: (o, m) => console.error(JSON.stringify({ msg: m, ...o })),
    };
  }
}
