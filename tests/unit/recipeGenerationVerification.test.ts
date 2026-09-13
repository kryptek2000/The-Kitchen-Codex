import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { APPLICATION_VALIDATED_JSON_PROFILE as JSON_MODE, STRICT_JSON_SCHEMA_PROFILE as STRICT } from '../../src/core/ai/openRouterProfile.js';

/**
 * v0.8.x — SEPARATE recipe-generation (`recipe_generation_v1`) capability.
 *
 * Proves the separate record, profile/instance/fingerprint/credential-generation
 * binding, the real recipe schema + sanitizer probe, bounded failures, no retry,
 * and that the trivial `{ok:true}` profile probe can NEVER grant recipe generation.
 */

const ID = 'dynamic/recipe:free';
const KEY = 'sk-or-v1-RECIPE_GENERATION_SENTINEL';
const VALID_RECIPE = JSON.stringify({
  title: 'Test Toast',
  ingredients: [{ name: 'bread' }, { name: 'butter' }],
  steps: [{ text: 'Toast the bread.' }, { text: 'Spread the butter.' }],
});

const raw = (price = '0', params = ['max_tokens', 'response_format', 'structured_outputs']) => ({
  id: ID,
  name: ID,
  context_length: 32000,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  pricing: { prompt: price, completion: price },
  supported_parameters: params,
});

const response = (content: string, finish_reason = 'stop') =>
  new Response(JSON.stringify({ choices: [{ finish_reason, message: { content } }] }));

/**
 * Deterministic streamed fixture that records whether the production bounded
 * reader cancelled it. Only the transport is mocked; the production reader still
 * performs the real overflow detection and calls `cancel()` itself.
 */
function chunkedProbeFixture(body: string): { response: any; wasCancelled: () => boolean; totalBytes: number } {
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
    response: { ok: true, status: 200, body: { getReader: () => reader } },
    wasCancelled: () => cancelled,
    totalBytes: bytes.byteLength,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('OPENROUTER_API_KEY', KEY);
  vi.stubEnv('KITCHEN_CODEX_TEXT_PROVIDER', '');
  vi.stubEnv('KITCHEN_CODEX_TEXT_MODEL', '');
  vi.stubEnv('HOST', '127.0.0.1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function setup(profile: typeof JSON_MODE | typeof STRICT = JSON_MODE) {
  const catalog = await import('../../server/ai/openRouterCatalog.js');
  catalog.resetOpenRouterCatalogForTests();
  await catalog.refreshOpenRouterCatalog({
    force: true,
    fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [raw()] }) }),
  });
  const store = await import('../../server/ai/capabilityVerificationStore.js');
  store.clearCapabilityVerificationsForTests();
  store.clearCredentialGenerationsForTests();
  const verification = await import('../../server/ai/capabilityVerification.js');
  const profileProbe = vi.fn(async () => response('{"ok":true}'));
  expect(
    await verification.verifyOpenRouterModelCapability({ modelId: ID, profile, fetchFn: profileProbe })
  ).toMatchObject({ ok: true, profile });
  return { catalog, store, verification, profileProbe };
}

