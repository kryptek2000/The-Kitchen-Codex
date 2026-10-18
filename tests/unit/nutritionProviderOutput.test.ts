import { beforeEach, describe, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({ response: {} as any, calls: 0 }));
vi.mock('../../server/geminiClient.js', () => ({
  getGemini: () => ({ models: { generateContent: async () => { harness.calls++; return harness.response; } } }),
  createGeminiClientWithKey: () => { throw new Error('No credential creation expected'); },
}));
import { GeminiProvider } from '../../server/ai/geminiProvider';
import { OpenRouterProvider } from '../../server/ai/openRouterProvider';
const schema = { type: 'object' as const, properties: { answer: { type: 'string' as const } }, required: ['answer'] };
beforeEach(() => { harness.calls = 0; });
describe('safe structured output failure stages', () => {
  it.each([
    [{ text: '{"answer":"partial"}', candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'output_truncated'],
    [{ text: '{unclosed' }, 'malformed_json'],
    [{ text: '' }, 'empty_response'],
  ])('classifies Gemini response without returning raw content', async (response, reason) => {
    harness.response = response;
    await expect(new GeminiProvider().generateStructured('test', schema, { model: 'test-selected-model' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE', responseFailure: reason });
    expect(harness.calls).toBe(1);
  });
  it.each([
    [{ finish_reason: 'length', message: { content: '{"answer":"partial"}' } }, 'output_truncated'],
    [{ finish_reason: 'stop', message: { content: '{bad' } }, 'malformed_json'],
    [{ finish_reason: 'stop', message: { content: '{"wrong":"value"}' } }, 'schema_mismatch'],
  ])('classifies OpenRouter response with one mocked inference attempt', async (choice, reason) => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [choice] })));
    const provider = new OpenRouterProvider({ credential: 'synthetic-test-credential', fetchFn });
    await expect(provider.generateStructured('test', schema, { model: 'openai/gpt-4o-mini' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE', responseFailure: reason });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
