import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ client: null as any }));
vi.mock('../../server/geminiClient.js', () => ({
  getGemini: () => harness.client,
  createGeminiClientWithKey: () => harness.client,
}));

import { GeminiProvider } from '../../server/ai/geminiProvider.js';

afterEach(() => { harness.client = null; vi.restoreAllMocks(); });

describe('Gemini caller cancellation', () => {
  it('forwards AbortSignal and keeps a cancelled SDK rejection distinct from timeout', async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let rejectRequest!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectRequest = reject; });
    let request: any;
    harness.client = { models: { generateContent: vi.fn((value: unknown) => { request = value; markStarted(); return pending; }) } };
    const running = new GeminiProvider().generate('hello', { model: 'gemini-test-model', signal: controller.signal });
    await started;
    expect(request.config.abortSignal).toBe(controller.signal);
    controller.abort();
    rejectRequest(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('does not dispatch if cancellation preceded the provider call', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    harness.client = { models: { generateContent: vi.fn(async () => { calls += 1; return { text: 'unexpected' }; }) } };
    await expect(new GeminiProvider().generate('hello', { model: 'gemini-test-model', signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls).toBe(0);
  });

  it('forwards cancellation through structured output and discards a late SDK result', async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let resolveRequest!: (value: unknown) => void;
    let request: any;
    harness.client = { models: { generateContent: vi.fn((value: unknown) => {
      request = value;
      markStarted();
      return new Promise(resolve => { resolveRequest = resolve; });
    }) } };
    const running = new GeminiProvider().generateStructured('return JSON', { type: 'object', properties: {} }, { model: 'gemini-test-model', signal: controller.signal });
    await started;
    expect(request.config.abortSignal).toBe(controller.signal);
    controller.abort();
    resolveRequest({ text: '{"late":true}' });
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
