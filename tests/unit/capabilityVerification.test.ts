import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * v0.8.x — capability verification core (unit).
 *
 * Proves the probe request/response contract, the fingerprint-bound in-memory
 * store, and the catalog's dynamic selectability rule WITHOUT any network call.
 */

const RAW_MODEL = (id: string, pricing: Record<string, string>, params: string[] = [
  'temperature',
  'max_tokens',
  'response_format',
  'structured_outputs',
]) => ({
  id,
  name: id,
  context_length: 128000,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  pricing,
  supported_parameters: params,
});

const FREE = { prompt: '0', completion: '0' };
const PAID = { prompt: '0.00000015', completion: '0.0000006' };

async function prime(models: unknown[]) {
  const catalog = await import('../../server/ai/openRouterCatalog.js');
  catalog.resetOpenRouterCatalogForTests();
  await catalog.refreshOpenRouterCatalog({
    force: true,
    fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: models }) }),
  });
  return catalog;
}

beforeEach(async () => {
  vi.resetModules();
  delete process.env.OPENROUTER_API_KEY;
  const store = await import('../../server/ai/capabilityVerificationStore.js');
  store.clearCapabilityVerificationsForTests();
});

describe('capability probe request contract', () => {
  it('uses the exact production strict json_schema mechanics', async () => {
    const { buildCapabilityProbeRequest, CAPABILITY_PROBE_SCHEMA } = await import(
      '../../server/ai/capabilityVerification.js'
    );
    const body = buildCapabilityProbeRequest('openai/gpt-4o-mini') as any;
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema).toEqual(CAPABILITY_PROBE_SCHEMA);
    expect(body.provider).toEqual({ require_parameters: true });
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens).toBe(512);
    expect(body.reasoning).toEqual({ exclude: true });
    // No optional fields in the schema; `ok` is required and objects are closed.
    expect(CAPABILITY_PROBE_SCHEMA.required).toEqual(['ok']);
    expect(CAPABILITY_PROBE_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('capability probe response validation', () => {
  it('accepts exactly {"ok":true} (with surrounding whitespace)', async () => {
    const { validateCapabilityProbeContent } = await import('../../server/ai/capabilityVerification.js');
    expect(validateCapabilityProbeContent('{"ok":true}')).toEqual({ ok: true });
    expect(validateCapabilityProbeContent('  \n {"ok": true} \n ')).toEqual({ ok: true });
  });

  it('rejects plain text, markdown-wrapped JSON, malformed JSON, and schema mismatches', async () => {
    const { validateCapabilityProbeContent } = await import('../../server/ai/capabilityVerification.js');
    expect(validateCapabilityProbeContent('ok')).toMatchObject({ ok: false, reason: 'malformed_json' });
    expect(validateCapabilityProbeContent('```json\n{"ok":true}\n```')).toMatchObject({
      ok: false,
      reason: 'malformed_json',
    });
    expect(validateCapabilityProbeContent('{not json')).toMatchObject({ ok: false, reason: 'malformed_json' });
    expect(validateCapabilityProbeContent('{"ok":false}')).toMatchObject({ ok: false, reason: 'wrong_required_value' });
    expect(validateCapabilityProbeContent('{"ok":true,"extra":1}')).toMatchObject({
      ok: false,
      reason: 'extra_properties',
    });
    expect(validateCapabilityProbeContent('[{"ok":true}]')).toMatchObject({ ok: false, reason: 'wrong_json_shape' });
    expect(validateCapabilityProbeContent('')).toMatchObject({ ok: false, reason: 'empty_response' });
  });
});

describe('capability verification store', () => {
  it('is valid only while fingerprint + probe version match and TTL is unexpired', async () => {
    const store = await import('../../server/ai/capabilityVerificationStore.js');
    const { CAPABILITY_PROBE_VERSION } = store;
    store.recordCapabilityVerification({
      providerId: 'openrouter',
      modelId: 'a/one',
      catalogFingerprint: 'fp-1',
      probeVersion: CAPABILITY_PROBE_VERSION,
      verifiedAt: 1_000,
    });
    expect(store.isCapabilityVerified('openrouter', 'a/one', 'fp-1', 1_000)).toBe(true);
    // Fingerprint mismatch (price/capability changed) invalidates.
    expect(store.isCapabilityVerified('openrouter', 'a/one', 'fp-2', 1_000)).toBe(false);
    // Probe-version mismatch invalidates.
    store.recordCapabilityVerification({
      providerId: 'openrouter',
      modelId: 'a/two',
      catalogFingerprint: 'fp-1',
      probeVersion: 'old_version',
      verifiedAt: 1_000,
    });
    expect(store.isCapabilityVerified('openrouter', 'a/two', 'fp-1', 1_000)).toBe(false);
    // TTL expiry.
    const ttl = store.CAPABILITY_VERIFICATION_TTL_MS;
    expect(store.isCapabilityVerified('openrouter', 'a/one', 'fp-1', 1_000 + ttl - 1)).toBe(true);
    expect(store.isCapabilityVerified('openrouter', 'a/one', 'fp-1', 1_000 + ttl)).toBe(false);
  });

  it('invalidate removes a record; clear empties the store', async () => {
    const store = await import('../../server/ai/capabilityVerificationStore.js');
    store.recordCapabilityVerification({
      providerId: 'openrouter',
      modelId: 'a/one',
      catalogFingerprint: 'fp',
      probeVersion: store.CAPABILITY_PROBE_VERSION,
      verifiedAt: Date.now(),
    });
    expect(store.getCapabilityVerification('openrouter', 'a/one')).toBeTruthy();
    store.invalidateCapabilityVerification('openrouter', 'a/one');
    expect(store.getCapabilityVerification('openrouter', 'a/one')).toBeUndefined();
    store.recordCapabilityVerification({
      providerId: 'openrouter',
      modelId: 'a/two',
      catalogFingerprint: 'fp',
      probeVersion: store.CAPABILITY_PROBE_VERSION,
      verifiedAt: Date.now(),
    });
    store.clearCapabilityVerificationsForTests();
    expect(store.capabilityVerificationCount()).toBe(0);
  });
});

describe('catalog dynamic selectability', () => {
  it('keeps an unverified free dynamic model non-executable, then selectable after verification', async () => {
    const catalog = await prime([RAW_MODEL('dynamic/free', FREE)]);
    const model = catalog.findOpenRouterCatalogModel('dynamic/free');
    expect(model).toBeTruthy();
    // Unverified -> discovered only.
    expect(catalog.isSelectableOpenRouterTextModel(model)).toBe(false);
    expect(catalog.openRouterSelectableTextModelIds()).not.toContain('dynamic/free');

    const store = await import('../../server/ai/capabilityVerificationStore.js');
    store.recordCapabilityVerification({
      providerId: 'openrouter',
      modelId: 'dynamic/free',
      catalogFingerprint: catalog.openRouterModelFingerprint(model),
      probeVersion: store.CAPABILITY_PROBE_VERSION,
      verifiedAt: Date.now(),
    });
    // Verified + fresh + free -> selectable and structured-capable.
    expect(catalog.isSelectableOpenRouterTextModel(model)).toBe(true);
    expect(catalog.openRouterSelectableTextModelIds()).toContain('dynamic/free');
    expect(catalog.openRouterDynamicCapabilities('dynamic/free')).toMatchObject({ structuredOutput: true });

    // A refresh that leaves the fingerprint unchanged PRESERVES the verification.
    await prime([RAW_MODEL('dynamic/free', FREE)]);
    const refreshed = catalog.findOpenRouterCatalogModel('dynamic/free');
    expect(catalog.isSelectableOpenRouterTextModel(refreshed)).toBe(true);
    expect(catalog.openRouterSelectableTextModelIds()).toContain('dynamic/free');
  });

  it('never promotes a router even with a recorded verification', async () => {
    const catalog = await prime([RAW_MODEL('openrouter/free', FREE)]);
    const model = catalog.findOpenRouterCatalogModel('openrouter/free');
    expect(model.isRouter).toBe(true);
    const store = await import('../../server/ai/capabilityVerificationStore.js');
    store.recordCapabilityVerification({
      providerId: 'openrouter',
      modelId: 'openrouter/free',
      catalogFingerprint: catalog.openRouterModelFingerprint(model),
      probeVersion: store.CAPABILITY_PROBE_VERSION,
      verifiedAt: Date.now(),
    });
    expect(catalog.isCapabilityVerifiedOpenRouterTextModel(model)).toBe(false);
    expect(catalog.isSelectableOpenRouterTextModel(model)).toBe(false);
    expect(catalog.openRouterSelectableTextModelIds()).not.toContain('openrouter/free');
  });

  it('FREE -> PAID changes the fingerprint and invalidates the verification', async () => {
    const catalog = await prime([RAW_MODEL('dynamic/free', FREE)]);
    const freeModel = catalog.findOpenRouterCatalogModel('dynamic/free');
    const store = await import('../../server/ai/capabilityVerificationStore.js');
    store.recordCapabilityVerification({
      providerId: 'openrouter',
      modelId: 'dynamic/free',
      catalogFingerprint: catalog.openRouterModelFingerprint(freeModel),
      probeVersion: store.CAPABILITY_PROBE_VERSION,
      verifiedAt: Date.now(),
    });
    expect(catalog.isSelectableOpenRouterTextModel(freeModel)).toBe(true);

    // The model becomes PAID in the next trusted catalog.
    await prime([RAW_MODEL('dynamic/free', PAID)]);
    const paidModel = catalog.findOpenRouterCatalogModel('dynamic/free');
    expect(catalog.openRouterModelFingerprint(paidModel)).not.toBe(
      catalog.openRouterModelFingerprint(freeModel)
    );
    expect(catalog.isSelectableOpenRouterTextModel(paidModel)).toBe(false);
    expect(catalog.openRouterSelectableTextModelIds()).not.toContain('dynamic/free');
  });

  it('a capability/metadata change changes the fingerprint and invalidates the verification', async () => {
    const catalog = await prime([RAW_MODEL('dynamic/free', FREE)]);
    const before = catalog.findOpenRouterCatalogModel('dynamic/free');
    const store = await import('../../server/ai/capabilityVerificationStore.js');
    store.recordCapabilityVerification({
      providerId: 'openrouter',
      modelId: 'dynamic/free',
      catalogFingerprint: catalog.openRouterModelFingerprint(before),
      probeVersion: store.CAPABILITY_PROBE_VERSION,
      verifiedAt: Date.now(),
    });
    // Same price, but the advertised capability parameters changed.
    await prime([RAW_MODEL('dynamic/free', FREE, ['temperature', 'max_tokens', 'response_format'])]);
    const after = catalog.findOpenRouterCatalogModel('dynamic/free');
    expect(catalog.openRouterModelFingerprint(after)).not.toBe(catalog.openRouterModelFingerprint(before));
    expect(catalog.isSelectableOpenRouterTextModel(after)).toBe(false);
  });

  it('a disappeared model is no longer selectable', async () => {
    const catalog = await prime([RAW_MODEL('dynamic/gone', FREE)]);
    const model = catalog.findOpenRouterCatalogModel('dynamic/gone');
    const store = await import('../../server/ai/capabilityVerificationStore.js');
    store.recordCapabilityVerification({
      providerId: 'openrouter',
      modelId: 'dynamic/gone',
      catalogFingerprint: catalog.openRouterModelFingerprint(model),
      probeVersion: store.CAPABILITY_PROBE_VERSION,
      verifiedAt: Date.now(),
    });
    expect(catalog.openRouterSelectableTextModelIds()).toContain('dynamic/gone');
    // The model disappears from the trusted catalog.
    await prime([RAW_MODEL('other/model', FREE)]);
    expect(catalog.findOpenRouterCatalogModel('dynamic/gone')).toBeUndefined();
    expect(catalog.openRouterSelectableTextModelIds()).not.toContain('dynamic/gone');
  });

  it('stale pricing truth disables a previously verified dynamic model', async () => {
    const catalog = await prime([RAW_MODEL('dynamic/free', FREE)]);
    const model = catalog.findOpenRouterCatalogModel('dynamic/free');
    const store = await import('../../server/ai/capabilityVerificationStore.js');
    store.recordCapabilityVerification({
      providerId: 'openrouter',
      modelId: 'dynamic/free',
      catalogFingerprint: catalog.openRouterModelFingerprint(model),
      probeVersion: store.CAPABILITY_PROBE_VERSION,
      verifiedAt: Date.now(),
    });
    expect(catalog.isSelectableOpenRouterTextModel(model)).toBe(true);
    // A failed refresh marks the retained snapshot as NOT pricing-fresh.
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: async () => {
        throw new Error('network down');
      },
    });
    expect(catalog.getOpenRouterCatalogSnapshot().pricingFresh).toBe(false);
    const staleModel = catalog.findOpenRouterCatalogModel('dynamic/free');
    expect(catalog.isSelectableOpenRouterTextModel(staleModel)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bounded public failure classification
// ---------------------------------------------------------------------------

/** A body-reader-shaped fetch response returning `text` in 4 KiB chunks. */
function textResponse(text: string) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (offset >= bytes.byteLength) return { done: true };
      const end = Math.min(offset + 4096, bytes.byteLength);
      const value = bytes.subarray(offset, end);
      offset = end;
      return { done: false, value };
    },
    async cancel(): Promise<void> {},
    releaseLock(): void {},
  };
  return { ok: true, status: 200, body: { getReader: () => reader } };
}

async function primeCandidateAndSetCredential() {
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-UNIT-CLASSIFICATION-SENTINEL';
  const catalog = await prime([RAW_MODEL('dynamic/candidate', FREE)]);
  return catalog;
}

describe('probe failure classification mapping', () => {
  it('maps EVERY internal reason to exactly one bounded public classification', async () => {
    const { PROBE_FAILURE_CLASSIFICATION, probeFailureClassification, PROBE_FAILURE_MESSAGES } =
      await import('../../server/ai/capabilityVerification.js');
    const publicSet = new Set(Object.keys(PROBE_FAILURE_MESSAGES));
    const reasons = Object.keys(PROBE_FAILURE_CLASSIFICATION) as (keyof typeof PROBE_FAILURE_CLASSIFICATION)[];
    expect(reasons.length).toBeGreaterThanOrEqual(12);
    for (const reason of reasons) {
      const cls = probeFailureClassification(reason);
      expect(typeof cls).toBe('string');
      expect(publicSet.has(cls)).toBe(true);
      expect(probeFailureClassification(reason)).toBe(cls); // exactly one
    }
  });

  it('maps non-success HTTP statuses to the correct internal reason', async () => {
    const { probeFailureReasonForHttpStatus } = await import('../../server/ai/capabilityVerification.js');
    expect(probeFailureReasonForHttpStatus(401)).toBe('auth');
    expect(probeFailureReasonForHttpStatus(403)).toBe('auth');
    expect(probeFailureReasonForHttpStatus(402)).toBe('quota');
    expect(probeFailureReasonForHttpStatus(404)).toBe('no_compatible_endpoint');
    expect(probeFailureReasonForHttpStatus(429)).toBe('rate_limit');
    expect(probeFailureReasonForHttpStatus(500)).toBe('unavailable');
    expect(probeFailureReasonForHttpStatus(503)).toBe('unavailable');
    expect(probeFailureReasonForHttpStatus(400)).toBe('http_error');
    expect(probeFailureReasonForHttpStatus(418)).toBe('http_error');
  });

  it('classifies transport, timeout, empty, oversized, malformed, and schema failures end-to-end', async () => {
    const { verifyOpenRouterModelCapability } = await import('../../server/ai/capabilityVerification.js');
    const SENTINEL = 'sk-or-v1-UNIT-CLASSIFICATION-SENTINEL';
    const run = async (fetchFn: any) => {
      await primeCandidateAndSetCredential();
      const result = await verifyOpenRouterModelCapability({ modelId: 'dynamic/candidate', fetchFn });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('MODEL_CAPABILITY_UNVERIFIED');
        expect(JSON.stringify(result)).not.toContain(SENTINEL);
      }
      return result;
    };

    const expectCls = async (fetchFn: any, cls: string) => {
      const result = await run(fetchFn);
      if (result.ok === false) expect(result.probeClassification).toBe(cls);
    };

    await expectCls(async () => ({ ok: false, status: 401, body: null }), 'PROBE_AUTH');
    await expectCls(async () => ({ ok: false, status: 403, body: null }), 'PROBE_AUTH');
    await expectCls(async () => ({ ok: false, status: 402, body: null }), 'PROBE_QUOTA');
    await expectCls(async () => ({ ok: false, status: 404, body: null }), 'PROBE_NO_COMPATIBLE_ENDPOINT');
    await expectCls(async () => ({ ok: false, status: 429, body: null }), 'PROBE_RATE_LIMIT');
    await expectCls(async () => ({ ok: false, status: 500, body: null }), 'PROBE_UNAVAILABLE');
    await expectCls(async () => ({ ok: false, status: 400, body: null }), 'PROBE_HTTP_ERROR');
    await expectCls(async () => {
      throw new Error('socket hang up');
    }, 'PROBE_TRANSPORT_ERROR');
    await expectCls(async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }, 'PROBE_TIMEOUT');
    await expectCls(async () => textResponse(''), 'PROBE_EMPTY_RESPONSE');
    await expectCls(async () => textResponse('   '), 'PROBE_EMPTY_RESPONSE');
    await expectCls(async () => textResponse('A'.repeat(20000)), 'PROBE_OVERSIZED');
    await expectCls(async () => textResponse('{not json'), 'PROBE_MALFORMED_JSON');
    await expectCls(
      async () => textResponse(JSON.stringify({ choices: [{ message: { content: 'not json' } }] })),
      'PROBE_MALFORMED_JSON'
    );
    await expectCls(
      async () => textResponse(JSON.stringify({ choices: [{ message: { content: '{"ok":false}' } }] })),
      'PROBE_WRONG_REQUIRED_VALUE'
    );
    await expectCls(
      async () => textResponse(JSON.stringify({ choices: [{ message: { content: '{"ok":true,"x":1}' } }] })),
      'PROBE_EXTRA_PROPERTIES'
    );

    // Success is unchanged: valid strict content verifies.
    await primeCandidateAndSetCredential();
    const ok = await verifyOpenRouterModelCapability({
      modelId: 'dynamic/candidate',
      fetchFn: async () => textResponse(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })),
    });
    expect(ok.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Candidate eligibility + output-modality filtering
// ---------------------------------------------------------------------------

const RAW_MODEL_ARCH = (
  id: string,
  pricing: Record<string, string>,
  outputModalities: string[],
  inputModalities: string[] = ['text'],
  params: string[] = ['temperature', 'max_tokens', 'response_format', 'structured_outputs']
) => ({
  id,
  name: id,
  context_length: 128000,
  architecture: { input_modalities: inputModalities, output_modalities: outputModalities },
  pricing,
  supported_parameters: params,
});

describe('candidate eligibility + modality filtering', () => {
  it('a Gemma-like free model (response_format, no structured_outputs) is discoverable but NOT a candidate', async () => {
    const catalog = await prime([
      RAW_MODEL_ARCH('google/gemma-like:free', FREE, ['text'], ['image', 'text', 'video'], [
        'temperature',
        'max_tokens',
        'response_format',
      ]),
    ]);
    const model = catalog.findOpenRouterCatalogModel('google/gemma-like:free');
    expect(catalog.isCompatibleOpenRouterTextModel(model)).toBe(true);
    expect(catalog.isOpenRouterStrictStructuredCandidate(model)).toBe(false);
    expect(catalog.isSelectableOpenRouterTextModel(model)).toBe(false);
  });

  it('a Liquid-like free model (response_format + structured_outputs) is a candidate but NOT executable', async () => {
    const catalog = await prime([RAW_MODEL_ARCH('liquid/lfm-like:free', FREE, ['text'])]);
    const model = catalog.findOpenRouterCatalogModel('liquid/lfm-like:free');
    expect(catalog.isOpenRouterStrictStructuredCandidate(model)).toBe(true);
    expect(catalog.isSelectableOpenRouterTextModel(model)).toBe(false);
    expect(catalog.openRouterSelectableTextModelIds()).not.toContain('liquid/lfm-like:free');
  });

  it('a Lyria-like text+audio OUTPUT model is excluded from ordinary text discovery', async () => {
    const catalog = await prime([RAW_MODEL_ARCH('google/lyria-like', FREE, ['text', 'audio'])]);
    // Excluded at normalization: it is neither an ordinary text model nor an image model.
    expect(catalog.findOpenRouterCatalogModel('google/lyria-like')).toBeUndefined();
    expect(catalog.openRouterTextModelIds()).not.toContain('google/lyria-like');
    expect(catalog.openRouterImageModelIds()).not.toContain('google/lyria-like');
    // Direct predicate proof (audio output is not ordinary text output).
    const raw = catalog.normalizeOpenRouterModel(
      RAW_MODEL_ARCH('google/lyria-like-direct', FREE, ['text', 'audio'])
    );
    expect(catalog.isOrdinaryTextOutputModel(raw)).toBe(false);
    expect(catalog.isCompatibleOpenRouterTextModel(raw)).toBe(false);
    expect(catalog.isOpenRouterStrictStructuredCandidate(raw)).toBe(false);
  });

  it('image/video INPUT on a text-OUTPUT model does NOT exclude it', async () => {
    const catalog = await prime([
      RAW_MODEL_ARCH('vendor/vision-text:free', FREE, ['text'], ['image', 'text', 'video']),
    ]);
    const model = catalog.findOpenRouterCatalogModel('vendor/vision-text:free');
    expect(catalog.isCompatibleOpenRouterTextModel(model)).toBe(true);
    expect(catalog.isOpenRouterStrictStructuredCandidate(model)).toBe(true);
  });

  it('router models remain ineligible candidates', async () => {
    const catalog = await prime([RAW_MODEL_ARCH('openrouter/free', FREE, ['text'])]);
    const model = catalog.findOpenRouterCatalogModel('openrouter/free');
    expect(model.isRouter).toBe(true);
    expect(catalog.isOpenRouterStrictStructuredCandidate(model)).toBe(false);
  });

  it('paid, variable/unverified, and stale pricing are never candidates', async () => {
    const catalog = await prime([RAW_MODEL_ARCH('vendor/paid:free', PAID, ['text'])]);
    expect(catalog.isOpenRouterStrictStructuredCandidate(catalog.findOpenRouterCatalogModel('vendor/paid:free'))).toBe(false);

    await prime([
      RAW_MODEL_ARCH('vendor/variable:free', { prompt: '0', completion: '0', mystery: '0.1' }, ['text']),
    ]);
    expect(catalog.isOpenRouterStrictStructuredCandidate(catalog.findOpenRouterCatalogModel('vendor/variable:free'))).toBe(false);

    await prime([RAW_MODEL_ARCH('vendor/free:free', FREE, ['text'])]);
    expect(catalog.isOpenRouterStrictStructuredCandidate(catalog.findOpenRouterCatalogModel('vendor/free:free'))).toBe(true);
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: async () => {
        throw new Error('network down');
      },
    });
    expect(catalog.getOpenRouterCatalogSnapshot().pricingFresh).toBe(false);
    expect(catalog.isOpenRouterStrictStructuredCandidate(catalog.findOpenRouterCatalogModel('vendor/free:free'))).toBe(false);
  });
});
