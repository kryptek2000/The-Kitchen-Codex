import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

/**
 * Terra IMPORTANT 1 — verified-dynamic Recipe Grabber must receive exactly ONE
 * provider attempt. Route/integration-level: the explicit verification probe is
 * distinguished from the Recipe Grabber runtime call, and the local JSON-LD /
 * heuristic fallback is asserted. OpenRouter is fully mocked (no live calls).
 */

const SENTINEL = 'sk-or-v1-GRAB_RETRY_SENTINEL';
const TEXT_HEADER = 'x-kitchen-ai-text-selection';
const PROBE_NAME = 'kitchen_codex_capability_probe';
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

const SAMPLE_TEXT =
  'Creamy Garlic Pasta\n1 cup pasta, 2 cloves garlic, 1 tbsp olive oil\nInstructions:\n1. Cook pasta.\n2. Saute garlic.\n3. Combine.';

const FREE = { prompt: '0', completion: '0' };

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
  method: string;
  body: any;
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
      calls.push({ url, method: (init?.method ?? 'GET') as string, body });
      return handler(url, init);
    }
    return original(input, init);
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    runtimeCalls: () =>
      calls.filter((c) => c.body?.response_format?.json_schema?.name !== PROBE_NAME),
    probeCalls: () => calls.filter((c) => c.body?.response_format?.json_schema?.name === PROBE_NAME),
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

function probeResponse(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function malformedRuntimeResponse(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
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

function verify(baseUrl: string, modelId: string, body: Record<string, unknown> = {}) {
  const encoded = modelId.split('/').map((s) => encodeURIComponent(s)).join('/');
  return post(baseUrl, `/api/providers/openrouter/models/${encoded}/verify`, body);
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

describe('Recipe Grabber — verified-dynamic single-attempt policy', () => {
  it('dynamic invalid output => exactly ONE runtime attempt, then local heuristic fallback', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async (_url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body?.response_format?.json_schema?.name === PROBE_NAME) return probeResponse();
      return malformedRuntimeResponse();
    });
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const verified = await verify(baseUrl, 'dynamic/free');
      expect(verified.status).toBe(200);
      // The explicit verification probe is the ONLY call so far.
      expect(stub.probeCalls()).toHaveLength(1);
      expect(stub.runtimeCalls()).toHaveLength(0);

      const res = await post(
        baseUrl,
        '/api/grab-recipe',
        { rawText: SAMPLE_TEXT },
        selectionHeader('dynamic/free', 'free')
      );
      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      expect(res.json.recipe.title).toBeTruthy();
      // Exactly ONE runtime attempt after the probe — no same-model retry.
      expect(stub.runtimeCalls()).toHaveLength(1);
      expect(stub.probeCalls()).toHaveLength(1);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('dynamic HTTP 429 (RATE_LIMIT) => still exactly ONE runtime attempt, then local fallback', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async (_url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body?.response_format?.json_schema?.name === PROBE_NAME) return probeResponse();
      return new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 });
    });
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      expect((await verify(baseUrl, 'dynamic/free')).status).toBe(200);

      const res = await post(
        baseUrl,
        '/api/grab-recipe',
        { rawText: SAMPLE_TEXT },
        selectionHeader('dynamic/free', 'free')
      );
      expect(res.status).toBe(200);
      expect(res.json.recipe.title).toBeTruthy();
      expect(stub.runtimeCalls()).toHaveLength(1);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('curated baseline retains TWO attempts on invalid output (no regression)', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => malformedRuntimeResponse());
    try {
      const res = await post(
        baseUrl,
        '/api/grab-recipe',
        { rawText: SAMPLE_TEXT },
        selectionHeader('openai/gpt-4o-mini', 'budget')
      );
      expect(res.status).toBe(200);
      expect(res.json.recipe.title).toBeTruthy();
      // Baseline curated retry behavior: same curated model attempted twice.
      expect(stub.runtimeCalls()).toHaveLength(2);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('an unverified dynamic model is blocked before ANY runtime call even with a forged selection', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => probeResponse());
    try {
      // Discovered free model, but NO server-side verification record.
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const res = await post(
        baseUrl,
        '/api/grab-recipe',
        { rawText: SAMPLE_TEXT },
        selectionHeader('dynamic/free', 'free')
      );
      expect(res.status).toBe(200);
      expect(res.json.recipe.title).toBeTruthy();
      // No probe and no runtime call — the client cannot forge dynamic execution.
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
