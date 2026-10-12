/**
 * The Kitchen Codex — Phase 9B-3A.
 * AUTHENTICATED SEMANTIC CONSUMPTION — offline, no provider calls.
 *
 * WHY THIS SUITE EXISTS. Phase 9B-P5B produced the first real signed whole-recipe
 * semantic response, but nothing could CHECK its MAC: the signing key is
 * process-local by design and no verification route exists. Until that boundary
 * exists, any client can POST an object that looks like a canonical signed
 * result. 9B-3A adds the consumer that closes it.
 *
 * SCOPE LIMITATION, STATED UP FRONT: these tests prove the verification
 * MECHANISM is genuinely cryptographic using a receipt issued IN THIS PROCESS.
 * They CANNOT and DO NOT retroactively authenticate the historical P5B live
 * receipt, whose process-scoped key died with that process. Nothing here should
 * be read as validating that earlier artifact.
 *
 * Mocked providers only. NO live provider is contacted. NO real key is used.
 * NO HTTP route is added, and NO persistence occurs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import type { AiCandidate, RegisteredProvider } from '../../server/ai/providerRegistry';
import type {
  AiCapabilities,
  AiJsonSchema,
  AiProvider,
  AiStructuredOptions,
} from '../../src/core/ai/types';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import {
  createWholeRecipeSemanticOriginAuthority,
  type WholeRecipeSemanticOriginAuthority,
} from '../../server/wholeRecipeSemanticOriginReceipt';
import { getProcessSemanticOriginAuthority } from '../../server/wholeRecipeSemanticAuthority';

// ---------------------------------------------------------------------------
// PROVIDER MOCK
// ---------------------------------------------------------------------------

const prov = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../../server/ai/providerRegistry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../server/ai/providerRegistry.js');
  return { ...actual, getRegisteredProviders: () => [] };
});

function mockProvider(): AiProvider {
  return {
    id: 'gemini',
    name: 'gemini',
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false },
    isAvailable: () => true,
    testConnection: async () => true,
    generate: async () => '',
    generateStructured: async (_p: string, _s: AiJsonSchema, options?: AiStructuredOptions) => {
      prov.calls += 1;
      const model = options?.model ?? '';
      const good = {
        contract_version: 'nutrition_ai_advanced_interpretation_v1',
        line_ref: 'ing:0:20e4077fc89a',
        semantic_food: {
          normalized_name: 'whole egg',
          modifiers: [],
          preparation: ['separated'],
          state: ['raw'],
          qualifiers: [],
        },
        search_phrases: ['whole egg'],
        amount_semantics: { kind: 'exact', echoed_value: 4, phrasing: '4' },
        unit_semantics: { family: 'count', raw: 'eggs', interpreted_unit: 'count' },
        count_semantics: { noun: 'eggs', size: 'large' },
        alternatives: [],
        ambiguity: { ambiguous: false, reasons: [] },
      };
      return {
        contract_version: 'nutrition_ai_advanced_interpretation_v1',
        interpretations: [
          model.includes('lite')
            ? { ...good, line_ref: 'ing:0:20e4077fc89a' }
            : { ...good, line_ref: 'ing:0:20e4077fc89a', search_phrases: ['whole egg'] },
        ],
      } as never;
    },
  };
}

// ---------------------------------------------------------------------------
// FIXTURE (real released adapter)
// ---------------------------------------------------------------------------

const RECIPE = {
  ingredients: [
    { name: '4 eggs, separated' },
    { name: '1 cup whole milk' },
    { name: '2 cups all-purpose flour' },
    { name: '6 tbsp unsalted butter' },
    { name: '1 tsp sea salt' },
  ],
};
const INSTRUCTIONS = [
  { text: 'Separate the whites from the yolks.' },
  { text: 'Beat the whites until stiff peaks.' },
  { text: 'Fold the whites back into the yolks.' },
];

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const adapted = adaptRecipe(RECIPE);
  if (adapted.ok !== true) throw new Error('fixture did not adapt');
  return {
    request_version: 'nutrition_ai_whole_recipe_interpretation_request_v1',
    request_id: '9b3a-egg',
    recipe: RECIPE,
    instructions: INSTRUCTIONS,
    targets: [{ line_ref: adapted.recipe.adapted[0].line_ref }],
    ...overrides,
  };
}

/** Runs the REAL operation against the mock provider and returns its issued result. */
async function issue(): Promise<Record<string, unknown>> {
  const { interpretWholeRecipeSemantics } = await import('../../server/wholeRecipeSemanticInterpret.js');
  const provider = mockProvider();
  const candidates: AiCandidate[] = [{ provider, model: 'gemini-3.1-flash-lite' }];
  const registry: RegisteredProvider[] = [
    { provider, defaultCapabilities: { ...provider.capabilities } as AiCapabilities },
  ];
  const result = await interpretWholeRecipeSemantics(request(), { candidates, registry });
  if (result.ok !== true) throw new Error(`operation failed: ${result.code}`);
  // Exactly the fields a real client would echo back.
  return {
    request_id: result.request_id,
    context_binding: result.context_binding,
    semantic_response: result.semantic_response,
    provider_id: result.provider_id,
    model_id: result.model_id,
    operation_id: result.operation_id,
    origin_receipt: result.origin_receipt,
  };
}

