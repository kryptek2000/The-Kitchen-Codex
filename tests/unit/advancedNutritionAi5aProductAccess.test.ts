/**
 * AI-5A — PRODUCT ACCESS / ENTITLEMENT CONTRACT (the pure contract).
 *
 * AI-5A answers ONE of three independent questions:
 *
 *   1. PRODUCT ACCESS        "Is this user entitled to AI Advanced Nutrition?"  <-- here
 *   2. OPERATIONAL READINESS "Is an allowed provider/model/credential available NOW?"
 *   3. NUTRITION AUTHORITY   "May this AI result affect identity, mass, nutrients,
 *                             Apply, persistence?"
 *
 * This suite pins the contract itself: the closed tier vocabulary, the closed AI
 * feature vocabulary, the two canonical access states, fail-closed resolution of
 * arbitrary runtime input, the impossibility of authoring an impossible product
 * state, deterministic tier->feature mapping, and immutability.
 *
 * It deliberately contains NO provider, NO credential, NO billing and NO nutrition
 * authority: constructing this value must move no nutrition truth whatsoever.
 */
import { describe, it, expect } from 'vitest';

import {
  AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
  AI_ADVANCED_NUTRITION_PRODUCT_TIER,
  BASIC_NUTRITION_PRODUCT_ACCESS,
  BASIC_NUTRITION_PRODUCT_TIER,
  NUTRITION_PRODUCT_ACCESS_VERSION,
  NUTRITION_PRODUCT_AI_FEATURES,
  NUTRITION_PRODUCT_TIERS,
  isAiAdvancedProductAccess,
  isBasicProductAccess,
  isNutritionProductAccess,
  isNutritionProductFeatureEntitled,
  isNutritionProductTier,
  resolveNutritionProductAccess,
  resolveNutritionProductTier,
  type NutritionProductAiFeature,
  type NutritionProductTier,
} from '../../src/core/nutritionV2/nutritionProductAccess';

