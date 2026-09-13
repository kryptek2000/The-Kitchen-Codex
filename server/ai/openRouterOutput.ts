import type { AiJsonSchema } from './types.js';
import { APPLICATION_VALIDATED_JSON_PROFILE, type OpenRouterProfile } from '../../src/core/ai/openRouterProfile.js';

/** Shared mechanics for explicit probes and runtime. Exclude does not disable reasoning. */
export const OPENROUTER_PROBE_TOKENS = 512;
export const OPENROUTER_RUNTIME_TOKENS = 4096;
export function structuredRequestFields(profile: OpenRouterProfile, schema: Record<string, unknown>, name: string, maxTokens: number) {
  return {
    max_tokens: maxTokens,
    reasoning: { exclude: true },
    response_format: profile === APPLICATION_VALIDATED_JSON_PROFILE
      ? { type: 'json_object' }
      : { type: 'json_schema', json_schema: { name, strict: true, schema } },
    provider: { require_parameters: true },
  };
}

export type OutputFailure = 'output_truncated' | 'refusal' | 'tool_call_only' | 'content_parts_unsupported' | 'empty_response' | 'schema_mismatch';
export type CompletionContent = { ok: true; content: string } | { ok: false; reason: OutputFailure };
/** Chat Completions final content only. Never read reasoning/tool arguments as answers. */
export function completionContent(parsed: unknown): CompletionContent {
  const body = parsed as any;
  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
  const message = choice?.message;
  if (choice?.finish_reason === 'length') return { ok: false, reason: 'output_truncated' };
  if (choice?.finish_reason === 'content_filter' || message?.refusal) return { ok: false, reason: 'refusal' };
  if (choice?.finish_reason === 'tool_calls' || message?.tool_calls?.length) return { ok: false, reason: 'tool_call_only' };
  if (body?.error || choice?.error || (choice?.finish_reason != null && choice.finish_reason !== 'stop')) {
    return { ok: false, reason: 'schema_mismatch' };
  }
  // The documented non-streaming Chat Completions response uses string|null.
  // Responses API content arrays are a different contract; do not guess.
  if (Array.isArray(message?.content)) return { ok: false, reason: 'content_parts_unsupported' };
  if (typeof message?.content !== 'string' || !message.content.trim()) return { ok: false, reason: 'empty_response' };
  return { ok: true, content: message.content.trim() };
}

/** Entire operation schema validated before existing semantic sanitizers.
 * Optional null matches the existing strict-schema converter's nullable fields.
 * No coercion, fence stripping, or extra properties.
 */
export function validatesAiSchema(value: unknown, schema: AiJsonSchema, depth = 0): boolean {
  if (depth > 64) return false;
  switch (schema.type) {
    case 'string': return typeof value === 'string' && (!schema.enum || schema.enum.includes(value));
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'array': return Array.isArray(value) && value.every(v => validatesAiSchema(v, schema.items, depth + 1));
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const row = value as Record<string, unknown>;
      const required = new Set(schema.required ?? []);
      if ([...required].some(k => !Object.hasOwn(row, k))) return false;
      return Object.keys(row).every(k => Object.hasOwn(schema.properties, k) &&
        ((row[k] === null && !required.has(k)) || validatesAiSchema(row[k], schema.properties[k], depth + 1)));
    }
    default: return false;
  }
}

export interface StreamResponse {
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<void>; releaseLock?(): void } } | null;
}
/** Actual fetch bodies bounded before JSON allocation. Errors never retain content. */
export async function readRuntimeCompletion(res: StreamResponse, maxBytes = 256 * 1024): Promise<unknown> {
  if (!res.body?.getReader) throw new Error('Unreadable OpenRouter response.');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (value.byteLength > maxBytes - total) {
        await reader.cancel?.();
        throw new Error('OpenRouter response exceeds limit.');
      }
      chunks.push(value); total += value.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { reader.releaseLock?.(); }
}
