import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

/**
 * v0.8.0 FLAG fix — text FREE -> PAID / pricing-unverified UX.
 *
 * Route-level proof that the bounded pricing-block reason survives all the way
 * to the text HTTP response (instead of being lost in candidate resolution and
 * collapsed into a generic deterministic result), that ZERO provider calls are
 * made, and that ordinary selections are unaffected.
 */

const SENTINEL = 'sk-or-v1-TEXT_PRICING_UX_SENTINEL';
const TEXT_HEADER = 'x-kitchen-ai-text-selection';
const ENV_KEYS = [
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_ENDPOINT_TOKEN',
  'KITCHEN_CODEX_TEXT_PROVIDER',
  'KITCHEN_CODEX_TEXT_MODEL',
  'KITCHEN_CODEX_IMAGE_PROVIDER',
  'KITCHEN_CODEX_IMAGE_MODEL',
] as const;

async function startApp(env: Record<string, string>) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const { createApp } = await import('../../server/app.js');
  const app = createApp({ isProduction: false });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function stubOpenRouter(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (typeof url === 'string' && url.startsWith('https://openrouter.ai/')) {
      calls.push({ url, method: (init?.method ?? 'GET') as string });
      return handler(url, init);
    }
    return original(input, init);
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** A direct catalog fetch seam (does NOT touch global fetch). */
function catalogFetch(payload: unknown) {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
}

function rawModel(id: string, pricing: Record<string, string>) {
  return {
    id,
    name: 'OpenAI: GPT-4o-mini',
    context_length: 128000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing,
    supported_parameters: ['temperature', 'max_tokens', 'response_format', 'structured_outputs'],
  };
}

async function primeCatalog(models: unknown[]) {
  const catalog = await import('../../server/ai/openRouterCatalog.js');
  catalog.resetOpenRouterCatalogForTests();
  await catalog.refreshOpenRouterCatalog({ force: true, fetchFn: catalogFetch({ data: models }) });
  return catalog;
}

function freeModel() {
  return rawModel('openai/gpt-4o-mini', { prompt: '0', completion: '0' });
}
function paidModel() {
  return rawModel('openai/gpt-4o-mini', { prompt: '0.00000015', completion: '0.0000006' });
}

function selectionHeader(costClass?: string): Record<string, string> {
  const payload: Record<string, unknown> = {
    mode: 'user_selected',
    providerId: 'openrouter',
    modelId: 'openai/gpt-4o-mini',
    credentialSource: 'server_environment',
  };
  if (costClass) payload.selectedCostClass = costClass;
  return { 'Content-Type': 'application/json', [TEXT_HEADER]: JSON.stringify(payload) };
}

function intentContent(): string {
  return JSON.stringify({
    version: 1,
    intent: 'find_recipes',
    source: 'vault',
    constraints: { includeIngredients: ['chicken'] },
    preferences: {},
    requiresClarification: false,
  });
}

function openRouterTextResponse(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: intentContent() } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function post(baseUrl: string, path: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let json: any = undefined;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('v0.8.0 FLAG fix — text pricing block reaches the HTTP response', () => {
  it('A–G. FREE-acknowledged model that became PAID => 409 MODEL_PRICING_CHANGED, ZERO provider calls', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => {
      throw new Error('provider must not be called');
    });
    try {
      await primeCatalog([paidModel()]); // current trusted catalog says PAID
      const res = await post(baseUrl, '/api/kitchen/interpret', selectionHeader('free'), {
        question: 'what can I make with chicken',
      });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('MODEL_PRICING_CHANGED');
      expect(String(res.json.error).toLowerCase()).toContain('no longer free');
      expect(String(res.json.error).toLowerCase()).toContain('re-select');
      // D: ZERO provider network calls.
      expect(stub.calls).toHaveLength(0);
      // G: not a generic 200/no-results response.
      expect(res.status).not.toBe(200);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('H–J. FREE selection + stale catalog + refresh failure => 409 MODEL_PRICING_UNVERIFIED, ZERO calls', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => {
      throw new Error('provider must not be called');
    });
    try {
      const catalog = await primeCatalog([freeModel()]);
      // A subsequent refresh failure retains last-known data but marks it stale.
      await catalog.refreshOpenRouterCatalog({
        force: true,
        fetchFn: async () => {
          throw new Error('network down');
        },
      });
      const res = await post(baseUrl, '/api/kitchen/interpret', selectionHeader('free'), {
        question: 'what can I make with chicken',
      });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('MODEL_PRICING_UNVERIFIED');
      expect(String(res.json.error).toLowerCase()).toContain('could not be verified');
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('surfaces the block on rank / generate / grab / nutrition / recover routes too', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => {
      throw new Error('provider must not be called');
    });
    try {
      await primeCatalog([paidModel()]);
      const routes: { path: string; body: unknown }[] = [
        { path: '/api/kitchen/rank', body: { question: 'q', intent: {}, candidates: [] } },
        { path: '/api/recipes/generate', body: { prompt: 'q' } },
        { path: '/api/grab-recipe', body: { url: 'https://example.com/recipe' } },
        { path: '/api/estimate-nutrition', body: { ingredients: [] } },
        { path: '/api/recover-metadata', body: { title: 'x' } },
      ];
      for (const route of routes) {
        const res = await post(baseUrl, route.path, selectionHeader('free'), route.body);
        expect({ path: route.path, status: res.status, code: res.json?.code }).toEqual({
          path: route.path,
          status: 409,
          code: 'MODEL_PRICING_CHANGED',
        });
      }
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('v0.8.0 FLAG fix — regressions', () => {
  it('K/M. no selection / server-default behavior is unchanged (never blocked)', async () => {
    const { server, baseUrl } = await startApp({});
    try {
      const res = await post(
        baseUrl,
        '/api/kitchen/interpret',
        { 'Content-Type': 'application/json' },
        { question: 'what can I make with chicken' }
      );
      expect(res.status).toBe(200);
      expect(res.json.code).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('L. an acknowledged PAID selection is NOT blocked and reaches the provider layer', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => openRouterTextResponse());
    try {
      await primeCatalog([paidModel()]);
      const res = await post(baseUrl, '/api/kitchen/interpret', selectionHeader('paid'), {
        question: 'what can I make with chicken',
      });
      expect(res.status).not.toBe(409);
      expect(res.json.code).not.toBe('MODEL_PRICING_CHANGED');
      expect(stub.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('N. an arbitrary model id keeps its normal fail-closed behavior (not a pricing block)', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => {
      throw new Error('provider must not be called');
    });
    try {
      await primeCatalog([paidModel()]);
      const headers = {
        'Content-Type': 'application/json',
        [TEXT_HEADER]: JSON.stringify({
          mode: 'user_selected',
          providerId: 'openrouter',
          modelId: 'totally/arbitrary-model',
          selectedCostClass: 'free',
        }),
      };
      const res = await post(baseUrl, '/api/kitchen/interpret', headers, {
        question: 'what can I make with chicken',
      });
      expect(res.status).not.toBe(409);
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('O. OpenRouter / openrouter-image credential identities remain distinct', async () => {
    const { server } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    try {
      const textRegistry = await import('../../server/ai/providerRegistry.js');
      const imageRegistry = await import('../../server/ai/imageProviderRegistry.js');
      expect(textRegistry.getRegisteredProviders().some((r) => r.provider.id === 'openrouter')).toBe(true);
      expect(imageRegistry.findRegisteredImageProvider('openrouter-image')).toBeTruthy();
      expect(imageRegistry.findRegisteredImageProvider('openrouter')).toBeUndefined();
      expect(textRegistry.findRegisteredProvider(textRegistry.getRegisteredProviders(), 'openrouter-image')).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('resolveRoleCandidateContext preserves the block; resolveRoleCandidates stays candidate-only', async () => {
    const { server } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    try {
      const catalog = await primeCatalog([paidModel()]);
      const roleCandidates = await import('../../server/ai/roleCandidates.js');
      const parse = await import('../../server/ai/parseSelectionMetadata.js');
      const intent = parse.parseTextSelectionHeader({
        [TEXT_HEADER]: JSON.stringify({
          mode: 'user_selected',
          providerId: 'openrouter',
          modelId: 'openai/gpt-4o-mini',
          selectedCostClass: 'free',
        }),
      });
      const ctx = roleCandidates.resolveRoleCandidateContext('kitchenInterpret', undefined, intent);
      expect(ctx.candidates).toEqual([]);
      expect(ctx.pricingBlocked).toBe('MODEL_PRICING_CHANGED');
      expect(roleCandidates.resolveRoleCandidates('kitchenInterpret', undefined, intent)).toEqual([]);
      void catalog;
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
