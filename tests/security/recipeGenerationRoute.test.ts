import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

/**
 * v0.8.x — recipe-generation capability route + Create-for-Me integration.
 *
 * Proves the explicit `verify-recipe` route, the profile prerequisite, the
 * separate capability gate, dispatch-time re-authorization, single runtime call,
 * no fallback, and the specific bounded Create-for-Me message. OpenRouter mocked.
 */

const SENTINEL = 'sk-or-v1-RECIPE_ROUTE_SENTINEL';
const TEXT_HEADER = 'x-kitchen-ai-text-selection';
const APP_VALIDATED = 'application_validated_json_v1';
const ENV_KEYS = [
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_ENDPOINT_TOKEN',
  'KITCHEN_CODEX_TEXT_PROVIDER',
  'KITCHEN_CODEX_TEXT_MODEL',
  'KITCHEN_CODEX_IMAGE_PROVIDER',
  'KITCHEN_CODEX_IMAGE_MODEL',
  'HOST',
] as const;

const ID = 'dynamic/recipe:free';
const FREE = { prompt: '0', completion: '0' };
const VALID_RECIPE = JSON.stringify({
  title: 'Test Toast',
  ingredients: [{ name: 'bread' }, { name: 'butter' }],
  steps: [{ text: 'Toast the bread.' }, { text: 'Spread the butter.' }],
});

async function startApp(env: Record<string, string>) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const { createApp } = await import('../../server/app.js');
  const app = createApp({ isProduction: false });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return { server, app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

interface RecordedCall {
  url: string;
  method: string;
  body: any;
  signal?: AbortSignal | null;
}

function stubOpenRouter(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (typeof url === 'string' && url.startsWith('https://openrouter.ai/')) {
      let body: any = undefined;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url, method: (init?.method ?? 'GET') as string, body, signal: init?.signal });
      return handler(url, init);
    }
    return original(input, init);
  }) as unknown as typeof globalThis.fetch;
  const contentOf = (c: RecordedCall) => String(c.body?.messages?.[0]?.content ?? '');
  return {
    calls,
    profileProbes: () => calls.filter((c) => contentOf(c).startsWith('Return exactly this JSON object')),
    recipeProbes: () => calls.filter((c) => contentOf(c).includes('Invent one tiny recipe')),
    runtimeCalls: () =>
      calls.filter((c) => !contentOf(c).startsWith('Return exactly this JSON object') && !contentOf(c).includes('Invent one tiny recipe')),
    restore() {
      globalThis.fetch = original;
    },
  };
}

function rawModel(id: string, pricing: Record<string, string>) {
  return {
    id,
    name: id,
    context_length: 128000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing,
    supported_parameters: ['temperature', 'max_tokens', 'response_format', 'structured_outputs'],
  };
}

async function primeCatalog(models: unknown[]) {
  const catalog = await import('../../server/ai/openRouterCatalog.js');
  catalog.resetOpenRouterCatalogForTests();
  await catalog.refreshOpenRouterCatalog({
    force: true,
    fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: models }) }),
  });
  return catalog;
}

const okRecipe = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: VALID_RECIPE } }] }), { status: 200 });
const okProfile = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }), { status: 200 });

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
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

function verifyProfile(baseUrl: string, modelId: string, profile = APP_VALIDATED) {
  const encoded = modelId.split('/').map((s) => encodeURIComponent(s)).join('/');
  return post(baseUrl, `/api/providers/openrouter/models/${encoded}/verify`, {
    credentialSource: 'server_environment',
    profile,
  });
}

function verifyRecipe(baseUrl: string, modelId: string) {
  const encoded = modelId.split('/').map((s) => encodeURIComponent(s)).join('/');
  return post(baseUrl, `/api/providers/openrouter/models/${encoded}/verify-recipe`, {
    credentialSource: 'server_environment',
  });
}

