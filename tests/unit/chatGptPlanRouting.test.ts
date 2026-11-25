/**
 * SHISO-C1.5 — native ChatGPT plan selection/routing.
 *
 * Deterministic local bridge and provider mocks only. No live ChatGPT account or
 * provider request is used here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

import {
  CHATGPT_PLAN_BRIDGE_TOKEN_ENV,
  CHATGPT_PLAN_BRIDGE_URL_ENV,
  chatGptPlanModelIds,
  isChatGptPlanAvailable,
  isChatGptPlanBridgeConfigured,
  refreshChatGptPlanCatalog,
  resetChatGptPlanCatalogForTests,
} from '../../server/ai/chatGptPlanBridge';
import { ChatGptPlanProvider } from '../../server/ai/chatGptPlanProvider';
import { getRegisteredProviders } from '../../server/ai/providerRegistry';
import { resolveRoleCandidates } from '../../server/ai/roleCandidates';
import { parseTextSelectionHeader } from '../../server/ai/parseSelectionMetadata';
import { validateUserTextSelection } from '../../server/ai/effectiveSelection';
import { buildProviderCatalog } from '../../server/ai/providerCatalog';
import { getAiProviderStatus } from '../../server/ai/providerStatus';
import { runShisoTurn } from '../../server/shiso/conversationTurn';
import { readShisoTurnRequest } from '../../server/shiso/turnRequest';
import type { ProviderOperationError } from '../../server/ai/providerErrors';

const TOKEN = 'a'.repeat(64);
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const MODEL = 'gpt-plan-test';

let server: http.Server;
let baseUrl = '';
let connected = true;
let planEnabled = true;
let models: Array<{ id: string; name: string }> = [{ id: MODEL, name: 'ChatGPT Plan Test' }];
let lastInfer: Record<string, unknown> | null = null;

function json(res: http.ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      json(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'No.' } });
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      json(res, 200, {
        ok: true,
        connected,
        planEnabled,
        activeAccountKey: connected ? ACCOUNT : null,
        models: connected && planEnabled ? models : [],
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/infer') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        lastInfer = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        const body = lastInfer as { model?: string; input?: Array<{ content?: string }> };
        if (body.model !== MODEL) {
          json(res, 200, {
            ok: false,
            error: { code: 'UNSUPPORTED_MODEL', message: 'That model is not available.' },
          });
          return;
        }
        const prompt = body.input?.[0]?.content || '';
        const text = prompt.includes('Return exactly one JSON object')
          ? JSON.stringify({ kind: 'reply', text: 'Native Shiso reply' })
          : `reply:${prompt}`;
        json(res, 200, {
          ok: true,
          value: {
            requestId: 'test-request',
            model: MODEL,
            text,
            completed: true,
          },
        });
      });
      return;
    }
    json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'No.' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test bridge port.');
  baseUrl = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('TKC_DESKTOP_RUNTIME', '1');
  vi.stubEnv(CHATGPT_PLAN_BRIDGE_URL_ENV, baseUrl);
  vi.stubEnv(CHATGPT_PLAN_BRIDGE_TOKEN_ENV, TOKEN);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  resetChatGptPlanCatalogForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  connected = true;
  planEnabled = true;
  models = [{ id: MODEL, name: 'ChatGPT Plan Test' }];
  lastInfer = null;
  vi.stubEnv('TKC_DESKTOP_RUNTIME', '1');
  vi.stubEnv(CHATGPT_PLAN_BRIDGE_URL_ENV, baseUrl);
  vi.stubEnv(CHATGPT_PLAN_BRIDGE_TOKEN_ENV, TOKEN);
  vi.stubEnv('KITCHEN_CODEX_TEXT_PROVIDER', '');
  vi.stubEnv('KITCHEN_CODEX_TEXT_MODEL', '');
  resetChatGptPlanCatalogForTests();
  await refreshChatGptPlanCatalog();
});

function selection(overrides: Record<string, unknown> = {}) {
  return parseTextSelectionHeader({
    'x-kitchen-ai-text-selection': JSON.stringify({
      mode: 'user_selected',
      providerId: 'chatgpt-plan',
      modelId: MODEL,
      credentialSource: 'native_plan',
      accountKey: ACCOUNT,
      ...overrides,
    }),
  });
}

describe('ChatGPT plan provider', () => {
  it('is unavailable to a web deployment without the desktop runtime flag', () => {
    vi.stubEnv('TKC_DESKTOP_RUNTIME', '');
    expect(isChatGptPlanBridgeConfigured()).toBe(false);
    vi.stubEnv('TKC_DESKTOP_RUNTIME', '1');
  });

  it('publishes only the live account models and executes a plain-text request', async () => {
    expect(chatGptPlanModelIds()).toEqual([MODEL]);
    expect(isChatGptPlanAvailable(ACCOUNT)).toBe(true);

    const provider = new ChatGptPlanProvider({ accountKey: ACCOUNT });
    expect(provider.id).toBe('chatgpt-plan');
    expect(provider.isAvailable()).toBe(true);
    expect(provider.capabilities).toMatchObject({
      reasoning: true,
      structuredOutput: false,
      recipeGeneration: false,
      webSearch: false,
    });

    const text = await provider.generate('hello shiso', { model: MODEL });
    expect(text).toBe('reply:hello shiso');
    expect(lastInfer).toMatchObject({
      accountKey: ACCOUNT,
      model: MODEL,
      input: [{ role: 'user', content: 'hello shiso' }],
    });
  });

  it('does not claim structured output without a verified contract', async () => {
    const provider = new ChatGptPlanProvider({ accountKey: ACCOUNT });
    await expect(
      provider.generateStructured('x', { type: 'object', properties: {} }, { model: MODEL })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('fails closed when ChatGPT is disconnected', async () => {
    connected = false;
    planEnabled = false;
    await refreshChatGptPlanCatalog();
    expect(chatGptPlanModelIds()).toEqual([]);
    expect(isChatGptPlanAvailable(ACCOUNT)).toBe(false);
    const provider = new ChatGptPlanProvider({ accountKey: ACCOUNT });
    await expect(provider.generate('hello', { model: MODEL })).rejects.toMatchObject({
      code: 'AUTH',
    } satisfies Partial<ProviderOperationError>);
  });
});

describe('ChatGPT plan selection', () => {
  it('parses a non-secret native account/model selection', () => {
    const intent = selection();
    expect(intent).toMatchObject({
      kind: 'EXPLICIT_SELECTED',
      providerId: 'chatgpt-plan',
      modelId: MODEL,
      credentialSource: 'native_plan',
      accountKey: ACCOUNT,
    });
  });

  it('routes Shiso conversation to the native plan with one terminal attempt', () => {
    const regs = getRegisteredProviders();
    const candidates = resolveRoleCandidates('shisoConversation', regs, selection());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].provider.id).toBe('chatgpt-plan');
    expect(candidates[0].model).toBe(MODEL);
    expect(candidates[0].credentialSource).toBe('native_plan');
    expect(candidates[0].singleAttempt).toBe(true);
    expect(candidates[0].terminalOnFailure).toBe(true);
  });

  it('runs a real Shiso turn through the native plan text adapter', async () => {
    const body = readShisoTurnRequest({
      turn_version: 'shiso_turn_request_v1',
      user_message: 'what should I cook tonight?',
      history: [],
      context: { recipe: null, nutrition: { available: false } },
      model_invocations_used: 0,
      tool_calls_used: 0,
    });
    if (!body) throw new Error('valid Shiso turn did not parse');
    const response = await runShisoTurn(body, {
      registry: getRegisteredProviders(),
      userSelection: selection(),
    });
    expect(response).toMatchObject({ ok: true, kind: 'reply', text: 'Native Shiso reply' });
    expect(lastInfer).toMatchObject({ accountKey: ACCOUNT, model: MODEL });
    expect(String((lastInfer?.input as Array<{ content?: string }>)?.[0]?.content)).toContain(
      'Shiso'
    );
  });

  it('does not route structured nutrition work to ChatGPT and never falls back to Gemini', () => {
    const regs = getRegisteredProviders();
    const candidates = resolveRoleCandidates('nutrition', regs, selection());
    expect(candidates).toEqual([]);
  });

  it('rejects an account key that does not match the native account', () => {
    const regs = getRegisteredProviders();
    const candidates = resolveRoleCandidates(
      'shisoConversation',
      regs,
      selection({ accountKey: 'acct_ffffffffffffffffffffffffffffffff' })
    );
    expect(candidates).toEqual([]);
  });

  it('rejects a malformed account key as an explicit invalid intent', () => {
    const intent = selection({ accountKey: 'not-an-account' });
    expect(intent.kind).toBe('INVALID');
    expect(
      resolveRoleCandidates('shisoConversation', getRegisteredProviders(), intent)
    ).toEqual([]);
  });

  it('keeps a server-managed operator pin authoritative', () => {
    vi.stubEnv('KITCHEN_CODEX_TEXT_PROVIDER', 'gemini');
    vi.stubEnv('KITCHEN_CODEX_TEXT_MODEL', 'gemini-3.7-flash');
    const candidates = resolveRoleCandidates(
      'shisoConversation',
      getRegisteredProviders(),
      selection()
    );
    expect(candidates[0]?.provider.id).toBe('gemini');
    expect(candidates[0]?.credentialSource).toBe('server_environment');
  });

  it('exposes the native plan as a non-secret, non-generic catalog row', () => {
    const row = buildProviderCatalog().textProviders.find((p) => p.providerId === 'chatgpt-plan');
    expect(row).toMatchObject({
      providerId: 'chatgpt-plan',
      name: 'ChatGPT plan',
      configured: true,
      enabled: true,
      available: true,
      storageScope: 'session_only',
      connectionTest: 'unavailable',
      selectable: false,
      sessionKeySupported: false,
    });
    expect(row?.models).toEqual([
      {
        id: MODEL,
        default: true,
        capabilities: {
          reasoning: true,
          structuredOutput: false,
          recipeGeneration: false,
          webSearch: false,
        },
        displayName: 'ChatGPT Plan Test',
      },
    ]);
    const status = getAiProviderStatus().find((p) => p.providerId === 'chatgpt-plan');
    expect(status).toMatchObject({
      providerId: 'chatgpt-plan',
      configured: true,
      available: true,
      storageScope: 'session_only',
      supportsSecretWrites: false,
    });
    expect(JSON.stringify(row)).not.toMatch(/accessToken|refreshToken|idToken|apiKey|Bearer/i);
  });

  it('validates only the live native catalog', () => {
    const regs = getRegisteredProviders();
    expect(
      validateUserTextSelection(
        { mode: 'user_selected', providerId: 'chatgpt-plan', modelId: MODEL, credentialSource: 'native_plan', accountKey: ACCOUNT },
        regs,
        'native_plan'
      )
    ).toEqual({ providerId: 'chatgpt-plan', modelId: MODEL });
    expect(
      validateUserTextSelection(
        { mode: 'user_selected', providerId: 'chatgpt-plan', modelId: 'not-in-catalog', credentialSource: 'native_plan', accountKey: ACCOUNT },
        regs,
        'native_plan'
      )
    ).toBeNull();
  });
});
