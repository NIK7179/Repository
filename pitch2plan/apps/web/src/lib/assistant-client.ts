import type { AssistantMessageContent } from '@pitch2plan/schemas';
import { ApiError } from './api-client';

export interface AskInput { projectId: string; scope: 'PROJECT' | 'COMPONENT' | 'TASK'; scopeId?: string; stepId?: string; message: string; clientMessageId: string }
export interface StoredAssistantMessage { id: string; content: string; structured: AssistantMessageContent | null; createdAt: string }
export type StreamHandlers = { onStart?: (e: { conversationId: string; userMessageId: string }) => void; onDelta?: (text: string) => void; onDone?: (m: StoredAssistantMessage) => void; onError?: (e: { code: string; message: string }) => void };

/**
 * Reads the SSE stream from POST /api/assistant/messages. Pre-stream failures (auth, scope, validation, rate limit) come back as a normal
 * JSON error and are thrown as ApiError. Resolves when the stream ends. Aborting the signal cancels the request, and the server cancels the model call.
 */
export async function streamAsk(input: AskInput, handlers: StreamHandlers, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try { res = await fetch('/api/assistant/messages', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal }); }
  catch (e) { if ((e as { name?: string }).name === 'AbortError') return; throw new ApiError('NETWORK_ERROR', 'Could not reach the server. Check your connection and try again.'); }
  if (!res.ok || !res.body) {
    let err: { code?: string; message?: string; requestId?: string } | undefined;
    try { err = (await res.json()).error; } catch { /* not JSON */ }
    throw new ApiError(err?.code ?? 'INTERNAL_ERROR', err?.message ?? `Request failed (${res.status}).`, err?.requestId, res.status);
  }
  const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let finished = false;
  const dispatch = (block: string) => {
    const data = block.split('\n').find((l) => l.startsWith('data: '))?.slice(6); if (!data) return;
    const e = JSON.parse(data) as { type: string; [k: string]: unknown };
    if (e.type === 'start') handlers.onStart?.(e as never);
    else if (e.type === 'delta') handlers.onDelta?.(e.text as string);
    else if (e.type === 'done') { finished = true; handlers.onDone?.(e.message as StoredAssistantMessage); }
    else if (e.type === 'error') { finished = true; handlers.onError?.({ code: e.code as string, message: e.message as string }); }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i; while ((i = buffer.indexOf('\n\n')) >= 0) { dispatch(buffer.slice(0, i)); buffer = buffer.slice(i + 2); }
    }
  } catch (e) { if ((e as { name?: string }).name === 'AbortError') return; throw new ApiError('NETWORK_ERROR', 'The connection was interrupted.'); }
  // The stream ended without done/error: a dropped connection. The partial text was NOT stored by the server.
  if (!finished && !signal?.aborted) handlers.onError?.({ code: 'STREAM_INTERRUPTED', message: 'The connection was interrupted before the answer finished. Your question is saved; try again.' });
}
