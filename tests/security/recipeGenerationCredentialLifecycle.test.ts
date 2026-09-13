import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

/**
 * Flag 2 — credential lifecycle integration coverage.
 *
 * A previously successful `recipe_generation_v1` authorization must become
 * unusable BEFORE dispatch after every relevant credential lifecycle transition:
 * session key replacement, revocation, expiry (via the normal lazy-purge/read
 * path), and credential-source transition (both directions).
 *
 * The REAL `/api/recipes/generate` route, the REAL recipe authorization/dispatch
 * path, and the REAL session-secret lifecycle APIs are exercised. OpenRouter is
 * fully mocked; no live provider call, no credential access, no vault write.
 */

const ID = 'dynamic/recipe:free';
const SESSION = 'sk-or-v1-LIFECYCLE_SESSION_SENTINEL';
const SESSION_REPLACEMENT = 'sk-or-v1-LIFECYCLE_REPLACEMENT_SENTINEL';
const ENV_KEY = 'sk-or-v1-LIFECYCLE_ENV_SENTINEL';
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
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

interface RecordedCall {
  url: string;
  body: any;
}

/**
 * Intercepts OpenRouter traffic only. Localhost calls (the test's own requests
 * to the app) pass through; any OTHER external provider is recorded as
 * `unexpected` and answered synthetically so no live network call can occur.
 */
function stubOpenRouter(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  const unexpected: string[] = [];
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
      calls.push({ url, body });
      return handler(url, init);
    }
    if (typeof url === 'string' && (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost'))) {
      return original(input, init);
    }
    unexpected.push(String(url));
    return new Response('{}', { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    unexpected,
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

const okRecipe = () =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: VALID_RECIPE } }] }), { status: 200 });
const okProfile = () =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }), { status: 200 });

function probeStubHandler() {
  return async (_url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const content = String(body?.messages?.[0]?.content ?? '');
    if (content.startsWith('Return exactly this JSON object')) return okProfile();
    return okRecipe();
  };
}

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

function verifyProfile(baseUrl: string, credentialSource: 'server_environment' | 'session_only') {
  const encoded = ID.split('/').map((s) => encodeURIComponent(s)).join('/');
  return post(baseUrl, `/api/providers/openrouter/models/${encoded}/verify`, {
    credentialSource,
    profile: APP_VALIDATED,
  });
}

function verifyRecipe(baseUrl: string, credentialSource: 'server_environment' | 'session_only') {
  const encoded = ID.split('/').map((s) => encodeURIComponent(s)).join('/');
  return post(baseUrl, `/api/providers/openrouter/models/${encoded}/verify-recipe`, { credentialSource });
}

function selectionHeader(credentialSource: 'server_environment' | 'session_only'): Record<string, string> {
  return {
    [TEXT_HEADER]: JSON.stringify({
      mode: 'user_selected',
      providerId: 'openrouter',
      modelId: ID,
      credentialSource,
      selectedCostClass: 'free',
    }),
  };
}

