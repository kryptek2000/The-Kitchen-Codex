import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiProvider } from '../../src/core/ai/types';
import type { RegisteredProvider } from '../../server/ai/providerRegistry';

const harness = vi.hoisted(() => ({
  registry: [] as RegisteredProvider[],
  candidates: [] as Array<{ provider: AiProvider; model: string; credentialSource?: 'server_environment' | 'session_only' }>,
  operation: '' as string,
  selection: undefined as unknown,
  credentialOk: true,
}));

vi.mock('../../server/ai/effectiveSelection.js', () => ({
  resolveTextCandidateContext: (operation: string, _registry: unknown, selection: unknown) => {
    harness.operation = operation;
    harness.selection = selection;
    return {
      candidates: harness.candidates,
      source: 'user_selected',
      credentialSource: (selection as { credentialSource?: string } | undefined)?.credentialSource ?? 'server_environment',
    };
  },
  coerceSelectionInput: (selection: unknown) => ({
    invalid: false,
    explicit: true,
    metadata: selection as { providerId?: string; credentialSource?: string } | undefined,
  }),
}));

vi.mock('../../server/ai/providerRegistry.js', () => ({
  getRegisteredProviders: () => harness.registry,
  effectiveCapabilities: (registered: RegisteredProvider) => registered.defaultCapabilities,
  selectCandidates: (_registry: unknown, candidates: unknown[]) => candidates,
  runWithAiFallback: async (options: { candidates: Array<{ provider: AiProvider; model: string }>; run: (candidate: { provider: AiProvider; model: string }) => Promise<unknown> }) => ({
    result: await options.run(options.candidates[0]),
  }),
}));

vi.mock('../../server/ai/credentialResolver.js', () => ({
  resolveCredential: () => harness.credentialOk ? { ok: true, lease: { secret: 'redacted-test-secret' } } : { ok: false, code: 'SESSION_CREDENTIAL_MISSING' },
}));

import { runShisoTurn } from '../../server/shiso/conversationTurn';
import { readShisoTurnRequest } from '../../server/shiso/turnRequest';