// ---------------------------------------------------------------------------
// 1. CLOSED VERSIONED CONTRACT
// ---------------------------------------------------------------------------
describe('AI-5A product access — the closed versioned contract', () => {
  it('declares exactly the recommended contract version', () => {
    expect(NUTRITION_PRODUCT_ACCESS_VERSION).toBe('nutrition_product_access_v1');
  });

  it('both canonical access values carry the contract version', () => {
    expect(BASIC_NUTRITION_PRODUCT_ACCESS.version).toBe(NUTRITION_PRODUCT_ACCESS_VERSION);
    expect(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS.version).toBe(NUTRITION_PRODUCT_ACCESS_VERSION);
  });

  it('exposes EXACTLY two tiers and no pricing-plan tier', () => {
    expect([...NUTRITION_PRODUCT_TIERS]).toEqual(['basic', 'ai_advanced']);
    // Pricing/commercial vocabulary belongs to later account layers and must never
    // become a nutrition entitlement input.
    for (const forbidden of [
      'monthly',
      'annual',
      'lifetime',
      'community',
      'premium',
      'pro',
      'paid',
      'enterprise',
      'team',
      'trial',
      'free',
    ]) {
      expect([...NUTRITION_PRODUCT_TIERS]).not.toContain(forbidden);
      const tiers: readonly NutritionProductTier[] = NUTRITION_PRODUCT_TIERS;
      for (const tier of tiers) expect(tier).not.toBe(forbidden);
    }
  });

  it('the tier constants are the exact closed values', () => {
    expect(BASIC_NUTRITION_PRODUCT_TIER).toBe('basic');
    expect(AI_ADVANCED_NUTRITION_PRODUCT_TIER).toBe('ai_advanced');
  });

  it('exposes EXACTLY the four EXISTING AI product features', () => {
    expect([...NUTRITION_PRODUCT_AI_FEATURES]).toEqual([
      'ai_interpretation',
      'ai_candidate_orchestration',
      'ai_bounded_mass_estimation',
      'ai_recipe_context_review',
    ]);
  });

  it('creates NO entitlement for functionality that does not exist', () => {
    const features: readonly NutritionProductAiFeature[] = NUTRITION_PRODUCT_AI_FEATURES;
    // Accepted AI-4 context still has ZERO downstream consumers, so it must NOT
    // be an entitled product capability. Its absence is the AI-4 trust boundary
    // expressed as a closed vocabulary.
    expect(features).not.toContain('ai_recipe_context_application');
    expect(JSON.stringify(features)).not.toContain('recipe_context_application');
    for (const notBuilt of [
      'ai_nutrition_authority',
      'ai_apply',
      'ai_persistence',
      'ai_provenance',
      'ai_matching',
      'ai_identity',
      'ai_mass_authority',
      'ai_usage',
      'ai_billing',
      'ai_quota',
    ]) {
      expect(features).not.toContain(notBuilt);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. THE TWO CANONICAL ACCESS STATES
// ---------------------------------------------------------------------------
describe('AI-5A product access — Basic canonical access', () => {
  it('is `basic` with EVERY AI product feature false', () => {
    expect(BASIC_NUTRITION_PRODUCT_ACCESS).toEqual({
      version: 'nutrition_product_access_v1',
      tier: 'basic',
      aiInterpretation: false,
      aiCandidateOrchestration: false,
      aiBoundedMassEstimation: false,
      aiRecipeContextReview: false,
    });
    for (const feature of NUTRITION_PRODUCT_AI_FEATURES) {
      expect(isNutritionProductFeatureEntitled(BASIC_NUTRITION_PRODUCT_ACCESS, feature)).toBe(false);
    }
  });

  it('is identifiable as Basic and NOT as AI Advanced', () => {
    expect(isBasicProductAccess(BASIC_NUTRITION_PRODUCT_ACCESS)).toBe(true);
    expect(isAiAdvancedProductAccess(BASIC_NUTRITION_PRODUCT_ACCESS)).toBe(false);
    expect(isNutritionProductAccess(BASIC_NUTRITION_PRODUCT_ACCESS)).toBe(true);
  });
});

describe('AI-5A product access — AI Advanced canonical access', () => {
  it('is `ai_advanced` with every CURRENT AI product feature true', () => {
    expect(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS).toEqual({
      version: 'nutrition_product_access_v1',
      tier: 'ai_advanced',
      aiInterpretation: true,
      aiCandidateOrchestration: true,
      aiBoundedMassEstimation: true,
      aiRecipeContextReview: true,
    });
    for (const feature of NUTRITION_PRODUCT_AI_FEATURES) {
      expect(isNutritionProductFeatureEntitled(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS, feature)).toBe(
        true
      );
    }
  });

  it('is identifiable as AI Advanced and NOT as Basic', () => {
    expect(isAiAdvancedProductAccess(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS)).toBe(true);
    expect(isBasicProductAccess(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS)).toBe(false);
    expect(isNutritionProductAccess(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS)).toBe(true);
  });

  it('is the SAME instance the resolver returns, so there are exactly two states', () => {
    expect(resolveNutritionProductAccess('ai_advanced')).toBe(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS);
    expect(resolveNutritionProductAccess('basic')).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
    // Identity, not structural equality: no third value can exist.
    expect(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS).not.toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
  });
});

// ---------------------------------------------------------------------------
// 3. MANUAL / DETERMINISTIC NUTRITION IS NOT A PAID CAPABILITY
// ---------------------------------------------------------------------------
describe('AI-5A product access — deterministic nutrition is never paid', () => {
  it('the access shape carries ONLY the tier and the four AI product features', () => {
    const keys = Object.keys(BASIC_NUTRITION_PRODUCT_ACCESS).sort();
    expect(keys).toEqual([
      'aiBoundedMassEstimation',
      'aiCandidateOrchestration',
      'aiInterpretation',
      'aiRecipeContextReview',
      'tier',
      'version',
    ]);
    expect(Object.keys(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS).sort()).toEqual(keys);
  });

  it('models NO manual or deterministic capability as a feature', () => {
    // These are permanent free/basic product invariants and are deliberately NOT
    // entitlement fields. Their absence is the point: AI Advanced must never be
    // able to take them away, and Basic must never have to buy them.
    for (const notEntitled of [
      'manualEditing',
      'manualFoodCorrection',
      'manualTotalWeight',
      'deterministicReview',
      'deterministicMatching',
      'deterministicCalculation',
      'provenance',
      'apply',
      'persistence',
      'householdPortions',
      'countPortions',
      'sourcePortions',
    ]) {
      expect(JSON.stringify(BASIC_NUTRITION_PRODUCT_ACCESS)).not.toContain(notEntitled);
      expect(JSON.stringify(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS)).not.toContain(notEntitled);
      expect([...NUTRITION_PRODUCT_AI_FEATURES].join(',')).not.toContain(notEntitled);
    }
  });

  it('grants AI Advanced nothing over the deterministic foundation', () => {
    // AI Advanced is an interpretation/orchestration layer ADDED to Basic. It is
    // not a superset that redefines or withdraws any deterministic capability.
    const basic = BASIC_NUTRITION_PRODUCT_ACCESS;
    const advanced = AI_ADVANCED_NUTRITION_PRODUCT_ACCESS;
    expect(advanced.version).toBe(basic.version);
    // Every advanced-only field is an AI feature, and no non-AI field differs.
    const nonAiKeys = Object.keys(basic).filter((key) => !key.startsWith('ai'));
    for (const key of nonAiKeys) {
      if (key === 'tier') continue;
      expect(advanced[key as keyof typeof advanced]).toBe(basic[key as keyof typeof basic]);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. FAIL-CLOSED RESOLUTION
// ---------------------------------------------------------------------------
const NEVER_ENTITLED: ReadonlyArray<readonly [string, unknown]> = [
  ['missing (no argument)', undefined],
  ['null', null],
  ['empty string', ''],
  ['unknown string', 'unknown'],
  ['pricing alias "pro"', 'pro'],
  ['pricing alias "premium"', 'premium'],
  ['pricing alias "paid"', 'paid'],
  ['pricing alias "enterprise"', 'enterprise'],
  ['pricing alias "lifetime"', 'lifetime'],
  ['wrong case (upper)', 'AI_ADVANCED'],
  ['wrong case (title)', 'Ai_Advanced'],
  ['wrong case (mixed)', 'ai_Advanced'],
  ['leading whitespace', ' ai_advanced'],
  ['trailing whitespace', 'ai_advanced '],
  ['hyphen spelling', 'ai-advanced'],
  ['camel spelling', 'aiAdvanced'],
  ['number 1', 1],
  ['number 0', 0],
  ['NaN', Number.NaN],
  ['boolean true', true],
  ['boolean false', false],
  ['plain object', { tier: 'ai_advanced' }],
  ['nested feature object', { tier: 'ai_advanced', aiInterpretation: true }],
  ['array', ['ai_advanced']],
  ['feature list payload', { features: ['ai_interpretation', 'ai_bounded_mass_estimation'] }],
  ['array feature list', ['ai_interpretation', 'ai_candidate_orchestration']],
  ['String wrapper object', new String('ai_advanced')],
  ['Symbol', Symbol('ai_advanced')],
  ['function', () => 'ai_advanced'],
  ['BigInt', BigInt(1)],
  ['Date', new Date(0)],
];

describe('AI-5A product access — FAIL CLOSED on every unsupported input', () => {
  for (const [label, value] of NEVER_ENTITLED) {
    it(`resolves ${label} to Basic with no AI entitlement`, () => {
      expect(resolveNutritionProductTier(value)).toBe('basic');
      const access = resolveNutritionProductAccess(value);
      expect(access).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
      expect(access.tier).toBe('basic');
      for (const feature of NUTRITION_PRODUCT_AI_FEATURES) {
        expect(isNutritionProductFeatureEntitled(access, feature)).toBe(false);
      }
    });
  }

  it('does not accept truthy booleans or 1 as an AI Advanced signal', () => {
    // `true` is not an entitlement, however tempting it looks. Only the exact
    // supported tier string may resolve to AI Advanced.
    for (const value of [true, 1, 'yes', 'on', 'enabled', {}, Object.keys]) {
      expect(resolveNutritionProductAccess(value)).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
    }
  });

  it('accepts ONLY the exact supported tier values', () => {
    expect(isNutritionProductTier('basic')).toBe(true);
    expect(isNutritionProductTier('ai_advanced')).toBe(true);
    for (const [label, value] of NEVER_ENTITLED) {
      expect(isNutritionProductTier(value), label).toBe(false);
    }
  });

  it('resolves the exact supported tier values to the canonical access', () => {
    expect(resolveNutritionProductTier('ai_advanced')).toBe('ai_advanced');
    expect(resolveNutritionProductTier('basic')).toBe('basic');
    expect(resolveNutritionProductAccess('ai_advanced').tier).toBe('ai_advanced');
    expect(resolveNutritionProductAccess('basic').tier).toBe('basic');
  });

  it('is a PURE function of its input: same input, same identity, forever', () => {
    expect(resolveNutritionProductAccess('ai_advanced')).toBe(
      resolveNutritionProductAccess('ai_advanced')
    );
    expect(resolveNutritionProductAccess('junk')).toBe(resolveNutritionProductAccess('junk'));
    expect(resolveNutritionProductAccess()).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
  });

  it('a provider/configure/BYOK-shaped input can never manufacture AI Advanced', () => {
    // These are the exact "critical separation" payloads from AI-5A. Possession of
    // a key, or the existence of a provider, is not ownership.
    for (const value of [
      { aiConfigured: true },
      { aiReachable: true },
      { aiConfigured: true, aiReachable: true },
      { providerId: 'openrouter', modelId: 'google/gemini-2.5-flash' },
      { credentialSource: 'session_only' },
      { server_environment: true },
      { apiKey: 'sk-test' },
    ]) {
      expect(resolveNutritionProductTier(value)).toBe('basic');
      expect(resolveNutritionProductAccess(value)).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. IMPOSSIBLE-STATE DEFENSE
// ---------------------------------------------------------------------------

/**
 * The resolver's real signature accepts ONE tier-shaped scalar. This alias widens
 * it only so the suite can also assert the runtime truth about extra arguments:
 * they are ignored, because no parameter of the implementation reads them.
 */
const resolveLoose = resolveNutritionProductAccess as (
  value?: unknown,
  ...ignored: unknown[]
) => typeof BASIC_NUTRITION_PRODUCT_ACCESS;

describe('AI-5A product access — an impossible product state cannot be authored', () => {
  it('the public resolver accepts NO feature input of any kind', () => {
    // Passing features is impossible: the resolver's only parameter is a
    // tier-shaped scalar, and extra arguments are ignored.
    const forged = resolveLoose('basic', {
      aiInterpretation: true,
      aiCandidateOrchestration: true,
      aiBoundedMassEstimation: true,
      aiRecipeContextReview: true,
    });
    expect(forged).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
    expect(forged.aiInterpretation).toBe(false);
    expect(forged.aiCandidateOrchestration).toBe(false);
    expect(forged.aiBoundedMassEstimation).toBe(false);
    expect(forged.aiRecipeContextReview).toBe(false);
  });

  it('no exported function can build `basic` plus an enabled AI feature', () => {
    // There is deliberately no builder that takes features. Every exported
    // function is either a scalar->canonical-instance resolver or a reader over an
    // already-canonical instance.
    expect(resolveNutritionProductAccess({ tier: 'basic', aiInterpretation: true })).toBe(
      BASIC_NUTRITION_PRODUCT_ACCESS
    );
    expect(resolveNutritionProductAccess({ tier: 'basic', aiRecipeContextReview: true })).toBe(
      BASIC_NUTRITION_PRODUCT_ACCESS
    );
  });

  it('a hand-authored mimic is NOT a product-access value', () => {
    // Structural typing would let a caller write the shape by hand. The identity
    // reader refuses it, so an impossible mimic can never pass as a decision.
    const mimic = {
      version: NUTRITION_PRODUCT_ACCESS_VERSION,
      tier: 'basic',
      aiInterpretation: true,
      aiCandidateOrchestration: true,
      aiBoundedMassEstimation: true,
      aiRecipeContextReview: true,
    };
    expect(isNutritionProductAccess(mimic)).toBe(false);
    expect(isBasicProductAccess(mimic)).toBe(false);
    expect(isAiAdvancedProductAccess(mimic)).toBe(false);
    for (const feature of NUTRITION_PRODUCT_AI_FEATURES) {
      expect(isNutritionProductFeatureEntitled(mimic, feature)).toBe(false);
    }
  });

  it('no non-canonical value is ever entitled', () => {
    for (const value of [
      null,
      undefined,
      0,
      '',
      'ai_advanced',
      {},
      [],
      BASIC_NUTRITION_PRODUCT_ACCESS.version,
      JSON.parse(JSON.stringify(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS)),
    ]) {
      for (const feature of NUTRITION_PRODUCT_AI_FEATURES) {
        expect(isNutritionProductFeatureEntitled(value, feature), String(value)).toBe(false);
      }
    }
    // ... including a structurally identical CLONE of the real AI Advanced value:
    // only the canonical instance is ever entitled.
    const clone = JSON.parse(JSON.stringify(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS));
    expect(isNutritionProductFeatureEntitled(clone, 'ai_interpretation')).toBe(false);
    expect(isNutritionProductAccess(clone)).toBe(false);
  });

  it('an unknown feature name is never entitled, even for AI Advanced', () => {
    for (const unknownFeature of [
      'ai_recipe_context_application',
      'ai_apply',
      'ai_persistence',
      'unknown_feature',
      '',
    ]) {
      expect(
        isNutritionProductFeatureEntitled(
          AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
          unknownFeature as NutritionProductAiFeature
        )
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. FEATURE MAPPING IS DERIVED, DETERMINISTIC AND OVERRIDE-FREE
// ---------------------------------------------------------------------------
describe('AI-5A product access — deterministic tier -> feature mapping', () => {
  it('maps every closed feature deterministically from the tier', () => {
    for (const tier of NUTRITION_PRODUCT_TIERS) {
      const access = resolveNutritionProductAccess(tier);
      for (const feature of NUTRITION_PRODUCT_AI_FEATURES) {
        const expected = tier === 'ai_advanced';
        for (let repeat = 0; repeat < 3; repeat += 1) {
          expect(isNutritionProductFeatureEntitled(access, feature)).toBe(expected);
        }
        // The boolean is a real, derived field of the canonical value.
        const field = {
          ai_interpretation: 'aiInterpretation',
          ai_candidate_orchestration: 'aiCandidateOrchestration',
          ai_bounded_mass_estimation: 'aiBoundedMassEstimation',
          ai_recipe_context_review: 'aiRecipeContextReview',
        }[feature] as keyof typeof access;
        expect(access[field]).toBe(expected);
      }
    }
  });

  it('the feature booleans equal a pure function of the tier (no independent state)', () => {
    const derive = (tier: NutritionProductTier): boolean[] =>
      NUTRITION_PRODUCT_AI_FEATURES.map(() => tier === 'ai_advanced');
    for (const access of [BASIC_NUTRITION_PRODUCT_ACCESS, AI_ADVANCED_NUTRITION_PRODUCT_ACCESS]) {
      expect([
        access.aiInterpretation,
        access.aiCandidateOrchestration,
        access.aiBoundedMassEstimation,
        access.aiRecipeContextReview,
      ]).toEqual(derive(access.tier));
    }
  });

  it('exposes NO caller-provided feature override', () => {
    // Only ONE entry point exists and it takes a scalar tier. There is no
    // `features`, `overrides`, `withFeatures`, `enable()` or partial-update API.
    const module = BASIC_NUTRITION_PRODUCT_ACCESS;
    expect(Object.keys(module)).not.toContain('features');
    expect(Object.keys(module)).not.toContain('overrides');
    // Passing overrides as extra arguments cannot change any canonical field.
    const before = JSON.stringify(BASIC_NUTRITION_PRODUCT_ACCESS);
    resolveLoose('basic', { features: NUTRITION_PRODUCT_AI_FEATURES });
    resolveLoose('basic', ['ai_interpretation']);
    expect(JSON.stringify(BASIC_NUTRITION_PRODUCT_ACCESS)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 7. IMMUTABILITY
// ---------------------------------------------------------------------------
describe('AI-5A product access — the canonical values are frozen', () => {
  const CANONICAL: ReadonlyArray<readonly [string, object]> = [
    ['BASIC', BASIC_NUTRITION_PRODUCT_ACCESS],
    ['AI_ADVANCED', AI_ADVANCED_NUTRITION_PRODUCT_ACCESS],
  ];

  for (const [name, access] of CANONICAL) {
    it(`${name} access is frozen and mutation-resistant`, () => {
      expect(Object.isFrozen(access)).toBe(true);
      const target = access as Record<string, unknown>;
      expect(() => {
        'use strict';
        target.aiInterpretation = !target.aiInterpretation;
      }).toThrow(TypeError);
      expect(() => {
        'use strict';
        target.tier = target.tier === 'basic' ? 'ai_advanced' : 'basic';
      }).toThrow(TypeError);
      expect(() => {
        'use strict';
        target.version = 'nutrition_product_access_v0';
      }).toThrow(TypeError);
      expect(() => {
        'use strict';
        target.injected = true;
      }).toThrow(TypeError);
      expect(Object.isFrozen(access)).toBe(true);
    });

    it(`${name} access cannot be extended, mutated in place, or deleted`, () => {
      const record = access as Record<string, unknown>;
      expect(Object.isExtensible(record)).toBe(false);
      expect(() => Object.defineProperty(record, 'aiApply', { value: true })).toThrow(TypeError);
      expect(() => Object.assign(record, { aiApply: true })).toThrow(TypeError);
      expect(() => {
        'use strict';
        delete record.tier;
      }).toThrow(TypeError);
    });
  }

  it('the closed vocabularies are frozen too', () => {
    expect(Object.isFrozen(NUTRITION_PRODUCT_TIERS)).toBe(true);
    expect(Object.isFrozen(NUTRITION_PRODUCT_AI_FEATURES)).toBe(true);
    expect(() => {
      (NUTRITION_PRODUCT_TIERS as unknown as unknown[]).push('premium');
    }).toThrow(TypeError);
    expect(() => {
      (NUTRITION_PRODUCT_AI_FEATURES as unknown as unknown[]).push('ai_apply');
    }).toThrow(TypeError);
    expect([...NUTRITION_PRODUCT_TIERS]).toEqual(['basic', 'ai_advanced']);
    expect([...NUTRITION_PRODUCT_AI_FEATURES]).toHaveLength(4);
  });

  it('repeated resolution never hands back a fresh, mutable copy', () => {
    const first = resolveNutritionProductAccess('ai_advanced');
    const second = resolveNutritionProductAccess('ai_advanced');
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. PRODUCT ACCESS IS NOT NUTRITION AUTHORITY, NOT PROOF, NOT BYOK
// ---------------------------------------------------------------------------
describe('AI-5A product access — what the value is NOT', () => {
  it('carries no nutrition authority field', () => {
    const serialized = JSON.stringify(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS);
    for (const authorityField of [
      'fdc_id',
      'grams',
      'gram',
      'mass',
      'nutrients',
      'calories',
      'portion',
      'household',
      'digest',
      'provenance',
      'apply',
      'persistence',
      'authorization',
      'candidate',
    ]) {
      expect(serialized).not.toContain(authorityField);
    }
  });

  it('carries no proof, receipt, token or crypto field', () => {
    const serialized = JSON.stringify(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS);
    for (const proofField of [
      'signature',
      'receipt',
      'token',
      'jwt',
      'license',
      'invoice',
      'receipt_id',
      'issued_at',
      'expires_at',
      'nonce',
      'hmac',
      'hash',
      'publicKey',
      'verified',
    ]) {
      expect(serialized).not.toContain(proofField);
    }
    // No cryptography whatsoever: the value is a plain frozen record.
    expect(Object.keys(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS)).toHaveLength(6);
  });

  it('carries no BYOK / credential / provider concept', () => {
    const serialized = JSON.stringify(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS);
    for (const credentialField of [
      'apiKey',
      'api_key',
      'credential',
      'credentialSource',
      'session_only',
      'sessionOnly',
      'server_environment',
      'providerId',
      'modelId',
      'provider',
      'gemini',
      'openrouter',
    ]) {
      expect(serialized).not.toContain(credentialField);
    }
  });

  it('an AI Advanced entitlement names NO nutrition authority', () => {
    // Entitlement is permission to ATTEMPT. It is deliberately not evidence about
    // identity, mass, portions, nutrients, calculation, Apply or persistence.
    expect(isNutritionProductFeatureEntitled(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS, 'ai_bounded_mass_estimation')).toBe(
      true
    );
    // ... yet bounded mass estimation still carries no mass: that authority lives
    // in the untouched AI-3 eligibility rules, not here.
    expect(Object.keys(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS)).not.toContain('massAuthority');
    expect(Object.keys(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS)).not.toContain('grams');
  });

  it('is a plain serializable value with no hidden non-serializable state', () => {
    const round = JSON.parse(JSON.stringify(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS));
    expect(round).toEqual(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS);
    expect(Object.keys(round)).toHaveLength(6);
  });
});