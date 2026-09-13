import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { completionContent, validatesAiSchema, readRuntimeCompletion } from '../../server/ai/openRouterOutput.js';
import { APPLICATION_VALIDATED_JSON_PROFILE as JSON_MODE, STRICT_JSON_SCHEMA_PROFILE as STRICT } from '../../src/core/ai/openRouterProfile.js';

const ID = 'dynamic/compatible:free';
const KEY = 'sk-or-v1-MOCK_COMPATIBILITY_ONLY';
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } as const;
const raw = (price = '0', params = ['max_tokens', 'response_format', 'structured_outputs']) => ({
  id: ID, name: ID, context_length: 32000,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  pricing: { prompt: price, completion: price }, supported_parameters: params,
});
const response = (content: string, finish_reason = 'stop') =>
  new Response(JSON.stringify({ choices: [{ finish_reason, message: { content } }] }));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('OPENROUTER_API_KEY', KEY);
  vi.stubEnv('KITCHEN_CODEX_TEXT_PROVIDER', '');
  vi.stubEnv('KITCHEN_CODEX_TEXT_MODEL', '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function setup(profile = JSON_MODE as typeof JSON_MODE | typeof STRICT) {
  const catalog = await import('../../server/ai/openRouterCatalog.js');
  catalog.resetOpenRouterCatalogForTests();
  const refresh = async (models: unknown[] = [raw()]) => catalog.refreshOpenRouterCatalog({
    force: true, fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: models }) }),
  });
  await refresh();
  const store = await import('../../server/ai/capabilityVerificationStore.js');
  store.clearCapabilityVerificationsForTests();
  const verification = await import('../../server/ai/capabilityVerification.js');
  const probe = vi.fn(async () => response('{"ok":true}'));
  const result = await verification.verifyOpenRouterModelCapability({ modelId: ID, profile, fetchFn: probe });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, profile });
  const { OpenRouterProvider } = await import('../../server/ai/openRouterProvider.js');
  return { catalog, refresh, store, verification, probe, OpenRouterProvider };
}