describe('recipe-generation capability record', () => {
  it('is independent from the profile record and binds to instance/fingerprint/generation/TTL', async () => {
    const { catalog, store, verification } = await setup();
    const recipeProbe = vi.fn(async () => response(VALID_RECIPE));
    const result = await verification.verifyOpenRouterRecipeGenerationCapability({
      modelId: ID,
      fetchFn: recipeProbe,
    });
    expect(result).toMatchObject({ ok: true, capability: 'recipe_generation_v1', profile: JSON_MODE });
    expect(recipeProbe).toHaveBeenCalledTimes(1); // no retry

    const profileRecord = store.getCapabilityVerification('openrouter', ID)!;
    const recipeRecord = store.getRecipeGenerationVerification('openrouter', ID)!;
    expect(recipeRecord).toMatchObject({
      capability: 'recipe_generation_v1',
      providerId: 'openrouter',
      modelId: ID,
      profile: JSON_MODE,
      profileInstance: profileRecord.instance,
      credentialSource: 'server_environment',
      probeVersion: 'recipe_generation_v1',
    });
    expect(typeof recipeRecord.credentialGeneration).toBe('number');

    const fp = catalog.openRouterModelFingerprint(catalog.findOpenRouterCatalogModel(ID));
    expect(
      store.isRecipeGenerationVerified('openrouter', ID, fp, {
        profileInstance: profileRecord.instance,
        credentialGeneration: recipeRecord.credentialGeneration,
      })
    ).toBe(true);
    // Fingerprint mismatch invalidates.
    expect(store.isRecipeGenerationVerified('openrouter', ID, 'other-fp')).toBe(false);
    // Profile-instance mismatch invalidates.
    expect(
      store.isRecipeGenerationVerified('openrouter', ID, fp, {
        profileInstance: (profileRecord.instance ?? 0) + 1,
      })
    ).toBe(false);
    // TTL expiry.
    const expiredAt = Date.now() - store.RECIPE_GENERATION_TTL_MS;
    store.recordRecipeGenerationVerification({ ...recipeRecord, verifiedAt: expiredAt });
    expect(store.isRecipeGenerationVerified('openrouter', ID, fp)).toBe(false);
  });

  it('a NEW profile verification supersedes the recipe authorization', async () => {
    const { catalog, store, verification } = await setup();
    await verification.verifyOpenRouterRecipeGenerationCapability({
      modelId: ID,
      fetchFn: async () => response(VALID_RECIPE),
    });
    expect(catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(true);
    // Re-verify the profile (same model/profile) -> new instance.
    await verification.verifyOpenRouterModelCapability({
      modelId: ID,
      profile: JSON_MODE,
      fetchFn: async () => response('{"ok":true}'),
    });
    expect(store.getCapabilityVerification('openrouter', ID)!.instance).not.toBe(undefined);
    expect(catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(false);
  });

  it('saving a session key invalidates a recipe authorization bound to the prior credential generation', async () => {
    const { catalog, verification } = await setup();
    await verification.verifyOpenRouterRecipeGenerationCapability({
      modelId: ID,
      fetchFn: async () => response(VALID_RECIPE),
    });
    expect(catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(true);

    const secrets = await import('../../server/ai/sessionSecrets.js');
    secrets.setSessionSecret('openrouter', 'sk-or-v1-session');
    expect(catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(false);
    // Full save/replace/revoke/expiry + source-transition coverage lives in
    // tests/security/recipeGenerationCredentialLifecycle.test.ts.
  });

  it('clear/reset invalidates', async () => {
    const { catalog, store, verification } = await setup();
    await verification.verifyOpenRouterRecipeGenerationCapability({
      modelId: ID,
      fetchFn: async () => response(VALID_RECIPE),
    });
    expect(catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(true);
    store.clearCapabilityVerificationsForTests();
    expect(catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(false);
    expect(store.recipeGenerationVerificationCount()).toBe(0);
  });
});

describe('recipe-generation verification gate + probe', () => {
  it('REQUIRES a current structured-output profile first (zero provider calls)', async () => {
    const catalog = await import('../../server/ai/openRouterCatalog.js');
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [raw()] }) }),
    });
    const store = await import('../../server/ai/capabilityVerificationStore.js');
    store.clearCapabilityVerificationsForTests();
    const verification = await import('../../server/ai/capabilityVerification.js');
    const recipeProbe = vi.fn(async () => response(VALID_RECIPE));
    const result = await verification.verifyOpenRouterRecipeGenerationCapability({
      modelId: ID,
      fetchFn: recipeProbe,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'MODEL_PROFILE_NOT_VERIFIED',
      probeClassification: 'PROBE_PROFILE_REQUIRED',
      providerCalled: false,
    });
    expect(recipeProbe).not.toHaveBeenCalled();
  });

  it('uses the REAL recipe schema + sanitizer, and `{ok:true}` can never pass', async () => {
    const { verification } = await setup();
    const probe = vi.fn(async () => response('{"ok":true}'));
    const result = await verification.verifyOpenRouterRecipeGenerationCapability({ modelId: ID, fetchFn: probe });
    expect(result).toMatchObject({ ok: false, code: 'MODEL_CAPABILITY_UNVERIFIED', probeClassification: 'PROBE_RECIPE_INVALID' });
    expect(probe).toHaveBeenCalledTimes(1);

    // Request shape: real recipe schema, temperature 0, dedicated 4096-token
    // request budget (reasoning models can consume output budget on hidden
    // reasoning), require_parameters.
    const { buildRecipeGenerationProbeRequest } = verification;
    const body = buildRecipeGenerationProbeRequest(ID, JSON_MODE) as any;
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(4096);
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.response_format.type).toBe('json_object');
    expect(String(body.messages[0].content)).toContain('"title"');
    expect(String(body.messages[0].content)).toContain('"ingredients"');
    expect(String(body.messages[0].content)).toContain('"steps"');

    const strictBody = buildRecipeGenerationProbeRequest(ID, STRICT) as any;
    expect(strictBody.max_tokens).toBe(4096);
    expect(strictBody.response_format.type).toBe('json_schema');
    expect(strictBody.response_format.json_schema.strict).toBe(true);
    // OpenAI strict requires `required` to list EVERY property (all 13 keys).
    expect(strictBody.response_format.json_schema.schema.required).toEqual(
      expect.arrayContaining(['title', 'ingredients', 'steps'])
    );
    expect(strictBody.response_format.json_schema.schema.additionalProperties).toBe(false);
  });

  it('rejects missing/extra/invalid/empty/truncated/refusal/tool-only/oversized/malformed responses (no retry, not cached)', async () => {
    const { store, verification } = await setup();
    const cases: { name: string; res: any }[] = [
      { name: 'missing fields', res: response('{"title":"x"}') },
      { name: 'extra fields', res: response(JSON.stringify({ title: 'x', ingredients: [{ name: 'y' }], steps: [{ text: 'z' }], extra: 1 })) },
      { name: 'empty', res: response('') },
      { name: 'truncated', res: response(VALID_RECIPE, 'length') },
      { name: 'refusal', res: response(VALID_RECIPE, 'content_filter') },
      { name: 'tool-only', res: response(VALID_RECIPE, 'tool_calls') },
      { name: 'malformed', res: response('{not json') },
      { name: 'oversized', res: response('A'.repeat(20000)) },
    ];
    for (const c of cases) {
      const probe = vi.fn(async () => c.res);
      const result = await verification.verifyOpenRouterRecipeGenerationCapability({ modelId: ID, fetchFn: probe });
      expect(result.ok, c.name).toBe(false);
      expect(probe, c.name).toHaveBeenCalledTimes(1);
      expect(store.getRecipeGenerationVerification('openrouter', ID), c.name).toBeUndefined();
    }
  });

  it('a token-exhausted recipe probe returns the bounded truncation classification and is never cached', async () => {
    const { store, verification } = await setup();
    const probe = vi.fn(async () => response(VALID_RECIPE, 'length'));
    const result = await verification.verifyOpenRouterRecipeGenerationCapability({ modelId: ID, fetchFn: probe });
    expect(result).toMatchObject({
      ok: false,
      code: 'MODEL_CAPABILITY_UNVERIFIED',
      probeClassification: 'PROBE_OUTPUT_TRUNCATED',
      providerCalled: true,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(store.getRecipeGenerationVerification('openrouter', ID)).toBeUndefined();
  });

  it('a complete but oversized recipe probe response is still rejected by the 16 KiB ceiling and cancelled despite the 4096-token budget', async () => {
    const { store, verification } = await setup();
    const oversized = JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: VALID_RECIPE, reasoning: 'R'.repeat(20 * 1024) } }],
    });
    const fixture = chunkedProbeFixture(oversized);
    expect(fixture.totalBytes).toBeGreaterThan(verification.CAPABILITY_PROBE_MAX_RESPONSE_BYTES);
    const probe = vi.fn(async () => fixture.response);
    const result = await verification.verifyOpenRouterRecipeGenerationCapability({ modelId: ID, fetchFn: probe });
    expect(result).toMatchObject({
      ok: false,
      code: 'MODEL_CAPABILITY_UNVERIFIED',
      probeClassification: 'PROBE_OVERSIZED',
      providerCalled: true,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(fixture.wasCancelled()).toBe(true);
    expect(store.getRecipeGenerationVerification('openrouter', ID)).toBeUndefined();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain('RRRRR');
  });

  it('zero-cost gate failures make ZERO provider calls', async () => {
    const { catalog, store, verification } = await setup();
    const probe = vi.fn(async () => response(VALID_RECIPE));
    // Paid model.
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [raw('0.01')] }) }),
    });
    const paid = await verification.verifyOpenRouterRecipeGenerationCapability({ modelId: ID, fetchFn: probe });
    expect(paid.ok).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    void store;
  });

  it('an in-flight profile change prevents recording', async () => {
    const { store, verification } = await setup();
    const probe = vi.fn(async () => {
      // Re-verify the profile (new instance) mid-probe.
      await verification.verifyOpenRouterModelCapability({
        modelId: ID,
        profile: JSON_MODE,
        fetchFn: async () => response('{"ok":true}'),
      });
      return response(VALID_RECIPE);
    });
    const result = await verification.verifyOpenRouterRecipeGenerationCapability({ modelId: ID, fetchFn: probe });
    expect(result.ok).toBe(false);
    expect(store.getRecipeGenerationVerification('openrouter', ID)).toBeUndefined();
  });

  it('never leaks raw provider output or the credential sentinel', async () => {
    const { verification } = await setup();
    const leak = `RAW_PROVIDER_${KEY}`;
    const result = await verification.verifyOpenRouterRecipeGenerationCapability({
      modelId: ID,
      fetchFn: async () => response(leak),
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(leak);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe('recipe-generation capability truth', () => {
  it('openRouterDynamicCapabilities.recipeGeneration is false until the recipe probe succeeds', async () => {
    const { catalog, verification } = await setup();
    expect(catalog.openRouterDynamicCapabilities(ID)).toMatchObject({ recipeGeneration: false });
    await verification.verifyOpenRouterRecipeGenerationCapability({
      modelId: ID,
      fetchFn: async () => response(VALID_RECIPE),
    });
    expect(catalog.openRouterDynamicCapabilities(ID)).toMatchObject({ recipeGeneration: true });
    expect(catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(true);
  });
});
