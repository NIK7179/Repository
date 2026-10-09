/** Wraps untrusted/user-derived data for the model. The closing sequence can never appear inside the payload. */
export function dataBlock(tag: string, payload: unknown): string {
  const body = JSON.stringify(payload).replace(/<\//g, '<\\/');
  return `<${tag}>\n${body}\n</${tag}>`;
}
export function parseDataBlock<T = unknown>(text: string, tag: string): T | null {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  return m ? (JSON.parse(m[1]!) as T) : null;
}
export interface PromptDef { id: string; version: number; key: string; purpose: string; system: string }
export const promptHeader = (id: string, version: number) => `PROMPT_ID: ${id}_V${version}`;
