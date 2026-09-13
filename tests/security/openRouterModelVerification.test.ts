import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

/**
 * v0.8.x — explicit ZERO-COST OpenRouter capability verification (route/security).
 *
 * Proves the free-pricing gate, exact credential identity, strict probe contract,
 * bounded failures, in-memory caching, and that a verified dynamic model becomes
 * selectable/executable while unverified models stay non-executable. OpenRouter
 * is fully mocked — NO live inference and NO paid calls occur.
 */

const SENTINEL = 'sk-or-v1-CAPABILITY_VERIFY_SENTINEL';
const IMAGE_SENTINEL = 'sk-or-v1-IMAGE_ONLY_SENTINEL';
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
  'HOST',
  'K_SERVICE',
  'K_REVISION',
  'K_CONFIGURATION',
  'KITCHEN_CODEX_DISABLE_SESSION_BYOK',
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

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

function stubOpenRouter(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  let unexpectedProviderCalls = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (typeof url === 'string' && url.startsWith('https://openrouter.ai/')) {
      const headers: Record<string, string> = {};
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
      let body: any = undefined;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url, method: (init?.method ?? 'GET') as string, headers, body });
      return handler(url, init);
    }
    if (!url.startsWith('http://127.0.0.1:')) {
      unexpectedProviderCalls++;
      throw new Error('Unexpected external provider request in isolated test.');
    }
    return original(input, init);
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    chatCalls: () => calls.filter((c) => c.url.endsWith('/chat/completions')),
    unexpectedProviderCalls: () => unexpectedProviderCalls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function catalogFetch(payload: unknown) {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
}

function rawModel(id: string, pricing: Record<string, string>, params: string[] = [
  'temperature',
  'max_tokens',
  'response_format',
  'structured_outputs',
]) {
  return {
    id,
    name: id,
    context_length: 128000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing,
    supported_parameters: params,
  };
}

const FREE = { prompt: '0', completion: '0' };
const PAID = { prompt: '0.00000015', completion: '0.0000006' };
const VARIABLE = { prompt: '0', completion: '0', unknown_field: '0.1' };

async function primeCatalog(models: unknown[]) {
  const catalog = await import('../../server/ai/openRouterCatalog.js');
  catalog.resetOpenRouterCatalogForTests();
  await catalog.refreshOpenRouterCatalog({ force: true, fetchFn: catalogFetch({ data: models }) });
  return catalog;
}

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A FINITE, chunked transport fixture for the probe: a fetch-shaped response
 * whose `body.getReader()` yields a COMPLETE, syntactically valid body in 4 KiB
 * chunks and records whether production cancelled the reader. The reader is
 * deterministic and never hangs: once cancelled (or exhausted) `read()` reports
 * `done`. Only the transport is mocked — the production bounded reader still
 * performs the real overflow detection and calls `cancel()` itself.
 */
