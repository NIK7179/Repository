import type { ZodType } from 'zod';
import type { LLMGateway } from './gateway';
import { AIError, type CallMeta, type LLMRequest, type LLMResult } from './types';

/** Pulls the first balanced JSON object out of model text (handles prose and ```json fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in model output.');
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('Unterminated JSON object in model output.');
}

export interface StructuredOptions<T> {
  gateway: LLMGateway;
  request: Omit<LLMRequest, 'model' | 'signal'>;
  meta: CallMeta;
  schema: ZodType<T>;
  /** Semantic checks beyond the schema. Return a list of issues; empty means valid. */
  semantic?: (value: T) => string[];
  repairAttempts?: number;
}

/**
 * LLM -> raw text -> JSON extraction -> Zod validation -> semantic validation.
 * On failure, one repair round that shows the model exactly what was wrong.
 * If it still fails, throws AI_OUTPUT_INVALID. Nothing malformed is ever returned.
 */
export async function runStructured<T>(opts: StructuredOptions<T>): Promise<{ value: T; result: LLMResult; repaired: boolean }> {
  const { gateway, schema, meta } = opts;
  const maxRepairs = opts.repairAttempts ?? 1;
  let request = opts.request;
  let lastIssues: string[] = [];

  for (let round = 0; round <= maxRepairs; round++) {
    const result = await gateway.generate(request, meta);
    let issues: string[];
    try {
      const parsed = schema.safeParse(extractJson(result.text));
      if (parsed.success) {
        issues = opts.semantic?.(parsed.data) ?? [];
        if (issues.length === 0) return { value: parsed.data, result, repaired: round > 0 };
      } else {
        issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      }
    } catch (e) {
      issues = [e instanceof Error ? e.message : 'Output was not valid JSON.'];
    }
    lastIssues = issues;
    request = {
      ...opts.request,
      messages: [
        ...opts.request.messages,
        { role: 'assistant', content: result.text },
        { role: 'user', content: `Your previous response was rejected for these reasons:\n- ${issues.slice(0, 10).join('\n- ')}\nReturn the corrected JSON object only, with no other text.` },
      ],
    };
  }
  throw new AIError('AI_OUTPUT_INVALID', 'The AI response did not pass validation, so it was discarded.', false, { issues: lastIssues });
}
