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
    expect(body.max_tokens).toBeLessThanOrEqual(32);
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
    expect(validateCapabilityProbeContent('{"ok":false}')).toMatchObject({ ok: false, reason: 'schema_mismatch' });
    expect(validateCapabilityProbeContent('{"ok":true,"extra":1}')).toMatchObject({
      ok: false,
      reason: 'schema_mismatch',
    });
    expect(validateCapabilityProbeContent('[{"ok":true}]')).toMatchObject({ ok: false, reason: 'schema_mismatch' });
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