function assertNoExposure(json: unknown) {
  const body = JSON.stringify(json);
  for (const secret of [SESSION, SESSION_REPLACEMENT, ENV_KEY]) {
    expect(body).not.toContain(secret);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Flag 2 — credential lifecycle invalidates recipe authorization before dispatch', () => {
  it('session key REPLACEMENT invalidates the recipe authorization (zero additional fetch)', async () => {
    const { server, baseUrl } = await startApp({ HOST: '127.0.0.1' });
    const stub = stubOpenRouter(probeStubHandler());
    try {
      await primeCatalog([rawModel(ID, FREE)]);
      const secrets = await import('../../server/ai/sessionSecrets.js');
      const first = secrets.setSessionSecret('openrouter', SESSION);
      expect((await verifyProfile(baseUrl, 'session_only')).status).toBe(200);
      expect((await verifyRecipe(baseUrl, 'session_only')).status).toBe(200);

      const catalog = await import('../../server/ai/openRouterCatalog.js');
      expect(catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(true);

      const replaced = secrets.setSessionSecret('openrouter', SESSION_REPLACEMENT, first.version);
      expect(replaced.version).not.toBe(first.version);
      expect(catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(false);

      const before = stub.calls.length;
      const res = await post(baseUrl, '/api/recipes/generate', { prompt: 'a quick pasta' }, selectionHeader('session_only'));
      expect(res.status).toBe(503);
      expect(res.json.code).toBe('RECIPE_GENERATION_NOT_VERIFIED');
      expect(res.json.draft).toBeUndefined();
      expect(stub.calls.length).toBe(before);
      expect(stub.unexpected).toHaveLength(0);
      assertNoExposure(res.json);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('session key REVOCATION invalidates the recipe authorization (zero additional fetch)', async () => {
    const { server, baseUrl } = await startApp({ HOST: '127.0.0.1' });
    const stub = stubOpenRouter(probeStubHandler());
    try {
      await primeCatalog([rawModel(ID, FREE)]);
      const secrets = await import('../../server/ai/sessionSecrets.js');
      secrets.setSessionSecret('openrouter', SESSION);
      expect((await verifyProfile(baseUrl, 'session_only')).status).toBe(200);
      expect((await verifyRecipe(baseUrl, 'session_only')).status).toBe(200);

      const catalog = await import('../../server/ai/openRouterCatalog.js');
      expect(catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(true);
      secrets.revokeSessionSecret('openrouter');
      expect(catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(false);

      const before = stub.calls.length;
      const res = await post(baseUrl, '/api/recipes/generate', { prompt: 'a quick pasta' }, selectionHeader('session_only'));
      expect(res.status).toBe(503);
      expect(res.json.code).toBe('RECIPE_GENERATION_NOT_VERIFIED');
      expect(res.json.draft).toBeUndefined();
      expect(stub.calls.length).toBe(before);
      expect(stub.unexpected).toHaveLength(0);
      assertNoExposure(res.json);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('session key EXPIRY via the normal lazy-purge/read path invalidates the recipe authorization', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { server, baseUrl } = await startApp({ HOST: '127.0.0.1' });
    const stub = stubOpenRouter(probeStubHandler());
    try {
      await primeCatalog([rawModel(ID, FREE)]);
      const secrets = await import('../../server/ai/sessionSecrets.js');
      secrets.setSessionSecret('openrouter', SESSION);
      expect((await verifyProfile(baseUrl, 'session_only')).status).toBe(200);
      expect((await verifyRecipe(baseUrl, 'session_only')).status).toBe(200);

      const catalog = await import('../../server/ai/openRouterCatalog.js');
      expect(catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(true);

      // Past the IDLE TTL (15m), but within the recipe (30m) and profile (45m)
      // TTLs, so only the credential lifecycle — not record TTL — is exercised.
      vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
      // Keep the trusted catalog fresh so pricing freshness is not the cause.
      await primeCatalog([rawModel(ID, FREE)]);

      // The NORMAL lazy-purge/read path removes the expired entry and bumps the
      // opaque credential generation (never manipulated directly).
      expect(secrets.getSessionSecret('openrouter')).toBeUndefined();
      expect(catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(false);

      const before = stub.calls.length;
      const res = await post(baseUrl, '/api/recipes/generate', { prompt: 'a quick pasta' }, selectionHeader('session_only'));
      expect(res.status).toBe(503);
      expect(res.json.code).toBe('RECIPE_GENERATION_NOT_VERIFIED');
      expect(res.json.draft).toBeUndefined();
      expect(stub.calls.length).toBe(before);
      expect(stub.unexpected).toHaveLength(0);
      assertNoExposure(res.json);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('Flag 2 — credential-source transition invalidates recipe authorization before dispatch', () => {
  it('a session_only authorization cannot authorize server_environment execution', async () => {
    const { server, baseUrl } = await startApp({ HOST: '127.0.0.1', OPENROUTER_API_KEY: ENV_KEY });
    const stub = stubOpenRouter(probeStubHandler());
    try {
      await primeCatalog([rawModel(ID, FREE)]);
      const secrets = await import('../../server/ai/sessionSecrets.js');
      secrets.setSessionSecret('openrouter', SESSION);
      expect((await verifyProfile(baseUrl, 'session_only')).status).toBe(200);
      expect((await verifyRecipe(baseUrl, 'session_only')).status).toBe(200);

      const before = stub.calls.length;
      const res = await post(baseUrl, '/api/recipes/generate', { prompt: 'a quick pasta' }, selectionHeader('server_environment'));
      expect(res.status).toBe(503);
      expect(res.json.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(res.json.draft).toBeUndefined();
      expect(stub.calls.length).toBe(before);
      expect(stub.unexpected).toHaveLength(0);
      assertNoExposure(res.json);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('a server_environment authorization cannot authorize session_only execution', async () => {
    const { server, baseUrl } = await startApp({ HOST: '127.0.0.1', OPENROUTER_API_KEY: ENV_KEY });
    const stub = stubOpenRouter(probeStubHandler());
    try {
      await primeCatalog([rawModel(ID, FREE)]);
      const secrets = await import('../../server/ai/sessionSecrets.js');
      // A live session key exists so session_only execution is structurally
      // resolvable — only the EXACT credential-source binding can reject it.
      secrets.setSessionSecret('openrouter', SESSION);
      expect((await verifyProfile(baseUrl, 'server_environment')).status).toBe(200);
      expect((await verifyRecipe(baseUrl, 'server_environment')).status).toBe(200);

      const before = stub.calls.length;
      const res = await post(baseUrl, '/api/recipes/generate', { prompt: 'a quick pasta' }, selectionHeader('session_only'));
      expect(res.status).toBe(503);
      expect(res.json.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(res.json.draft).toBeUndefined();
      expect(stub.calls.length).toBe(before);
      expect(stub.unexpected).toHaveLength(0);
      assertNoExposure(res.json);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