function selectionHeader(modelId: string, costClass: string): Record<string, string> {
  return {
    [TEXT_HEADER]: JSON.stringify({
      mode: 'user_selected',
      providerId: 'openrouter',
      modelId,
      credentialSource: 'server_environment',
      selectedCostClass: costClass,
    }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('POST verify-recipe route', () => {
  it('requires a current structured-text profile first (zero provider calls)', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL, HOST: '127.0.0.1' });
    const stub = stubOpenRouter(async () => okRecipe());
    try {
      await primeCatalog([rawModel(ID, FREE)]);
      const res = await verifyRecipe(baseUrl, ID);
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('MODEL_PROFILE_NOT_VERIFIED');
      expect(res.json.probeClassification).toBe('PROBE_PROFILE_REQUIRED');
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('verifies recipe creation after the profile, using the real recipe probe (one call)', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL, HOST: '127.0.0.1' });
    const stub = stubOpenRouter(async (_url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const content = String(body?.messages?.[0]?.content ?? '');
      if (content.startsWith('Return exactly this JSON object')) return okProfile();
      return okRecipe();
    });
    try {
      await primeCatalog([rawModel(ID, FREE)]);
      expect((await verifyProfile(baseUrl, ID)).status).toBe(200);
      const res = await verifyRecipe(baseUrl, ID);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true, capability: 'recipe_generation_v1', profile: APP_VALIDATED });
      expect(stub.recipeProbes()).toHaveLength(1);
      expect(JSON.stringify(res.json)).not.toContain(SENTINEL);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('a failed recipe probe is bounded (422) and never cached', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL, HOST: '127.0.0.1' });
    const stub = stubOpenRouter(async (_url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const content = String(body?.messages?.[0]?.content ?? '');
      if (content.startsWith('Return exactly this JSON object')) return okProfile();
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }), { status: 200 });
    });
    try {
      await primeCatalog([rawModel(ID, FREE)]);
      await verifyProfile(baseUrl, ID);
      const res = await verifyRecipe(baseUrl, ID);
      expect(res.status).toBe(422);
      expect(res.json.code).toBe('MODEL_CAPABILITY_UNVERIFIED');
      expect(res.json.probeClassification).toBe('PROBE_RECIPE_INVALID');
      const store = await import('../../server/ai/capabilityVerificationStore.js');
      expect(store.getRecipeGenerationVerification('openrouter', ID)).toBeUndefined();
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('Create for Me — dynamic recipe authorization', () => {
  it('refuses provider dispatch when the response is already destroyed before handler entry', async () => {
    const { server, baseUrl, app } = await startApp({ OPENROUTER_API_KEY: SENTINEL, HOST: '127.0.0.1' });
    const routeStack = ((app as any)._router?.stack ?? (app as any).router?.stack)
      .find((layer: any) => layer.route?.path === '/api/recipes/generate').route.stack;
    const cancellationLayer = routeStack[0];
    const originalCancellationMiddleware = cancellationLayer.handle;
    cancellationLayer.handle = function (req: any, res: any, next: any) {
      return originalCancellationMiddleware.call(this, req, res, () => {
        res.destroy();
        next();
      });
    };
    const stub = stubOpenRouter(async () => okRecipe());
    try {
      const request = fetch(`${baseUrl}/api/recipes/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'a quick pasta' }),
      });
      await expect(request).rejects.toBeTruthy();
      expect(stub.runtimeCalls()).toHaveLength(0);
    } finally {
      cancellationLayer.handle = originalCancellationMiddleware;
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('profile-only dynamic model => specific bounded message, ZERO runtime calls', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL, HOST: '127.0.0.1' });
    const stub = stubOpenRouter(async () => okProfile());
    try {
      await primeCatalog([rawModel(ID, FREE)]);
      expect((await verifyProfile(baseUrl, ID)).status).toBe(200);
      const res = await post(
        baseUrl,
        '/api/recipes/generate',
        { prompt: 'a quick pasta' },
        selectionHeader(ID, 'free')
      );
      expect(res.status).toBe(503);
      expect(res.json.code).toBe('RECIPE_GENERATION_NOT_VERIFIED');
      expect(res.json.error).toContain('not for recipe creation');
      expect(stub.runtimeCalls()).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('recipe-verified dynamic model => 200 draft with exactly ONE runtime call, no fallback', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL, HOST: '127.0.0.1' });
    const stub = stubOpenRouter(async (_url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const content = String(body?.messages?.[0]?.content ?? '');
      if (content.startsWith('Return exactly this JSON object')) return okProfile();
      return okRecipe();
    });
    try {
      await primeCatalog([rawModel(ID, FREE)]);
      await verifyProfile(baseUrl, ID);
      expect((await verifyRecipe(baseUrl, ID)).status).toBe(200);

      const res = await post(
        baseUrl,
        '/api/recipes/generate',
        { prompt: 'a quick pasta' },
        selectionHeader(ID, 'free')
      );
      expect(res.status).toBe(200);
      expect(res.json.draft.title).toBe('Test Toast');
      expect(res.json.provenance).toMatchObject({ generated: true, providerId: 'openrouter', model: ID });
      expect(stub.runtimeCalls()).toHaveLength(1);
      expect(stub.runtimeCalls()[0]?.signal?.aborted).toBe(false); // normal response closure is not cancellation
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('stops Create for Me provider work after a real client disconnect and does not write a closed response', async () => {
    const { server, baseUrl, app } = await startApp({ OPENROUTER_API_KEY: SENTINEL, HOST: '127.0.0.1' });
    let responseAttemptsAfterClose = 0;
    const responsePrototype = app.response as any;
    const requestPrototype = app.request as any;
    const originalJson = responsePrototype.json;
    const requestOnce = requestPrototype.once; const requestOff = requestPrototype.off;
    const responseOnce = responsePrototype.once; const responseOff = responsePrototype.off;
    let requestListenerAdded = 0; let requestListenerRemoved = 0;
    let responseListenerAdded = 0; let responseListenerRemoved = 0;
    requestPrototype.once = function (event: string, listener: (...args: unknown[]) => void) {
      if (event === 'aborted' && listener.name === 'abortOnRequestAborted') requestListenerAdded += 1;
      return requestOnce.call(this, event, listener);
    };
    requestPrototype.off = function (event: string, listener: (...args: unknown[]) => void) {
      if (event === 'aborted' && listener.name === 'abortOnRequestAborted') requestListenerRemoved += 1;
      return requestOff.call(this, event, listener);
    };
    responsePrototype.once = function (event: string, listener: (...args: unknown[]) => void) {
      if (event === 'close' && listener.name === 'abortOnIncompleteResponseClose') responseListenerAdded += 1;
      return responseOnce.call(this, event, listener);
    };
    responsePrototype.off = function (event: string, listener: (...args: unknown[]) => void) {
      if (event === 'close' && listener.name === 'abortOnIncompleteResponseClose') responseListenerRemoved += 1;
      return responseOff.call(this, event, listener);
    };
    responsePrototype.json = function (...args: unknown[]) {
      if (this.destroyed) responseAttemptsAfterClose += 1;
      return originalJson.apply(this, args);
    };
    const stub = stubOpenRouter(async (_url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const content = String(body?.messages?.[0]?.content ?? '');
      if (content.startsWith('Return exactly this JSON object')) return okProfile();
      if (content.includes('Invent one tiny recipe')) return okRecipe();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal || signal.aborted) {
          reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener('abort', () => reject(Object.assign(new Error('request aborted'), { name: 'AbortError' })), { once: true });
      });
    });
    try {
      await primeCatalog([rawModel(ID, FREE)]);
      await verifyProfile(baseUrl, ID);
      await verifyRecipe(baseUrl, ID);
      const before = stub.runtimeCalls().length;
      const client = new AbortController();
      const pending = fetch(`${baseUrl}/api/recipes/generate`, {
        method: 'POST', signal: client.signal,
        headers: { 'Content-Type': 'application/json', ...selectionHeader(ID, 'free') },
        body: JSON.stringify({ prompt: 'a quick pasta' }),
      });
      await vi.waitFor(() => expect(stub.runtimeCalls()).toHaveLength(before + 1));
      const providerSignal = stub.calls.at(-1)?.signal;
      expect(providerSignal?.aborted).toBe(false);
      client.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
      expect(stub.runtimeCalls()).toHaveLength(before + 1); // no fallback/retry
      expect(responseAttemptsAfterClose).toBe(0);
      expect(requestListenerAdded).toBe(1);
      expect(requestListenerRemoved).toBe(1);
      expect(responseListenerAdded).toBe(1);
      expect(responseListenerRemoved).toBe(1);
    } finally {
      stub.restore();
      responsePrototype.json = originalJson;
      requestPrototype.once = requestOnce; requestPrototype.off = requestOff;
      responsePrototype.once = responseOnce; responsePrototype.off = responseOff;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('invalid runtime output => exactly one runtime call, bounded failure, no draft', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL, HOST: '127.0.0.1' });
    const stub = stubOpenRouter(async (_url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const content = String(body?.messages?.[0]?.content ?? '');
      if (content.startsWith('Return exactly this JSON object')) return okProfile();
      if (content.includes('Invent one tiny recipe')) return okRecipe();
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] }), { status: 200 });
    });
    try {
      await primeCatalog([rawModel(ID, FREE)]);
      await verifyProfile(baseUrl, ID);
      await verifyRecipe(baseUrl, ID);
      const res = await post(
        baseUrl,
        '/api/recipes/generate',
        { prompt: 'a quick pasta' },
        selectionHeader(ID, 'free')
      );
      expect(res.status).toBe(502);
      expect(res.json.draft).toBeUndefined();
      expect(stub.runtimeCalls()).toHaveLength(1); // no retry, no fallback
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('a credential-generation change after recipe verification blocks Create for Me', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL, HOST: '127.0.0.1' });
    const stub = stubOpenRouter(async (_url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const content = String(body?.messages?.[0]?.content ?? '');
      if (content.startsWith('Return exactly this JSON object')) return okProfile();
      return okRecipe();
    });
    try {
      await primeCatalog([rawModel(ID, FREE)]);
      await verifyProfile(baseUrl, ID);
      await verifyRecipe(baseUrl, ID);
      const store = await import('../../server/ai/capabilityVerificationStore.js');
      store.bumpCredentialGeneration('openrouter'); // simulate session key lifecycle change
      const res = await post(
        baseUrl,
        '/api/recipes/generate',
        { prompt: 'a quick pasta' },
        selectionHeader(ID, 'free')
      );
      expect(res.status).toBe(503);
      expect(res.json.code).toBe('RECIPE_GENERATION_NOT_VERIFIED');
      expect(stub.runtimeCalls()).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('curated OpenRouter Create for Me behavior is unchanged (static capability)', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL, HOST: '127.0.0.1' });
    const stub = stubOpenRouter(async () => okRecipe());
    try {
      const res = await post(
        baseUrl,
        '/api/recipes/generate',
        { prompt: 'a quick pasta' },
        selectionHeader('openai/gpt-4o-mini', 'budget')
      );
      expect(res.status).toBe(200);
      expect(res.json.draft.title).toBe('Test Toast');
      expect(stub.runtimeCalls()).toHaveLength(1);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
