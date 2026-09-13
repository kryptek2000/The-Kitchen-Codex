import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPLICATION_VALIDATED_JSON_PROFILE as JSON_MODE } from '../../src/core/ai/openRouterProfile.js';

/**
 * Flag 1 — mutation-sensitive terminal fallback coverage.
 *
 * The production fallback runner (`runWithAiFallback`) must honor a TRUSTED
 * `terminalOnFailure` candidate and must NEVER advance to a later
 * otherwise-executable curated/other-provider candidate after that candidate
 * fails — for EVERY normalized failure class that could otherwise retry/fall
 * back.
 *
 * The first candidate is resolved through the REAL production selection path
 * (`resolveExecutableTextCandidates` -> `withDynamicSingleAttempt`), so the
 * `singleAttempt`/`terminalOnFailure` flags are set from trusted server state for
 * a verified-dynamic OpenRouter recipe model. The runner under test is the REAL
 * `runWithAiFallback`; its terminal logic is never duplicated here.
 */

const ID = 'dynamic/recipe:free';
const CURATED = 'openai/gpt-4o-mini';
const KEY = 'sk-or-v1-TERMINAL_FALLBACK_SENTINEL';
const VALID_RECIPE = JSON.stringify({
  title: 'Test Toast',
  ingredients: [{ name: 'bread' }, { name: 'butter' }],
  steps: [{ text: 'Toast the bread.' }, { text: 'Spread the butter.' }],
});

const rawModel = (id: string, price = '0') => ({
  id,
  name: id,
  context_length: 128000,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  pricing: { prompt: price, completion: price },
  supported_parameters: ['temperature', 'max_tokens', 'response_format', 'structured_outputs'],
});

const completion = (content: string, finish_reason = 'stop') =>
  new Response(JSON.stringify({ choices: [{ finish_reason, message: { content } }] }), { status: 200 });

const selectionHeader = (payload: Record<string, unknown>) => ({
  'x-kitchen-ai-text-selection': JSON.stringify(payload),
});

async function freshModules() {
  vi.resetModules();
  vi.stubEnv('OPENROUTER_API_KEY', KEY);
  vi.stubEnv('KITCHEN_CODEX_TEXT_PROVIDER', '');
  vi.stubEnv('KITCHEN_CODEX_TEXT_MODEL', '');
  vi.stubEnv('HOST', '127.0.0.1');
  const catalog = await import('../../server/ai/openRouterCatalog.js');
  const store = await import('../../server/ai/capabilityVerificationStore.js');
  const verification = await import('../../server/ai/capabilityVerification.js');
  const parse = await import('../../server/ai/parseSelectionMetadata.js');
  const effective = await import('../../server/ai/effectiveSelection.js');
  const provider = await import('../../server/ai/provider.js');
  const errors = await import('../../server/ai/providerErrors.js');
  return { catalog, store, verification, parse, effective, provider, errors };
}

async function primeCatalog(catalog: Awaited<ReturnType<typeof freshModules>>['catalog'], models: unknown[]) {
  catalog.resetOpenRouterCatalogForTests();
  await catalog.refreshOpenRouterCatalog({
    force: true,
    fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: models }) }),
  });
}

/**
 * Resolves the REAL production candidates for the required multi-candidate
 * sequence: a verified-dynamic OpenRouter recipe candidate FIRST and an
 * otherwise-executable curated OpenRouter candidate SECOND.
 */