describe('free OpenRouter explicit profile parity', () => {
  it.each([JSON_MODE, STRICT] as const)('records and executes %s with exact credentials, no fallback or retry', async profile => {
    const { catalog, store, probe, OpenRouterProvider } = await setup(profile);
    const record = store.getCapabilityVerification('openrouter', ID)!;
    expect(record).toMatchObject({ profile, probeVersion: store.CAPABILITY_PROBE_VERSION,
      catalogFingerprint: catalog.openRouterModelFingerprint(catalog.findOpenRouterCatalogModel(ID)) });
    expect(store.isCapabilityVerified('openrouter', ID, record.catalogFingerprint,
      record.verifiedAt + store.CAPABILITY_VERIFICATION_TTL_MS)).toBe(false);
    const fetchFn = vi.fn(async () => response('{"answer":"valid"}'));
    const provider = new OpenRouterProvider({ credential: KEY, fetchFn });
    expect(await provider.generateStructured('answer', schema as any, {
      model: ID, providerOptions: { profile: profile === STRICT ? JSON_MODE : STRICT },
    } as any)).toEqual({ answer: 'valid' });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const request = (fetchFn.mock.calls as any)[0][1];
    const probeRequest = (probe.mock.calls as any)[0][1];
    const body = JSON.parse(request.body);
    const probeBody = JSON.parse(probeRequest.body);
    expect(body.response_format.type).toBe(profile === STRICT ? 'json_schema' : 'json_object');
    expect(body.response_format.type).toBe(probeBody.response_format.type);
    expect(body.provider).toEqual(probeBody.provider);
    expect(body.reasoning).toEqual(probeBody.reasoning);
    expect(body.max_tokens).toBe(4096);
    expect(probeBody.max_tokens).toBe(512);
    expect(request.headers.Authorization).toBe('Bearer ' + KEY);
    expect(probeRequest.headers.Authorization).toBe('Bearer ' + KEY);
    expect(request.redirect).toBe('error');
    expect(catalog.openRouterDynamicCapabilities(ID)).toMatchObject({ recipeGeneration: false, webSearch: false });
  });

  it.each(['paid', 'stale', 'failed-refresh', 'absent', 'metadata', 'expired', 'restart'])('blocks %s immediately before runtime fetch', async change => {
    const { catalog, refresh, store, OpenRouterProvider } = await setup();
    if (change === 'paid') await refresh([raw('0.01')]);
    if (change === 'absent') await refresh([]);
    if (change === 'metadata') await refresh([raw('0', ['max_tokens', 'response_format'])]);
    if (change === 'restart') store.clearCapabilityVerificationsForTests();
    if (change === 'expired') {
      const record = store.getCapabilityVerification('openrouter', ID)!;
      store.recordCapabilityVerification({ ...record, verifiedAt: Date.now() - store.CAPABILITY_VERIFICATION_TTL_MS });
    }
    if (change === 'stale') {
      // Catalog TTL expires BEFORE the verification TTL: isolate price staleness.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + catalog.OPENROUTER_CATALOG_TTL_MS);
      const record = store.getCapabilityVerification('openrouter', ID)!;
      expect(store.isCapabilityVerified('openrouter', ID, record.catalogFingerprint)).toBe(true);
    }
    if (change === 'failed-refresh') {
      await catalog.refreshOpenRouterCatalog({ force: true, fetchFn: async () => { throw new Error('offline'); } });
      const fetchFn = vi.fn(async () => { throw new Error('still offline'); });
      const refreshed = await catalog.refreshOpenRouterCatalog({ fetchFn });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(refreshed.pricingFresh).toBe(false);
    }
    const fetchFn = vi.fn(async () => response('{"answer":"valid"}'));
    await expect(new OpenRouterProvider({ credential: KEY, fetchFn }).generateStructured('x', schema as any,
      { model: ID, providerOptions: { profile: JSON_MODE } } as any)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(['{"answer":3}', '{"answer":"x","extra":true}', '{}', '[]', '"text"', '```json\n{"answer":"x"}\n```'])('rejects invalid operation schema: %s', async content => {
    const { OpenRouterProvider } = await setup();
    const fetchFn = vi.fn(async () => response(content));
    const err = await new OpenRouterProvider({ credential: KEY, fetchFn }).generateStructured('x', schema as any, { model: ID }).catch(e => e);
    expect(err).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(String(err)).not.toContain(content);
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not cache successful probes when the catalog changes in flight', async () => {
    const { refresh, store, verification } = await setup();
    store.clearCapabilityVerificationsForTests();
    const fetchFn = vi.fn(async () => { await refresh([raw('0.01')]); return response('{"ok":true}'); });
    expect(await verification.verifyOpenRouterModelCapability({ modelId: ID, profile: JSON_MODE, fetchFn }))
      .toMatchObject({ ok: false, code: 'MODEL_PRICING_UNVERIFIED', providerCalled: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.capabilityVerificationCount()).toBe(0);
  });

  it('blocks a fresh capability probe after catalog TTL expires without a refresh', async () => {
    const { catalog, verification } = await setup();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + catalog.OPENROUTER_CATALOG_TTL_MS);
    const fetchFn = vi.fn(async () => response('{"ok":true}'));
    expect(await verification.verifyOpenRouterModelCapability({ modelId: ID, profile: JSON_MODE, fetchFn }))
      .toMatchObject({ ok: false, code: 'MODEL_PRICING_UNVERIFIED', providerCalled: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('honors an explicit verified JSON profile even when the exact free model is also curated', async () => {
    const { refresh, verification, OpenRouterProvider } = await setup();
    const id = 'openai/gpt-4o-mini';
    await refresh([{ ...raw(), id }]);
    expect(await verification.verifyOpenRouterModelCapability({
      modelId: id, profile: JSON_MODE, fetchFn: async () => response('{"ok":true}'),
    })).toMatchObject({ ok: true, profile: JSON_MODE });
    const fetchFn = vi.fn(async () => response('{"answer":"valid"}'));
    await new OpenRouterProvider({ credential: KEY, fetchFn }).generateStructured('x', schema as any, { model: id });
    expect(JSON.parse((fetchFn.mock.calls as any)[0][1].body).response_format).toEqual({ type: 'json_object' });
  });

  it('distinguishes curated baseline from verified-dynamic execution using trusted server state only', async () => {
    const { refresh, OpenRouterProvider } = await setup();
    const curatedId = 'openai/gpt-4o-mini';
    // Curated allowlist model is present and free but has NO verification record.
    await refresh([{ ...raw(), id: curatedId }, raw()]);

    const curatedFetch = vi.fn(async () => response('{"answer":"valid"}'));
    await new OpenRouterProvider({ credential: KEY, fetchFn: curatedFetch }).generateStructured(
      'x', schema as any, { model: curatedId }
    );
    const curatedBody = JSON.parse((curatedFetch.mock.calls as any)[0][1].body);
    expect(curatedBody.max_tokens).toBeUndefined();
    expect(curatedBody.reasoning).toBeUndefined();
    expect(curatedBody.response_format.json_schema.strict).toBe(true);
    expect(curatedBody.provider).toEqual({ require_parameters: true });

    // The verified dynamic model keeps the bounded runtime budget + reasoning,
    // even when the client claims a different profile.
    const dynamicFetch = vi.fn(async () => response('{"answer":"valid"}'));
    await new OpenRouterProvider({ credential: KEY, fetchFn: dynamicFetch }).generateStructured(
      'x', schema as any, { model: ID, providerOptions: { profile: STRICT } }
    );
    const dynamicBody = JSON.parse((dynamicFetch.mock.calls as any)[0][1].body);
    expect(dynamicBody.max_tokens).toBe(4096);
    expect(dynamicBody.reasoning).toEqual({ exclude: true });
    expect(dynamicBody.response_format.type).toBe('json_object');
  });

  it.each(['transport', 'body-read', 'http'])('never retains a private %s error body/cause or retries', async failure => {
    const { OpenRouterProvider } = await setup();
    const sentinel = 'PRIVATE_RESPONSE_' + KEY;
    const fetchFn = vi.fn(async () => {
      if (failure === 'transport') throw new Error(sentinel);
      if (failure === 'http') return new Response(sentinel, { status: 500 });
      return { ok: true, status: 200, body: { getReader: () => ({
        read: async () => { throw new Error(sentinel); }, releaseLock: () => {},
      }) } };
    });
    const err = await new OpenRouterProvider({ credential: KEY, fetchFn }).generateStructured('x', schema as any, { model: ID }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain(sentinel);
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect((err as Error).cause).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('verified-dynamic response ceiling and single-attempt policy', () => {
  it('cancels and rejects a verified-dynamic response exceeding 256 KiB with no leak', async () => {
    const { OpenRouterProvider } = await setup();
    const SENTINEL = 'DYNAMIC_RESPONSE_SENTINEL_' + KEY;
    let cancelled = false;
    let reads = 0;
    const chunk = new TextEncoder().encode(SENTINEL.padEnd(4096, 'x'));
    const body = {
      getReader: () => ({
        read: async () => (reads++ < 80 ? { done: false, value: chunk } : { done: true }),
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }),
    };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, body }));
    const err = await new OpenRouterProvider({ credential: KEY, fetchFn })
      .generateStructured('x', schema as any, { model: ID })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThan(80); // stopped at the 256 KiB ceiling
    expect(String(err)).not.toContain(SENTINEL);
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a forged client profile cannot bypass the verified-dynamic 256 KiB ceiling', async () => {
    const { OpenRouterProvider } = await setup();
    let cancelled = false;
    const chunk = new Uint8Array(4096);
    const body = {
      getReader: () => ({
        read: async () => ({ done: false, value: chunk }),
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }),
    };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, body }));
    const err = await new OpenRouterProvider({ credential: KEY, fetchFn })
      .generateStructured('x', schema as any, { model: ID, providerOptions: { profile: STRICT } })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(cancelled).toBe(true);
  });

  it('a verified model whose ID overlaps the curated allowlist still follows verified-dynamic behavior', async () => {
    const { refresh, verification, OpenRouterProvider } = await setup();
    const id = 'openai/gpt-4o-mini';
    await refresh([{ ...raw(), id }]);
    expect(
      await verification.verifyOpenRouterModelCapability({
        modelId: id,
        profile: JSON_MODE,
        fetchFn: async () => response('{"ok":true}'),
      })
    ).toMatchObject({ ok: true, profile: JSON_MODE });

    // Request shape: dynamic tokens/reasoning + stored profile.
    let seenInit: any;
    const okFetch = vi.fn(async (_u: string, init: any) => {
      seenInit = init;
      return response('{"answer":"valid"}');
    });
    await new OpenRouterProvider({ credential: KEY, fetchFn: okFetch as any }).generateStructured(
      'x', schema as any, { model: id }
    );
    const body = JSON.parse(seenInit.body);
    expect(body.max_tokens).toBe(4096);
    expect(body.reasoning).toEqual({ exclude: true });
    expect(body.response_format.type).toBe('json_object');

    // Response ceiling: the dynamic 256 KiB reader still applies (the overlap does
    // NOT fall back to the curated reader).
    let cancelled = false;
    const chunk = new Uint8Array(4096);
    const streamBody = {
      getReader: () => ({
        read: async () => ({ done: false, value: chunk }),
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }),
    };
    const err = await new OpenRouterProvider({
      credential: KEY,
      fetchFn: vi.fn(async () => ({ ok: true, status: 200, body: streamBody })) as any,
    })
      .generateStructured('x', schema as any, { model: id })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(cancelled).toBe(true);
  });

  it('resolves singleAttempt only from a current server-side verification record', async () => {
    const { refresh } = await setup(); // ID is verified
    const parse = await import('../../server/ai/parseSelectionMetadata.js');
    const { resolveRoleCandidates } = await import('../../server/ai/roleCandidates.js');
    const header = (modelId: string, cost: string) => ({
      'x-kitchen-ai-text-selection': JSON.stringify({
        mode: 'user_selected',
        providerId: 'openrouter',
        modelId,
        credentialSource: 'server_environment',
        selectedCostClass: cost,
      }),
    });
    const dynamic = resolveRoleCandidates(
      'recipeGrabber', undefined, parse.parseTextSelectionHeader(header(ID, 'free'))
    );
    expect(dynamic.find((c) => c.model === ID)?.singleAttempt).toBe(true);

    // Curated model WITHOUT a verification record is NOT singleAttempt.
    await refresh([{ ...raw(), id: 'openai/gpt-4o-mini' }, raw()]);
    const curated = resolveRoleCandidates(
      'recipeGrabber', undefined, parse.parseTextSelectionHeader(header('openai/gpt-4o-mini', 'budget'))
    );
    expect(curated.find((c) => c.model === 'openai/gpt-4o-mini')?.singleAttempt).toBeFalsy();
  });
});

describe('closed structural diagnostics and full operation validation', () => {
  it.each([
    [{ finish_reason: 'length', message: { content: '{"ok":true}' } }, 'output_truncated'],
    [{ finish_reason: 'length', message: { content: null } }, 'output_truncated'],
    [{ finish_reason: 'content_filter', message: { content: null } }, 'refusal'],
    [{ message: { refusal: 'private', content: '{}' } }, 'refusal'],
    [{ finish_reason: 'tool_calls', message: { content: null } }, 'tool_call_only'],
    [{ message: { tool_calls: [{}], content: '{}' } }, 'tool_call_only'],
    [{ message: { content: [{ type: 'text', text: '{}' }] } }, 'content_parts_unsupported'],
    [{ message: { content: null, reasoning: 'private' } }, 'empty_response'],
    [{ finish_reason: 'error', message: { content: '{}' } }, 'schema_mismatch'],
  ])('classifies without reading private output %#', (choice, reason) => {
    expect(completionContent({ choices: [choice] })).toEqual({ ok: false, reason });
  });

  it('validates nested enums, required fields, integers, optional null, and rejects extra fields', () => {
    const s: any = { type: 'object', properties: {
      rows: { type: 'array', items: { type: 'object', properties: {
        n: { type: 'integer' }, kind: { type: 'string', enum: ['a'] },
      }, required: ['n', 'kind'] } }, optional: { type: 'boolean' },
    }, required: ['rows'] };
    expect(validatesAiSchema({ rows: [{ n: 2, kind: 'a' }], optional: null }, s)).toBe(true);
    for (const row of [{ n: 1.5, kind: 'a' }, { n: 1, kind: 'b' }, { kind: 'a' }, { n: 1, kind: 'a', extra: 1 }]) {
      expect(validatesAiSchema({ rows: [row] }, s)).toBe(false);
    }
  });

  it('bounds runtime response before parsing and cancels oversized finite streams', async () => {
    let cancelled = false;
    let chunks = 0;
    const body = { getReader: () => ({
      read: async () => chunks++ < 80 ? { done: false, value: new Uint8Array(4096) } : { done: true },
      cancel: async () => { cancelled = true; }, releaseLock: () => {},
    }) };
    await expect(readRuntimeCompletion({ body })).rejects.toThrow('exceeds limit');
    expect(cancelled).toBe(true);
    expect(chunks).toBe(65);
  });
});