function makeProvider(id: string, structuredOutput: boolean, result: unknown) {
  const calls: Array<{ kind: string; model?: string; prompt?: string }> = [];
  const provider: AiProvider = {
    id,
    name: id,
    capabilities: { reasoning: false, structuredOutput, recipeGeneration: false, webSearch: false },
    isAvailable: () => true,
    testConnection: async () => true,
    generate: async (prompt, options) => {
      calls.push({ kind: 'text', model: options?.model, prompt });
      if (result instanceof Error) throw result;
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
    generateStructured: async <T = unknown>(_prompt: string, _schema: import('../../src/core/ai/types').AiJsonSchema, options?: import('../../src/core/ai/types').AiStructuredOptions) => {
      calls.push({ kind: 'structured', model: options?.model });
      if (result instanceof Error) throw result;
      return result as T;
    },
  };
  return { provider, calls };
}

function turn() {
  const body = readShisoTurnRequest({
    turn_version: 'shiso_turn_request_v1',
    user_message: 'Hi Shiso',
    history: [],
    context: { recipe: null, nutrition: { available: false } },
    model_invocations_used: 0,
    tool_calls_used: 0,
  });
  if (!body) throw new Error('valid Shiso test turn did not parse');
  return body;
}

describe('SHISO universal provider dispatch', () => {
  beforeEach(() => {
    harness.registry = [];
    harness.candidates = [];
    harness.operation = '';
    harness.selection = undefined;
    harness.credentialOk = true;
  });

  it.each([
    ['gemini', 'gemini-3.1-flash-lite', 'server_environment'],
    ['gemini', 'gemini-3.1-flash-lite', 'session_only'],
    ['openrouter', 'LiquidAI/LFM2.5-2.6B:free', 'session_only'],
  ] as const)('dispatches the current %s / %s selection with %s credentials', async (providerId, model, credentialSource) => {
    const result = { kind: 'reply', text: 'Hello from Shiso' };
    const { provider, calls } = makeProvider(providerId, false, result);
    const registration: RegisteredProvider = {
      provider,
      defaultCapabilities: { ...provider.capabilities },
      enabled: credentialSource === 'session_only' ? false : true,
    };
    const candidate = { provider, model, credentialSource };
    harness.registry = [registration];
    harness.candidates = [candidate];
    const selection = { mode: 'user_selected', providerId, modelId: model, credentialSource };
    const response = await runShisoTurn(turn(), { registry: harness.registry, userSelection: selection });
    expect(response).toMatchObject({ ok: true, kind: 'reply', text: 'Hello from Shiso' });
    expect(harness.operation).toBe('shisoConversation');
    expect(harness.selection).toBe(selection);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'text', model });
    expect(calls[0].prompt).toContain('Return exactly one JSON object');
    expect(calls[0].prompt).toContain('a missing USDA match or portion does not');
    expect(calls[0].prompt).toContain('Estimated weights are allowed through run_nutrition_analysis');
    expect(calls[0].prompt).not.toContain('Only the user can enter a weight');
  });

  it('uses native structured output when the selected model supports it', async () => {
    const { provider, calls } = makeProvider('gemini', true, { kind: 'reply', text: 'Structured reply' });
    harness.registry = [{ provider, defaultCapabilities: { ...provider.capabilities }, enabled: true }];
    harness.candidates = [{ provider, model: 'gemini-3.1-flash-lite', credentialSource: 'server_environment' }];
    const response = await runShisoTurn(turn(), { registry: harness.registry, userSelection: undefined });
    expect(response).toMatchObject({ ok: true, text: 'Structured reply' });
    expect(calls).toEqual([{ kind: 'structured', model: 'gemini-3.1-flash-lite' }]);
  });

  it('rejects malformed JSON before it can become a tool request', async () => {
    const { provider, calls } = makeProvider('openrouter', false, 'not json');
    harness.registry = [{ provider, defaultCapabilities: { ...provider.capabilities }, enabled: false }];
    harness.candidates = [{ provider, model: 'LiquidAI/LFM2.5-2.6B:free', credentialSource: 'session_only' }];
    const response = await runShisoTurn(turn(), { registry: harness.registry, userSelection: { credentialSource: 'session_only' } });
    expect(response).toMatchObject({ ok: false, code: 'provider_invalid_response', aiAttempted: true });
    expect(calls).toHaveLength(1);
  });

  it('reports an expired session credential as actionable without attempting inference', async () => {
    harness.credentialOk = false;
    harness.candidates = [];
    const response = await runShisoTurn(turn(), {
      registry: [],
      userSelection: { mode: 'user_selected', providerId: 'openrouter', credentialSource: 'session_only' },
    });
    expect(response).toMatchObject({ ok: false, code: 'credentials_missing', aiAttempted: false });
    expect(response.ok === false && response.message).toMatch(/missing or expired/i);
  });

  it.each([
    ['authentication', Object.assign(new Error('rejected'), { code: 'AUTH', status: 401 }), 'credentials_missing'],
    ['permission', Object.assign(new Error('permission denied'), { code: 'AUTH', status: 403 }), 'provider_error'],
    ['quota', Object.assign(new Error('limit reached'), { code: 'QUOTA', status: 429 }), 'quota_exhausted'],
    ['model compatibility', Object.assign(new Error('unknown model'), { code: 'PROVIDER_ERROR', status: 404 }), 'no_capability_available'],
    ['network', Object.assign(new TypeError('fetch failed'), { code: 'UNAVAILABLE' }), 'provider_network_error'],
  ] as const)('reports %s failures with an actionable category', async (_label, failure, expectedCode) => {
    const { provider } = makeProvider('openrouter', false, failure);
    harness.registry = [{ provider, defaultCapabilities: { ...provider.capabilities }, enabled: false }];
    harness.candidates = [{ provider, model: 'LiquidAI/LFM2.5-2.6B:free', credentialSource: 'session_only' }];
    const response = await runShisoTurn(turn(), { registry: harness.registry, userSelection: { credentialSource: 'session_only' } });
    expect(response).toMatchObject({ ok: false, code: expectedCode, aiAttempted: true });
  });
});