async function resolveDynamicThenCurated() {
  const m = await freshModules();
  await primeCatalog(m.catalog, [rawModel(ID), rawModel(CURATED, '0.001')]);
  m.store.clearCapabilityVerificationsForTests();
  m.store.clearCredentialGenerationsForTests();

  expect(
    await m.verification.verifyOpenRouterModelCapability({
      modelId: ID,
      profile: JSON_MODE,
      fetchFn: async () => completion('{"ok":true}'),
    })
  ).toMatchObject({ ok: true });
  expect(
    await m.verification.verifyOpenRouterRecipeGenerationCapability({
      modelId: ID,
      fetchFn: async () => completion(VALID_RECIPE),
    })
  ).toMatchObject({ ok: true, capability: 'recipe_generation_v1' });
  expect(m.catalog.isOpenRouterRecipeGenerationAuthorized(ID)).toBe(true);

  const dynamicIntent = m.parse.parseTextSelectionHeader(
    selectionHeader({
      mode: 'user_selected',
      providerId: 'openrouter',
      modelId: ID,
      credentialSource: 'server_environment',
      selectedCostClass: 'free',
    })
  );
  const dynamicCandidates = m.effective.resolveExecutableTextCandidates('createRecipe', undefined, dynamicIntent);
  expect(dynamicCandidates).toHaveLength(1);
  const dynamic = dynamicCandidates[0];
  expect(dynamic.model).toBe(ID);

  const curatedIntent = m.parse.parseTextSelectionHeader(
    selectionHeader({
      mode: 'user_selected',
      providerId: 'openrouter',
      modelId: CURATED,
      credentialSource: 'server_environment',
      selectedCostClass: 'budget',
    })
  );
  const curatedCandidates = m.effective.resolveExecutableTextCandidates('createRecipe', undefined, curatedIntent);
  expect(curatedCandidates).toHaveLength(1);
  const curated = curatedCandidates[0];
  expect(curated.model).toBe(CURATED);

  return { m, dynamic, curated };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('Flag 1 — terminal verified-dynamic candidate is terminal for every failure class', () => {
  it('production resolution marks the verified-dynamic recipe candidate terminal+singleAttempt', async () => {
    const { dynamic, curated } = await resolveDynamicThenCurated();
    expect(dynamic.terminalOnFailure).toBe(true);
    expect(dynamic.singleAttempt).toBe(true);
    // The later curated candidate preserves its baseline (non-terminal) policy.
    expect(curated.terminalOnFailure).toBeUndefined();
    expect(curated.singleAttempt).toBeUndefined();
  });

  const failureClasses: Array<{
    name: string;
    expectedCode: string;
    make: (errors: Awaited<ReturnType<typeof freshModules>>['errors']) => unknown;
  }> = [
    { name: 'INVALID_RESPONSE', expectedCode: 'INVALID_RESPONSE', make: (e) => new e.ProviderOperationError('INVALID_RESPONSE', 'invalid draft', { providerId: 'openrouter', model: ID }) },
    { name: 'TIMEOUT', expectedCode: 'TIMEOUT', make: (e) => new e.ProviderOperationError('TIMEOUT', 'timed out', { providerId: 'openrouter', model: ID }) },
    { name: 'RATE_LIMIT', expectedCode: 'RATE_LIMIT', make: (e) => new e.ProviderOperationError('RATE_LIMIT', 'rate limited', { providerId: 'openrouter', model: ID }) },
    { name: 'UNAVAILABLE', expectedCode: 'UNAVAILABLE', make: (e) => new e.ProviderOperationError('UNAVAILABLE', 'unavailable', { providerId: 'openrouter', model: ID }) },
    { name: 'AUTH', expectedCode: 'AUTH', make: (e) => new e.ProviderOperationError('AUTH', 'unauthorized', { providerId: 'openrouter', model: ID }) },
    { name: 'QUOTA', expectedCode: 'QUOTA', make: (e) => new e.ProviderOperationError('QUOTA', 'quota exhausted', { providerId: 'openrouter', model: ID }) },
    { name: 'PROVIDER_ERROR', expectedCode: 'PROVIDER_ERROR', make: (e) => new e.ProviderOperationError('PROVIDER_ERROR', 'provider blew up', { providerId: 'openrouter', model: ID }) },
    { name: 'BLOCKED', expectedCode: 'BLOCKED', make: (e) => new e.ProviderOperationError('BLOCKED', 'safety blocked', { providerId: 'openrouter', model: ID }) },
    { name: 'unknown raw transport error -> PROVIDER_ERROR', expectedCode: 'PROVIDER_ERROR', make: () => new Error('socket hang up') },
  ];

  it.each(failureClasses)('$name terminates before the later curated candidate (one dynamic call, zero later calls)', async ({ expectedCode, make }) => {
    const { m, dynamic, curated } = await resolveDynamicThenCurated();
    const calls: string[] = [];
    let sleeps = 0;
    const failure = make(m.errors);
    const run = async (candidate: { model: string }) => {
      calls.push(candidate.model);
      if (candidate.model === ID) throw failure;
      return `second:${candidate.model}`;
    };

    await expect(
      m.provider.runWithAiFallback({
        candidates: [dynamic, curated],
        requiredCapabilities: ['structuredOutput', 'recipeGeneration'],
        registry: m.provider.getRegisteredProviders(),
        allowAuthFallback: true,
        retry: {
          maxAttemptsPerCandidate: 3,
          backoffMs: 600,
          retryableCodes: ['RATE_LIMIT', 'UNAVAILABLE', 'TIMEOUT', 'INVALID_RESPONSE', 'QUOTA', 'PROVIDER_ERROR'],
          sleep: async () => {
            sleeps += 1;
          },
        },
        run: run as never,
      })
    ).rejects.toMatchObject({ code: expectedCode });

    expect(calls).toEqual([ID]);
    expect(sleeps).toBe(0);
  });

  it('a verified-dynamic candidate is attempted exactly once even under an opt-in same-model retry policy', async () => {
    const { m, dynamic, curated } = await resolveDynamicThenCurated();
    const calls: string[] = [];
    let sleeps = 0;
    const run = async (candidate: { model: string }) => {
      calls.push(candidate.model);
      throw new m.errors.ProviderOperationError('RATE_LIMIT', 'rate limited', {
        providerId: 'openrouter',
        model: candidate.model,
      });
    };

    await expect(
      m.provider.runWithAiFallback({
        candidates: [dynamic, curated],
        requiredCapabilities: ['structuredOutput', 'recipeGeneration'],
        registry: m.provider.getRegisteredProviders(),
        retry: {
          maxAttemptsPerCandidate: 3,
          backoffMs: 600,
          retryableCodes: ['RATE_LIMIT', 'UNAVAILABLE', 'TIMEOUT', 'INVALID_RESPONSE', 'QUOTA', 'PROVIDER_ERROR'],
          sleep: async () => {
            sleeps += 1;
          },
        },
        run: run as never,
      })
    ).rejects.toMatchObject({ code: 'RATE_LIMIT' });

    expect(calls).toEqual([ID]);
    expect(sleeps).toBe(0);
  });
});

describe('Flag 1 — control: without terminal authority the runner advances per policy', () => {
  it('a non-terminal verified-dynamic candidate falls back to the later curated candidate', async () => {
    const { m, dynamic, curated } = await resolveDynamicThenCurated();
    const first = { ...dynamic, terminalOnFailure: false, singleAttempt: false };
    const calls: string[] = [];
    const run = async (candidate: { model: string }) => {
      calls.push(candidate.model);
      if (candidate.model === ID) {
        throw new m.errors.ProviderOperationError('RATE_LIMIT', 'rate limited', {
          providerId: 'openrouter',
          model: ID,
        });
      }
      return `second:${candidate.model}`;
    };

    const result = await m.provider.runWithAiFallback({
      candidates: [first, curated],
      requiredCapabilities: ['structuredOutput', 'recipeGeneration'],
      registry: m.provider.getRegisteredProviders(),
      run: run as never,
    });

    expect(calls).toEqual([ID, CURATED]);
    expect(result.model).toBe(CURATED);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['RATE_LIMIT']);
  });

  it('a curated candidate preserves its baseline same-model retry behavior', async () => {
    const { m, curated } = await resolveDynamicThenCurated();
    const calls: string[] = [];
    let sleeps = 0;
    const run = async (candidate: { model: string }) => {
      calls.push(candidate.model);
      if (calls.length === 1) {
        throw new m.errors.ProviderOperationError('RATE_LIMIT', 'rate limited', {
          providerId: 'openrouter',
          model: candidate.model,
        });
      }
      return `ok:${candidate.model}`;
    };

    const result = await m.provider.runWithAiFallback({
      candidates: [curated],
      requiredCapabilities: ['structuredOutput', 'recipeGeneration'],
      registry: m.provider.getRegisteredProviders(),
      retry: {
        maxAttemptsPerCandidate: 2,
        backoffMs: 600,
        retryableCodes: ['RATE_LIMIT'],
        sleep: async () => {
          sleeps += 1;
        },
      },
      run: run as never,
    });

    expect(calls).toEqual([CURATED, CURATED]);
    expect(sleeps).toBe(1);
    expect(result.model).toBe(CURATED);
  });
});

