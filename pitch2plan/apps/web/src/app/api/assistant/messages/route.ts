import { askArchitectRequestSchema, type AskArchitectRequest } from '@pitch2plan/schemas';
import type { AssistantEvent } from '@pitch2plan/domain';
import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 130;

const sse = (e: AssistantEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/**
 * Server-sent events: start -> delta* -> done | error.
 * Validation and authorization failures are thrown BEFORE the stream opens, so they arrive as ordinary JSON errors.
 * If the client disconnects, the model call is cancelled and nothing partial is stored.
 */
export const POST = api<AskArchitectRequest>(
  { action: 'assistant.ask', body: askArchitectRequestSchema, rateLimit: { limit: 30, windowMs: 60_000 } },
  async ({ rc, body, req }) => {
    const abort = new AbortController();
    req.signal.addEventListener('abort', () => abort.abort(), { once: true });
    const iterator = getContainer().app.assistant.ask(rc, body, abort.signal)[Symbol.asyncIterator]();
    const first = await iterator.next(); // authorization + scope checks run here
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          if (!first.done) controller.enqueue(encoder.encode(sse(first.value)));
          for (let r = first.done ? first : await iterator.next(); !r.done; r = await iterator.next()) controller.enqueue(encoder.encode(sse(r.value)));
        } catch { controller.enqueue(encoder.encode(sse({ type: 'error', code: 'INTERNAL_ERROR', message: 'The assistant could not answer. Your question is saved; try again.' }))); }
        finally { try { controller.close(); } catch { /* client already gone */ } }
      },
      cancel() { abort.abort(); },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } });
  },
);