async function consume(
  envelope: unknown,
  req: unknown = request(),
  authority?: WholeRecipeSemanticOriginAuthority
) {
  const { consumeAuthenticatedWholeRecipeSemantics } = await import(
    '../../server/wholeRecipeSemanticConsumption.js'
  );
  return consumeAuthenticatedWholeRecipeSemantics(req, envelope, authority);
}

beforeEach(() => {
  prov.calls = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 4. IN-PROCESS CRYPTOGRAPHIC RECEIPT VERIFICATION
// ---------------------------------------------------------------------------

describe('9B-3A — genuine same-process cryptographic verification', () => {
  it('issues a real receipt and verifies it with the SAME process authority', async () => {
    const envelope = await issue();
    const r = await consume(envelope);
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.authority).toBe('advisory_semantic_observations');
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0].line_ref).toBe('ing:0:20e4077fc89a');
    expect(r.operation_id).toBe(envelope.operation_id);
    expect(r.provider_id).toBe('gemini');
    expect(r.model_id).toBe('gemini-3.1-flash-lite');
  });

  it('the process authority is the SAME instance that issued the proof', () => {
    expect(getProcessSemanticOriginAuthority()).toBe(getProcessSemanticOriginAuthority());
  });

  it('a SEPARATE authority cannot verify a receipt issued by another', async () => {
    const envelope = await issue();
    // Same process, DIFFERENT authority instance -> different key.
    const foreign = createWholeRecipeSemanticOriginAuthority();
    const r = await consume(envelope, request(), foreign);
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('unauthenticated');
    // The real authority still accepts it: the refusal is key-specific, not a
    // broken comparison.
    expect((await consume(envelope)).ok).toBe(true);
  });

  it('changed SEMANTIC content invalidates verification', async () => {
    const envelope = await issue();
    const rows = JSON.parse(JSON.stringify(envelope.semantic_response)) as Array<Record<string, unknown>>;
    rows[0].normalized_name = 'yolk';
    const r = await consume({ ...envelope, semantic_response: [{ ...rows[0], semantic_food: { normalized_name: 'yolk', modifiers: [], preparation: [], state: [], qualifiers: [] } }] });
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('unauthenticated');
  });

  it('changed TARGET identity invalidates verification', async () => {
    const envelope = await issue();
    const rows = JSON.parse(JSON.stringify(envelope.semantic_response)) as Array<Record<string, unknown>>;
    const r = await consume({ ...envelope, semantic_response: [{ ...rows[0], line_ref: 'ing:1:41a9f1726c1b' }] });
    // Either the target-set gate or the MAC refuses it; both are fail-closed.
    expect(r.ok).toBe(false);
  });

  it('changed PROVIDER identity invalidates verification', async () => {
    const envelope = await issue();
    const r = await consume({ ...envelope, provider_id: 'attacker' });
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('unauthenticated');
  });

  it('changed MODEL identity invalidates verification', async () => {
    const envelope = await issue();
    const r = await consume({ ...envelope, model_id: 'gemini-3.7-flash' });
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('unauthenticated');
  });

  it('changed OPERATION identity invalidates verification (replay)', async () => {
    const envelope = await issue();
    const other = await issue();
    expect(other.operation_id).not.toBe(envelope.operation_id);
    // A different real operation id paired with the first result's material.
    const r = await consume({ ...envelope, operation_id: other.operation_id });
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('unauthenticated');
  });

  it('changed CONTEXT BINDING invalidates verification', async () => {
    const envelope = await issue();
    const r = await consume({ ...envelope, context_binding: `sha256:${'0'.repeat(64)}` });
    // A forged binding is refused as STALE before any MAC work.
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('stale_context');
  });

  it('STALE recipe context fails closed', async () => {
    const envelope = await issue();
    // Same targets (so the request still materializes), DIFFERENT instructions:
    // the server's own re-derivation therefore produces a different binding, and
    // the submitted one is refused as stale BEFORE any MAC work.
    const stale = request({
      instructions: [{ text: 'Whisk everything together and bake.' }],
    });
    const r = await consume(envelope, stale);
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('stale_context');
  });

  it('a recipe whose targets no longer resolve fails closed as invalid_request', async () => {
    const envelope = await issue();
    // Ingredient text changed, so the requested line_ref no longer derives.
    const r = await consume(
      envelope,
      request({ recipe: { ingredients: [{ name: '6 eggs, separated' }] } })
    );
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('invalid_request');
  });

  it('MALFORMED receipts fail closed', async () => {
    const envelope = await issue();
    for (const bad of [
      '',
      'wsem1.',
      'wsem1.short',
      `wsem1.${'A'.repeat(100)}`,
      `${'A'.repeat(49)}`,
      'rctx1.' + 'A'.repeat(43),
      null,
      12345,
      { receipt: 'wsem1.' + 'A'.repeat(43) },
      ['wsem1.' + 'A'.repeat(43)],
    ]) {
      const r = await consume({ ...envelope, origin_receipt: bad });
      expect(r.ok, `receipt ${String(bad).slice(0, 24)}`).toBe(false);
    }
  });

  it('a FORGED receipt with a valid shape fails closed', async () => {
    const envelope = await issue();
    const forged = `wsem1.${'A'.repeat(43)}`;
    const r = await consume({ ...envelope, origin_receipt: forged });
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('unauthenticated');
  });

  it('a MISSING receipt fails closed', async () => {
    const envelope = await issue();
    const { origin_receipt: _dropped, ...rest } = envelope as Record<string, unknown>;
    const r = await consume(rest);
    expect(r.ok).toBe(false);
  });

  it('the signing key never leaves the server authority object', async () => {
    const authority = createWholeRecipeSemanticOriginAuthority();
    // No accessor, property or method exposes key material.
    const surface = [
      ...Object.keys(authority),
      ...Object.getOwnPropertyNames(authority),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(authority)),
    ];
    for (const key of surface) {
      expect(key.toLowerCase()).not.toMatch(/secret|key|mac|material/);
    }
    expect(JSON.stringify(authority)).not.toMatch(/[0-9a-f]{32,}/i);
    expect(String(authority)).not.toMatch(/[0-9a-f]{32,}/i);
  });

  it('verification makes NO provider calls', async () => {
    const envelope = await issue();
    const before = prov.calls;
    await consume(envelope);
    expect(prov.calls).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 8. ADVERSARIAL ENVELOPE / TARGET SHAPES
// ---------------------------------------------------------------------------

describe('9B-3A — adversarial envelopes fail closed', () => {
  it('UNAUTHENTICATED semantic input (client-authored, never issued) fails closed', async () => {
    const r = await consume({
      request_id: '9b3a-egg',
      context_binding: 'sha256:' + '0'.repeat(64),
      semantic_response: [
        {
          contract_version: 'nutrition_ai_advanced_interpretation_v1',
          line_ref: 'ing:0:20e4077fc89a',
          semantic_food: { normalized_name: 'whole egg' },
          search_phrases: ['whole egg'],
          amount_semantics: { kind: 'exact' },
          unit_semantics: { family: 'count' },
          count_semantics: {},
          alternatives: [],
          ambiguity: { ambiguous: false, reasons: [] },
        },
      ],
      provider_id: 'gemini',
      model_id: 'gemini-3.1-flash-lite',
      operation_id: 'wsemo1.' + 'A'.repeat(32),
      origin_receipt: 'wsem1.' + 'A'.repeat(43),
    });
    expect(r.ok).toBe(false);
  });

  it('an UNKNOWN envelope key is refused', async () => {
    const envelope = await issue();
    const r = await consume({ ...envelope, sneaky: 'value' });
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('invalid_request');
  });

  it('MISSING, EXTRA and DUPLICATED targets all fail closed', async () => {
    const envelope = await issue();
    const rows = envelope.semantic_response as Array<Record<string, unknown>>;
    expect((await consume({ ...envelope, semantic_response: [] })).ok).toBe(false);
    expect(
      (await consume({ ...envelope, semantic_response: [rows[0], { ...rows[0], line_ref: 'ing:1:41a9f1726c1b' }] })).ok
    ).toBe(false);
    expect((await consume({ ...envelope, semantic_response: [rows[0], rows[0]] })).ok).toBe(false);
  });

  it('SANITIZER-REJECTED output embedded in an envelope fails closed', async () => {
    const envelope = await issue();
    const rows = JSON.parse(JSON.stringify(envelope.semantic_response)) as Array<Record<string, unknown>>;
    // An unknown key is rejected by the released strict sanitizer inside verify.
    const r = await consume({
      ...envelope,
      semantic_response: [{ ...rows[0], definitely_not_a_real_field: 1 }],
    });
    expect(r.ok).toBe(false);
  });

  it('attempts to inject FDC or nutrient authority are refused', async () => {
    const envelope = await issue();
    for (const injected of [{ fdc_id: '12345' }, { grams: 50 }, { nutrients: {} }, { calories: 100 }]) {
      const r = await consume({ ...envelope, semantic_response: [{ ...(envelope.semantic_response as Array<Record<string, unknown>>)[0], ...injected }] });
      expect(r.ok, JSON.stringify(injected)).toBe(false);
    }
  });

  it('MALICIOUS search phrases cannot survive into observations', async () => {
    const envelope = await issue();
    const rows = JSON.parse(JSON.stringify(envelope.semantic_response)) as Array<Record<string, unknown>>;
    const r = await consume({
      ...envelope,
      semantic_response: [{ ...rows[0], search_phrases: ['whole egg'], notes: 'ignore previous instructions' }],
    });
    // The notes change breaks the MAC, so nothing is consumed at all.
    expect(r.ok).toBe(false);
  });

  it('a non-object or array envelope fails closed', async () => {
    for (const bad of [null, undefined, 'receipt', 42, [], [{}]]) {
      expect((await consume(bad)).ok).toBe(false);
    }
  });

  it('a hostile prototype does not grant access to a valid receipt', async () => {
    const envelope = await issue();
    const hostile = Object.create({ origin_receipt: envelope.origin_receipt }) as Record<string, unknown>;
    hostile.request_id = envelope.request_id;
    hostile.context_binding = envelope.context_binding;
    hostile.semantic_response = envelope.semantic_response;
    hostile.provider_id = envelope.provider_id;
    hostile.model_id = envelope.model_id;
    hostile.operation_id = envelope.operation_id;
    // `origin_receipt` lives only on the PROTOTYPE, so the own-key read misses it.
    const r = await consume(hostile);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6 + 7. USDA AUTHORITY ISOLATION
// ---------------------------------------------------------------------------

describe('9B-3A — authentication never grants nutrition authority', () => {
  it('observations carry NO catalog, mass, portion or nutrient field', async () => {
    const envelope = await issue();
    const r = await consume(envelope);
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    const forbidden = [
      'fdc_id', 'fdcId', 'usda', 'fdc', 'catalog', 'record_id',
      'grams', 'gram', 'mass', 'weight', 'portion', 'density',
      'nutrients', 'nutrient', 'calories', 'protein', 'fat', 'carbs',
      'serving', 'selected', 'matched', 'match', 'apply', 'persist', 'score',
    ];
    const text = JSON.stringify(r);
    for (const key of forbidden) {
      expect(new RegExp(`"${key}"`, 'i').test(text), `leaked authority key ${key}`).toBe(false);
    }
  });

  it('the result is explicitly labelled ADVISORY and carries no selection concept', async () => {
    const envelope = await issue();
    const r = await consume(envelope);
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.authority).toBe('advisory_semantic_observations');
    expect(Object.keys(r).sort()).toEqual([
      'authority', 'context_binding', 'model_id', 'observations', 'ok',
      'operation_id', 'provider_id', 'request_id',
    ]);
  });

  it('confidence is carried as advisory data only, never as a threshold', async () => {
    const envelope = await issue();
    const r = await consume(envelope);
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    const obs = r.observations[0] as unknown as Record<string, unknown>;
    // No threshold/auto-accept semantics are attached to it.
    for (const key of Object.keys(obs)) {
      expect(key.toLowerCase()).not.toMatch(/threshold|automatic|autoconfirm|accept|selected/);
    }
  });

  it('a FAILING verification produces ZERO observations', async () => {
    const envelope = await issue();
    const r = await consume({ ...envelope, model_id: 'forged' });
    expect(r.ok).toBe(false);
    expect((r as { observations?: unknown }).observations).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual(['code', 'ok', 'verified']);
  });

  it('verification performs NO persistence and NO logging of its own', async () => {
    const envelope = await issue();
    // The spy is installed AFTER issuance, so only the CONSUMPTION path is
    // observed. Consumption must be silent: it writes nothing anywhere.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await consume(envelope);
    expect(r.ok).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// STRUCTURAL PINS — discipline that is near-equivalent but not behaviourally testable
// ---------------------------------------------------------------------------

describe('9B-3A — structural pins for non-behaviourally-testable discipline', () => {
  const SOURCE = readFileSync(
    new URL('../../server/wholeRecipeSemanticConsumption.ts', import.meta.url),
    'utf8'
  );

  it('consumes the VERIFIED canonical origin, never the client object', () => {
    // MUTATION-SENSITIVE, STRUCTURAL ONLY. Substituting the submitted envelope
    // for `verified.origin` leaves all 29 tests green, because a successful MAC
    // match MEANS the canonical origin is semantically identical to what was
    // submitted. It is pinned anyway: `verified.origin` is the authority's own
    // canonical re-read, and it is the only value that is guaranteed never to be
    // caller-shaped.
    expect(SOURCE).toContain('const origin = verified.origin;');
    expect(SOURCE).not.toContain('const origin = { ...issuedEnvelope');
    expect(SOURCE).not.toMatch(/const origin\s*=\s*issuedEnvelope/);
  });

  it('reads the property VALUE from the descriptor, never via a property read', () => {
    // MUTATION-SENSITIVE, STRUCTURAL ONLY. The own-property and accessor gates
    // already refuse inherited values and getters, so for an OWN DATA property
    // `descriptor.value` and `target[key]` agree and no behavioural test can
    // separate them. `descriptor.value` is the stricter read: it cannot be
    // subverted by a Proxy that reports a data descriptor while returning a
    // different value from `get`.
    expect(SOURCE).toContain('return descriptor.value;');
    expect(SOURCE).not.toMatch(/return \(target as Record<string, unknown>\)\[key\]/);
  });

  it('keeps the trusted one-way authority seam explicit', () => {
    expect(SOURCE).toContain('getProcessSemanticOriginAuthority()');
    // The injectable authority is ONLY for proving a foreign authority cannot
    // verify; production always resolves the process-scoped instance.
    expect(SOURCE).toContain('authority: WholeRecipeSemanticOriginAuthority = getProcessSemanticOriginAuthority()');
  });

  it('introduces NO HTTP route and NO new signing authority', () => {
    // The consumption boundary must not widen the public surface in this phase.
    expect(SOURCE).not.toMatch(/express|app\.(get|post|put|delete)|Router/);
    expect(SOURCE).not.toContain('createWholeRecipeSemanticOriginAuthority');
    // No crypto import or call: the MAC belongs to the released authority alone.
    // Checked against CODE only, so prose like "cryptographic" cannot trip it.
    const code = SOURCE.split('\n').filter((l) => !l.trim().startsWith('*')).join('\n');
    expect(code).not.toMatch(/createHmac|randomBytes|timingSafeEqual|from ['"]node:crypto['"]/);
    expect(code).not.toMatch(/require\(['"]crypto['"]\)/);
  });

  it('adds NO route to the application wiring', async () => {
    const app = readFileSync(new URL('../../server/app.ts', import.meta.url), 'utf8');
    expect(app).not.toContain('wholeRecipeSemanticConsumption');
    expect(app).not.toContain('consumeAuthenticatedWholeRecipeSemantics');
  });
});