describe('Flag 1 — terminal/verified-dynamic classification cannot be forged from client input', () => {
  it('client selection fields, model ids, cost claims and profile hints cannot create or mark a terminal candidate', async () => {
    const m = await freshModules();
    await primeCatalog(m.catalog, [rawModel(ID), rawModel(CURATED, '0.001')]);
    m.store.clearCapabilityVerificationsForTests();
    m.store.clearCredentialGenerationsForTests();

    // The dynamic model has NO server-side verification record. A client cannot
    // forge one (or its terminal classification) through the selection header.
    const forgedDynamic = m.parse.parseTextSelectionHeader(
      selectionHeader({
        mode: 'user_selected',
        providerId: 'openrouter',
        modelId: ID,
        credentialSource: 'server_environment',
        selectedCostClass: 'free',
        terminalOnFailure: true,
        singleAttempt: true,
        capabilityVerified: true,
        verifiedDynamic: true,
        profile: 'strict_json_schema_v1',
      })
    );
    expect(m.effective.resolveExecutableTextCandidates('createRecipe', undefined, forgedDynamic)).toEqual([]);

    // A curated model resolves, but forged terminal claims never appear on it.
    const forgedCurated = m.parse.parseTextSelectionHeader(
      selectionHeader({
        mode: 'user_selected',
        providerId: 'openrouter',
        modelId: CURATED,
        credentialSource: 'server_environment',
        selectedCostClass: 'budget',
        terminalOnFailure: true,
        singleAttempt: true,
        capabilityVerified: true,
        verifiedDynamic: true,
        profile: 'strict_json_schema_v1',
      })
    );
    const candidates = m.effective.resolveExecutableTextCandidates('createRecipe', undefined, forgedCurated);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].terminalOnFailure).toBeUndefined();
    expect(candidates[0].singleAttempt).toBeUndefined();
  });
});