function chunkedProbeFixture(body: string): {
  response: Response;
  wasCancelled: () => boolean;
  totalBytes: number;
} {
  const bytes = new TextEncoder().encode(body);
  const CHUNK_BYTES = 4096;
  let offset = 0;
  let cancelled = false;
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (cancelled || offset >= bytes.byteLength) return { done: true };
      const end = Math.min(offset + CHUNK_BYTES, bytes.byteLength);
      const value = bytes.subarray(offset, end);
      offset = end;
      return { done: false, value };
    },
    async cancel(): Promise<void> {
      cancelled = true;
    },
    releaseLock(): void {
      /* no-op */
    },
  };
  return {
    // The production probe only reads `.ok`, `.status`, and `.body.getReader()`.
    response: { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response,
    wasCancelled: () => cancelled,
    totalBytes: bytes.byteLength,
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

function verify(baseUrl: string, modelId: string, body: Record<string, unknown> = {}) {
  const encoded = modelId
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  return post(baseUrl, `/api/providers/openrouter/models/${encoded}/verify`, body);
}

function selectionHeader(modelId: string, costClass = 'free'): Record<string, string> {
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('explicit capability verification — success + contract', () => {
  it('A/I/O/V/G. verifies a fresh free model with the exact strict contract, caches it, and makes it selectable', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => okResponse('{"ok":true}'));
    try {
      const catalog = await primeCatalog([rawModel('dynamic/free', FREE)]);
      // W: unverified free model is NOT executable yet.
      expect(catalog.openRouterSelectableTextModelIds()).not.toContain('dynamic/free');

      const res = await verify(baseUrl, 'dynamic/free');
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true, providerId: 'openrouter', modelId: 'dynamic/free' });
      expect(res.json.profile).toBe('strict_json_schema_v1');
      expect(JSON.stringify(res.json)).not.toContain(SENTINEL);

      // G: exact credential identity + exact model + exact strict mechanics.
      expect(stub.chatCalls()).toHaveLength(1);
      const call = stub.chatCalls()[0];
      expect(call.headers['authorization']).toBe(`Bearer ${SENTINEL}`);
      expect(call.body.model).toBe('dynamic/free');
      expect(call.body.response_format.type).toBe('json_schema');
      expect(call.body.response_format.json_schema.strict).toBe(true);
      expect(call.body.provider).toEqual({ require_parameters: true });

      // O: cached in server memory.
      const store = await import('../../server/ai/capabilityVerificationStore.js');
      expect(store.getCapabilityVerification('openrouter', 'dynamic/free')).toBeTruthy();
      // V: now selectable/executable.
      expect(catalog.openRouterSelectableTextModelIds()).toContain('dynamic/free');
      const { buildProviderCatalog } = await import('../../server/ai/providerCatalog.js');
      const built = buildProviderCatalog();
      const row = built.textProviders
        .find((p) => p.providerId === 'openrouter')!
        .models.find((m) => m.id === 'dynamic/free');
      expect(row?.executionCompatible).toBe(true);
      expect(row?.capabilityVerified).toBe(true);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('S. re-verifying a previously verified model that became PAID reports MODEL_PRICING_CHANGED with zero calls', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => okResponse('{"ok":true}'));
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const first = await verify(baseUrl, 'dynamic/free');
      expect(first.status).toBe(200);
      expect(stub.chatCalls()).toHaveLength(1);

      await primeCatalog([rawModel('dynamic/free', PAID)]);
      const second = await verify(baseUrl, 'dynamic/free');
      expect(second.status).toBe(409);
      expect(second.json.code).toBe('MODEL_PRICING_CHANGED');
      expect(stub.chatCalls()).toHaveLength(1);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('zero-cost free-pricing gate — ZERO provider calls on failure', () => {
  it('B. a PAID model cannot be probed', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => {
      throw new Error('provider must not be called');
    });
    try {
      await primeCatalog([rawModel('dynamic/paid', PAID)]);
      const res = await verify(baseUrl, 'dynamic/paid');
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('MODEL_NOT_VERIFIED_FREE');
      expect(stub.chatCalls()).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('C. a variable/unknown-pricing model cannot be probed', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => {
      throw new Error('provider must not be called');
    });
    try {
      await primeCatalog([rawModel('dynamic/variable', VARIABLE)]);
      const res = await verify(baseUrl, 'dynamic/variable');
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('MODEL_PRICING_UNVERIFIED');
      expect(stub.chatCalls()).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('D. stale free pricing cannot be probed', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => {
      throw new Error('provider must not be called');
    });
    try {
      const catalog = await primeCatalog([rawModel('dynamic/free', FREE)]);
      await catalog.refreshOpenRouterCatalog({
        force: true,
        fetchFn: async () => {
          throw new Error('network down');
        },
      });
      const res = await verify(baseUrl, 'dynamic/free');
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('MODEL_PRICING_UNVERIFIED');
      expect(stub.chatCalls()).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('E. a missing model cannot be probed', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => {
      throw new Error('provider must not be called');
    });
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const res = await verify(baseUrl, 'dynamic/absent');
      expect(res.status).toBe(404);
      expect(res.json.code).toBe('MODEL_NOT_FOUND');
      expect(stub.chatCalls()).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('F. an arbitrary/invalid client model id is rejected', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => {
      throw new Error('provider must not be called');
    });
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const res = await verify(baseUrl, 'bad model!');
      expect(res.status).toBe(400);
      expect(res.json.code).toBe('INVALID_MODEL');
      expect(stub.chatCalls()).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('rejects a router model without any provider request', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => {
      throw new Error('provider must not be called');
    });
    try {
      await primeCatalog([rawModel('openrouter/free', FREE)]);
      const res = await verify(baseUrl, 'openrouter/free');
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('MODEL_ROUTER_NOT_SUPPORTED');
      expect(stub.chatCalls()).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('credential identity isolation', () => {
  it('H. an openrouter-image session key cannot satisfy text verification', async () => {
    const { server, baseUrl } = await startApp({});
    const stub = stubOpenRouter(async () => {
      throw new Error('provider must not be called');
    });
    try {
      const secrets = await import('../../server/ai/sessionSecrets.js');
      secrets.setSessionSecret('openrouter-image', IMAGE_SENTINEL);
      expect(secrets.getSessionSecretStatus('openrouter-image').configured).toBe(true);
      expect(secrets.getSessionSecretStatus('openrouter').configured).toBe(false);

      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const res = await verify(baseUrl, 'dynamic/free', { credentialSource: 'session_only' });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('SESSION_CREDENTIAL_MISSING');
      expect(stub.chatCalls()).toHaveLength(0);
      expect(JSON.stringify(res.json)).not.toContain(IMAGE_SENTINEL);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('a missing server credential fails closed with zero provider calls', async () => {
    const { server, baseUrl } = await startApp({});
    const stub = stubOpenRouter(async () => {
      throw new Error('provider must not be called');
    });
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const res = await verify(baseUrl, 'dynamic/free');
      expect(res.status).toBe(503);
      expect(res.json.code).toBe('CREDENTIAL_SOURCE_UNAVAILABLE');
      expect(stub.chatCalls()).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('strict probe failures are bounded and never cached', () => {
  const cases: { name: string; content: string; classification: string }[] = [
    { name: 'J. plain text fails', content: 'ok', classification: 'PROBE_MALFORMED_JSON' },
    { name: 'K. malformed assistant JSON fails', content: '{not json', classification: 'PROBE_MALFORMED_JSON' },
    { name: 'L. schema mismatch fails', content: '{"ok":false}', classification: 'PROBE_WRONG_REQUIRED_VALUE' },
    { name: 'L2. extra structure fails', content: '{"ok":true,"extra":1}', classification: 'PROBE_EXTRA_PROPERTIES' },
    { name: 'L3. Markdown-wrapped JSON fails', content: '```json\n{"ok":true}\n```', classification: 'PROBE_MALFORMED_JSON' },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
      const stub = stubOpenRouter(async () => okResponse(c.content));
      try {
        const catalog = await primeCatalog([rawModel('dynamic/free', FREE)]);
        const res = await verify(baseUrl, 'dynamic/free');
        expect(res.status).toBe(422);
        expect(res.json.code).toBe('MODEL_CAPABILITY_UNVERIFIED');
        // Bounded public classification is present and correct.
        expect(res.json.probeClassification).toBe(c.classification);
        // Exactly ONE attempt (Z: no retry loop) and no false cache.
        expect(stub.chatCalls()).toHaveLength(1);
        const store = await import('../../server/ai/capabilityVerificationStore.js');
        expect(store.getCapabilityVerification('openrouter', 'dynamic/free')).toBeUndefined();
        // W: still non-executable.
        expect(catalog.openRouterSelectableTextModelIds()).not.toContain('dynamic/free');
      } finally {
        stub.restore();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  }

  it('M. a provider error fails boundedly without leaking raw provider text', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(
      async () =>
        new Response(JSON.stringify({ error: { message: `raw provider ${SENTINEL}` } }), { status: 500 })
    );
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const res = await verify(baseUrl, 'dynamic/free');
      expect(res.status).toBe(422);
      expect(res.json.code).toBe('MODEL_CAPABILITY_UNVERIFIED');
      expect(res.json.probeClassification).toBe('PROBE_UNAVAILABLE');
      expect(JSON.stringify(res.json)).not.toContain(SENTINEL);
      expect(JSON.stringify(res.json)).not.toContain('raw provider');
      expect(stub.chatCalls()).toHaveLength(1);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('N. a timeout is handled boundedly with no retry', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const res = await verify(baseUrl, 'dynamic/free');
      expect(res.status).toBe(422);
      expect(res.json.code).toBe('MODEL_CAPABILITY_UNVERIFIED');
      expect(res.json.probeClassification).toBe('PROBE_TIMEOUT');
      expect(stub.chatCalls()).toHaveLength(1);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('O1. a VALID oversized streamed response is rejected by the real route bound (not by JSON parsing) and never becomes executable', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    // Import the production ceiling + validator so the fixture is NOT a competing
    // boundary implementation and its validity is proven with production code.
    const { CAPABILITY_PROBE_MAX_RESPONSE_BYTES, validateCapabilityProbeContent } =
      await import('../../server/ai/capabilityVerification.js');

    // A COMPLETE, syntactically valid OpenRouter chat-completion. Its assistant
    // content is exactly `{"ok":true}`, which satisfies the strict probe schema.
    // Padding (an ignored `reasoning` field) pushes the encoded body beyond the
    // production ceiling. If the production size bound were removed, THIS EXACT
    // response would be accepted and recorded as a successful verification.
    const padding = 'P'.repeat(CAPABILITY_PROBE_MAX_RESPONSE_BYTES);
    const validBody = JSON.stringify({
      id: 'gen-capability-probe',
      object: 'chat.completion',
      created: 0,
      model: 'dynamic/free',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '{"ok":true}', reasoning: padding },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    // Independent validity proof (production validator, not the route under test):
    // the body is valid JSON, the completion shape is exact, and the embedded
    // assistant content passes the strict capability schema.
    const encodedBytes = new TextEncoder().encode(validBody).byteLength;
    expect(encodedBytes).toBeGreaterThan(CAPABILITY_PROBE_MAX_RESPONSE_BYTES);
    const parsedBody = JSON.parse(validBody) as any;
    expect(parsedBody.choices[0].message.content).toBe('{"ok":true}');
    expect(validateCapabilityProbeContent(parsedBody.choices[0].message.content)).toEqual({ ok: true });

    const fixture = chunkedProbeFixture(validBody);
    expect(fixture.totalBytes).toBe(encodedBytes);
    const stub = stubOpenRouter(async () => fixture.response);
    try {
      const catalog = await primeCatalog([rawModel('dynamic/free', FREE)]);
      const res = await verify(baseUrl, 'dynamic/free');

      // The probe RAN (one attempt, no retry) but the oversized body is rejected.
      expect(stub.chatCalls()).toHaveLength(1);
      // Existing intended safe rejection: MODEL_CAPABILITY_UNVERIFIED (422).
      expect(res.status).toBe(422);
      expect(res.json.ok).toBe(false);
      expect(res.json.code).toBe('MODEL_CAPABILITY_UNVERIFIED');
      expect(res.json.probeClassification).toBe('PROBE_OVERSIZED');
      // The body is never accepted/parsed as a valid verification, and neither its
      // content nor the credential sentinel leaks into the response.
      const responseBody = JSON.stringify(res.json);
      expect(responseBody).not.toContain(SENTINEL);
      expect(responseBody).not.toContain('"ok":true');

      // Directly observed: production cancelled the stream reader on overflow.
      expect(fixture.wasCancelled()).toBe(true);

      // Never cached as a success.
      const store = await import('../../server/ai/capabilityVerificationStore.js');
      expect(store.getCapabilityVerification('openrouter', 'dynamic/free')).toBeUndefined();

      // Direct production-API proof: the model is absent from the selectable set
      // and cannot resolve to an executable text candidate.
      expect(catalog.openRouterSelectableTextModelIds()).not.toContain('dynamic/free');
      const parse = await import('../../server/ai/parseSelectionMetadata.js');
      const intent = parse.parseTextSelectionHeader(selectionHeader('dynamic/free', 'free'));
      const { resolveExecutableTextCandidates } = await import('../../server/ai/effectiveSelection.js');
      const candidates = resolveExecutableTextCandidates('kitchenInterpret', undefined, intent);
      expect(candidates.some((c) => c.model === 'dynamic/free')).toBe(false);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('bounded probe classifications pass through the real verification route', () => {
  const statusCases = [
    { name: '401 -> auth', status: 401, classification: 'PROBE_AUTH' },
    { name: '403 -> auth', status: 403, classification: 'PROBE_AUTH' },
    { name: '402 -> quota', status: 402, classification: 'PROBE_QUOTA' },
    { name: '404 -> no compatible endpoint', status: 404, classification: 'PROBE_NO_COMPATIBLE_ENDPOINT' },
    { name: '429 -> rate limit', status: 429, classification: 'PROBE_RATE_LIMIT' },
    { name: '500 -> unavailable', status: 500, classification: 'PROBE_UNAVAILABLE' },
    { name: '503 -> unavailable', status: 503, classification: 'PROBE_UNAVAILABLE' },
    { name: '400 -> generic http error', status: 400, classification: 'PROBE_HTTP_ERROR' },
  ];

  for (const c of statusCases) {
    it(`${c.name} => HTTP 422 / MODEL_CAPABILITY_UNVERIFIED / ${c.classification}, one call, no leak`, async () => {
      const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
      const stub = stubOpenRouter(
        async () =>
          new Response(JSON.stringify({ error: { message: `upstream body ${SENTINEL}` } }), {
            status: c.status,
          })
      );
      try {
        const catalog = await primeCatalog([rawModel('dynamic/free', FREE)]);
        const res = await verify(baseUrl, 'dynamic/free');
        expect(res.status).toBe(422);
        expect(res.json.code).toBe('MODEL_CAPABILITY_UNVERIFIED');
        expect(res.json.probeClassification).toBe(c.classification);
        expect(JSON.stringify(res.json)).not.toContain(SENTINEL);
        expect(JSON.stringify(res.json)).not.toContain('upstream body');
        // Exactly one attempt, no retry, no cache, still non-executable.
        expect(stub.chatCalls()).toHaveLength(1);
        const store = await import('../../server/ai/capabilityVerificationStore.js');
        expect(store.getCapabilityVerification('openrouter', 'dynamic/free')).toBeUndefined();
        expect(catalog.openRouterSelectableTextModelIds()).not.toContain('dynamic/free');
      } finally {
        stub.restore();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  }

  it('an empty 200 body => PROBE_EMPTY_RESPONSE', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => new Response('', { status: 200 }));
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const res = await verify(baseUrl, 'dynamic/free');
      expect(res.status).toBe(422);
      expect(res.json.probeClassification).toBe('PROBE_EMPTY_RESPONSE');
      expect(stub.chatCalls()).toHaveLength(1);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('a malformed 200 completion body => PROBE_MALFORMED_JSON', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => new Response('{not json', { status: 200 }));
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const res = await verify(baseUrl, 'dynamic/free');
      expect(res.status).toBe(422);
      expect(res.json.probeClassification).toBe('PROBE_MALFORMED_JSON');
      expect(stub.chatCalls()).toHaveLength(1);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('catalog exposes the server-owned strict-structured candidate signal', () => {
  it('marks a Liquid-like free model as a candidate, a Gemma-like one as not, and excludes audio-output models', async () => {
    const { server } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    try {
      await primeCatalog([
        rawModel('liquid/lfm-like:free', FREE),
        rawModel('google/gemma-like:free', FREE, ['temperature', 'max_tokens', 'response_format']),
        {
          id: 'google/lyria-like',
          name: 'Lyria-like',
          context_length: 1000,
          architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] },
          pricing: FREE,
          supported_parameters: ['temperature', 'max_tokens', 'response_format', 'structured_outputs'],
        },
      ]);
      const { buildProviderCatalog } = await import('../../server/ai/providerCatalog.js');
      const built = buildProviderCatalog();
      const provider = built.textProviders.find((p) => p.providerId === 'openrouter')!;
      const all = [...provider.models, ...(provider.discoveredModels ?? [])];

      const liquid = all.find((m) => m.id === 'liquid/lfm-like:free');
      expect(liquid?.strictStructuredCandidate).toBe(true);
      expect(liquid?.executionCompatible).toBe(false); // candidate != executable

      const gemma = all.find((m) => m.id === 'google/gemma-like:free');
      expect(gemma?.strictStructuredCandidate).toBe(false);
      expect(gemma?.executionCompatible).toBe(false);

      expect(all.some((m) => m.id === 'google/lyria-like')).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('no automatic verification + rate limiting + no forge', () => {
  it('X/Y/W. rendering/selecting a discovered free model never triggers a probe', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => okResponse('{"ok":true}'));
    try {
      const catalog = await primeCatalog([rawModel('dynamic/free', FREE)]);
      const { buildProviderCatalog } = await import('../../server/ai/providerCatalog.js');
      // Rendering the catalog (picker data) must not verify anything.
      buildProviderCatalog();
      expect(stub.chatCalls()).toHaveLength(0);
      // Selecting the unverified model fails closed with zero provider calls.
      const res = await post(
        baseUrl,
        '/api/kitchen/interpret',
        { question: 'what can I make with chicken' },
        selectionHeader('dynamic/free', 'free')
      );
      expect(res.status).toBe(200);
      expect(stub.chatCalls()).toHaveLength(0);
      expect(catalog.openRouterSelectableTextModelIds()).not.toContain('dynamic/free');
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('U. the catalog never claims verification for an unverified model', async () => {
    const { server } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const { buildProviderCatalog } = await import('../../server/ai/providerCatalog.js');
      const built = buildProviderCatalog();
      const provider = built.textProviders.find((p) => p.providerId === 'openrouter')!;
      const row = (provider.discoveredModels ?? []).find((m) => m.id === 'dynamic/free');
      expect(row).toBeTruthy();
      expect(row?.capabilityVerified ?? false).toBe(false);
      expect(row?.executionCompatible).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('rate-limits repeated verification attempts', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => {
      throw new Error('provider must not be called');
    });
    try {
      await primeCatalog([rawModel('dynamic/paid', PAID)]);
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await verify(baseUrl, 'dynamic/paid');
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
      expect(stub.chatCalls()).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('explicit application-validated JSON route', () => {
  it('verifies JSON-only metadata using the exact session identity, then executes the recorded profile', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: 'OPERATOR_NOT_SESSION' });
    let attempt = 0;
    const stub = stubOpenRouter(async () => okResponse(attempt++ === 0 ? '{"ok":true}' : intentContent()));
    try {
      const secrets = await import('../../server/ai/sessionSecrets.js');
      secrets.setSessionSecret('openrouter', SENTINEL);
      const catalog = await primeCatalog([rawModel('dynamic/json', FREE, ['max_tokens', 'response_format'])]);
      expect(catalog.isOpenRouterJsonCandidate(catalog.findOpenRouterCatalogModel('dynamic/json'))).toBe(true);
      expect(catalog.isOpenRouterStrictStructuredCandidate(catalog.findOpenRouterCatalogModel('dynamic/json'))).toBe(false);
      const verified = await verify(baseUrl, 'dynamic/json', {
        credentialSource: 'session_only', profile: 'application_validated_json_v1',
      });
      expect(verified.status).toBe(200);
      expect(verified.json.profile).toBe('application_validated_json_v1');
      const store = await import('../../server/ai/capabilityVerificationStore.js');
      expect(store.getCapabilityVerification('openrouter', 'dynamic/json')?.profile).toBe('application_validated_json_v1');
      const headers = { [TEXT_HEADER]: JSON.stringify({
        mode: 'user_selected', providerId: 'openrouter', modelId: 'dynamic/json',
        credentialSource: 'session_only', selectedCostClass: 'free',
      }) };
      const result = await post(baseUrl, '/api/kitchen/interpret', { question: 'what can I make with chicken' }, headers);
      expect(result.status).toBe(200);
      expect(result.json.source).toBe('ai');
      expect(stub.chatCalls()).toHaveLength(2);
      for (const call of stub.chatCalls()) {
        expect(call.headers.authorization).toBe('Bearer ' + SENTINEL);
        expect(call.body.model).toBe('dynamic/json');
        expect(call.body.response_format).toEqual({ type: 'json_object' });
        expect(call.body.provider).toEqual({ require_parameters: true });
        expect(call.body.reasoning).toEqual({ exclude: true });
      }
      const built = (await import('../../server/ai/providerCatalog.js')).buildProviderCatalog();
      expect(built.textProviders.find(p => p.providerId === 'openrouter')?.models.find(m => m.id === 'dynamic/json'))
        .toMatchObject({ capabilityVerified: true, executionCompatible: true, verifiedProfile: 'application_validated_json_v1' });
      expect(JSON.stringify([verified.json, result.json])).not.toContain(SENTINEL);
    } finally {
      stub.restore();
      await new Promise<void>(r => server.close(() => r()));
    }
  });

  it('rejects an unknown profile before network and never trusts client verification claims', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => okResponse('{"ok":true}'));
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const res = await verify(baseUrl, 'dynamic/free', { profile: 'forged' });
      expect(res.status).toBe(400);
      const forged = await post(baseUrl, '/api/kitchen/interpret', { question: 'chicken', profile: 'application_validated_json_v1', capabilityVerified: true }, selectionHeader('dynamic/free'));
      expect(forged.json.source).not.toBe('ai');
      expect(stub.chatCalls()).toHaveLength(0);
      const store = await import('../../server/ai/capabilityVerificationStore.js');
      expect(store.capabilityVerificationCount()).toBe(0);
    } finally {
      stub.restore();
      await new Promise<void>(r => server.close(() => r()));
    }
  });

  it('rejects runtime schema failure into deterministic interpretation without a paid/provider retry', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL, DEEPSEEK_API_KEY: 'OTHER_PROVIDER_MOCK' });
    let calls = 0;
    const stub = stubOpenRouter(async () => okResponse(calls++ === 0 ? '{"ok":true}' : '{"private":"PRIVATE_BODY_SENTINEL"}'));
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      expect((await verify(baseUrl, 'dynamic/free', { profile: 'application_validated_json_v1' })).status).toBe(200);
      const res = await post(baseUrl, '/api/kitchen/interpret', { question: 'what can I make with chicken' }, selectionHeader('dynamic/free'));
      expect(res.status).toBe(200);
      expect(res.json.source).toBe('deterministic');
      expect(stub.chatCalls()).toHaveLength(2); // one explicit probe, one runtime attempt
      expect(stub.unexpectedProviderCalls()).toBe(0);
      expect(stub.chatCalls().every(c => c.body.model === 'dynamic/free')).toBe(true);
      expect(JSON.stringify(res.json)).not.toContain('PRIVATE_BODY_SENTINEL');
      expect(JSON.stringify(res.json)).not.toContain(SENTINEL);
    } finally {
      stub.restore();
      await new Promise<void>(r => server.close(() => r()));
    }
  });

  it.each([
    ['length', null, 'PROBE_OUTPUT_TRUNCATED'],
    ['length', '{"ok":true}', 'PROBE_OUTPUT_TRUNCATED'],
    ['content_filter', null, 'PROBE_REFUSAL'],
    ['tool_calls', null, 'PROBE_TOOL_CALL_ONLY'],
    ['stop', [{ type: 'text', text: 'PRIVATE_BODY_SENTINEL' }], 'PROBE_CONTENT_PARTS_UNSUPPORTED'],
    ['stop', '[]', 'PROBE_WRONG_JSON_SHAPE'],
    ['stop', '{"ok":false}', 'PROBE_WRONG_REQUIRED_VALUE'],
    ['stop', '{"ok":true,"extra":"PRIVATE_BODY_SENTINEL"}', 'PROBE_EXTRA_PROPERTIES'],
  ])('rejects %s/%j once, with no cached success or private output', async (finish_reason, content, classification) => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => new Response(JSON.stringify({
      choices: [{ finish_reason, message: { content, reasoning: SENTINEL } }],
    })));
    try {
      const catalog = await primeCatalog([rawModel('dynamic/free', FREE)]);
      const res = await verify(baseUrl, 'dynamic/free', { profile: 'application_validated_json_v1' });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: 'MODEL_CAPABILITY_UNVERIFIED', probeClassification: classification });
      expect(stub.chatCalls()).toHaveLength(1);
      expect(stub.chatCalls()[0].body.response_format).toEqual({ type: 'json_object' });
      expect(JSON.stringify(res.json)).not.toContain(SENTINEL);
      expect(JSON.stringify(res.json)).not.toContain('PRIVATE_BODY_SENTINEL');
      expect((await import('../../server/ai/capabilityVerificationStore.js')).capabilityVerificationCount()).toBe(0);
      expect(catalog.openRouterSelectableTextModelIds()).not.toContain('dynamic/free');
    } finally {
      stub.restore();
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});

describe('integrated: a verified dynamic model serves structured operations', () => {
  it('after verification, Ask My Kitchen (kitchenInterpret) executes the verified model', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async (_url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      // The probe and the real interpret call both use the same model.
      if (body.response_format?.json_schema?.name === 'kitchen_codex_capability_probe') {
        return okResponse('{"ok":true}');
      }
      return okResponse(intentContent());
    });
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const verified = await verify(baseUrl, 'dynamic/free');
      expect(verified.status).toBe(200);

      const res = await post(
        baseUrl,
        '/api/kitchen/interpret',
        { question: 'what can I make with chicken' },
        selectionHeader('dynamic/free', 'free')
      );
      expect(res.status).toBe(200);
      expect(res.json.code).toBeUndefined();
      const chat = stub.chatCalls();
      expect(chat.length).toBeGreaterThanOrEqual(2);
      expect(chat[chat.length - 1].body.model).toBe('dynamic/free');
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('a verified dynamic model serves the strict structured roles but NOT Create for Me or web discovery', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => okResponse('{"ok":true}'));
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const verified = await verify(baseUrl, 'dynamic/free');
      expect(verified.status).toBe(200);

      const parse = await import('../../server/ai/parseSelectionMetadata.js');
      const intent = parse.parseTextSelectionHeader(selectionHeader('dynamic/free', 'free'));
      const { resolveExecutableTextCandidates } = await import('../../server/ai/effectiveSelection.js');

      // Ask My Kitchen interpretation/ranking + the strict structured text roles.
      for (const op of [
        'kitchenInterpret',
        'kitchenRank',
        'nutrition',
        'metadataRecovery',
        'recipeGrabber',
      ] as const) {
        const candidates = resolveExecutableTextCandidates(op, undefined, intent);
        expect(candidates.some((c) => c.model === 'dynamic/free')).toBe(true);
      }
      // Create for Me requires recipeGeneration (NOT proven by the strict probe).
      const createCandidates = resolveExecutableTextCandidates('createRecipe', undefined, intent);
      expect(createCandidates.some((c) => c.model === 'dynamic/free')).toBe(false);
      // Web discovery requires grounded web search (OpenRouter never claims it).
      const discoverCandidates = resolveExecutableTextCandidates('kitchenDiscover', undefined, intent);
      expect(discoverCandidates.some((c) => c.model === 'dynamic/free')).toBe(false);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('FREE -> PAID after verification: execution is blocked and no probe/provider call occurs', async () => {
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => okResponse('{"ok":true}'));
    try {
      await primeCatalog([rawModel('dynamic/free', FREE)]);
      const verified = await verify(baseUrl, 'dynamic/free');
      expect(verified.status).toBe(200);
      expect(stub.chatCalls()).toHaveLength(1);

      // The trusted catalog now reports the model as PAID.
      await primeCatalog([rawModel('dynamic/free', PAID)]);

      const res = await post(
        baseUrl,
        '/api/kitchen/interpret',
        { question: 'what can I make with chicken' },
        selectionHeader('dynamic/free', 'free')
      );
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('MODEL_PRICING_CHANGED');
      // ZERO additional provider calls under the stale FREE acknowledgement.
      expect(stub.chatCalls()).toHaveLength(1);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
