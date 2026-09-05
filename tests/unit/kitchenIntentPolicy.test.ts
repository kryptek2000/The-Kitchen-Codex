import { describe, it, expect } from 'vitest';
import { sanitizeKitchenIntent, isMeaningfulKitchenIntent, type KitchenIntent } from '../../src/utils/kitchenIntent';
import {
  sanitizeTrustedKitchenContext,
  resolveTrustedKitchenContext,
  evaluateKitchenIntentReadiness,
  resolveKitchenSourcePolicy,
  prepareKitchenIntentForExecution,
  MAX_TRUSTED_SELECTED_IDS,
  MIN_COMPARISON_SELECTED_IDS,
  type KitchenIntentReadiness,
  type KitchenSourcePolicy,
  type PreparedKitchenExecution,
} from '../../src/utils/kitchenIntentPolicy';

/** Build a Sanitized intent (Step 1 contract) from a raw object. */
function si(o: Record<string, unknown>): KitchenIntent {
  const r = sanitizeKitchenIntent(o);
  if (!r) throw new Error('test intent failed sanitization');
  return r;
}

/** Narrow a PreparedKitchenExecution to its ok:true variant for assertions. */
function expectOk(p: PreparedKitchenExecution): Extract<PreparedKitchenExecution, { ok: true }> {
  if (!p.ok) throw new Error('expected an ok preparation result');
  return p;
}

describe('kitchenIntentPolicy: trusted-context sanitizer', () => {
  it('J: drops empty / invalid / non-string trusted identities', () => {
    const ctx = sanitizeTrustedKitchenContext({
      currentRecipeId: '   ',
      selectedRecipeIds: ['', '  ', 42, null, undefined, ' real '],
    });
    expect(ctx.currentRecipeId).toBeUndefined();
    expect(ctx.selectedRecipeIds).toEqual(['real']);
  });

  it('K: bounds the trusted selected-recipe id list', () => {
    const many = Array.from({ length: 40 }, (_, i) => `id-${i}`);
    const ctx = sanitizeTrustedKitchenContext({ selectedRecipeIds: many });
    expect(ctx.selectedRecipeIds!.length).toBe(MAX_TRUSTED_SELECTED_IDS);
  });

  it('sanitizes a valid trusted current recipe id', () => {
    const ctx = sanitizeTrustedKitchenContext({ currentRecipeId: '  recipe-a  ' });
    expect(ctx.currentRecipeId).toBe('recipe-a');
  });
});

describe('kitchenIntentPolicy: trusted-context resolution', () => {
  it('A: similar_recipe + currentRecipe ref + trusted id -> resolved id present, executable', () => {
    const intent = si({ version: 1, intent: 'similar_recipe', source: 'vault', references: { currentRecipe: true } });
    const { trustedContext } = resolveTrustedKitchenContext(intent, { currentRecipeId: 'recipe-x' });
    expect(trustedContext.currentRecipeId).toBe('recipe-x');
    expect(evaluateKitchenIntentReadiness(intent, trustedContext).executable).toBe(true);
  });

  it('B: similar_recipe + currentRecipe ref + NO trusted id -> no fabricated id, not executable', () => {
    const intent = si({ version: 1, intent: 'similar_recipe', source: 'vault', references: { currentRecipe: true } });
    const { trustedContext } = resolveTrustedKitchenContext(intent, {});
    expect(trustedContext.currentRecipeId).toBeUndefined();
    expect(evaluateKitchenIntentReadiness(intent, trustedContext)).toEqual({
      executable: false,
      reason: 'missing_current_recipe',
    });
  });

  it('C: pairing + trusted current recipe -> resolves currentRecipeId', () => {
    const intent = si({ version: 1, intent: 'pairing', source: 'vault', references: { currentRecipe: true } });
    const { trustedContext } = resolveTrustedKitchenContext(intent, { currentRecipeId: 'recipe-p' });
    expect(trustedContext.currentRecipeId).toBe('recipe-p');
  });

  it('D: pairing without a trusted recipe -> not executable', () => {
    const intent = si({ version: 1, intent: 'pairing', source: 'vault', references: { currentRecipe: true } });
    const { trustedContext } = resolveTrustedKitchenContext(intent, {});
    expect(evaluateKitchenIntentReadiness(intent, trustedContext)).toEqual({
      executable: false,
      reason: 'missing_current_recipe',
    });
  });

  it('E: meal_suggestion does NOT inherit currentRecipeId automatically', () => {
    const intent = si({ version: 1, intent: 'meal_suggestion', source: 'vault' });
    const { trustedContext } = resolveTrustedKitchenContext(intent, { currentRecipeId: 'recipe-x' });
    expect(trustedContext.currentRecipeId).toBeUndefined();
  });

  it('F: compare with 2 trusted selected ids -> executable', () => {
    const intent = si({ version: 1, intent: 'compare', source: 'vault', references: { comparisonTargets: 2 } });
    const { trustedContext } = resolveTrustedKitchenContext(intent, { selectedRecipeIds: ['a', 'b'] });
    expect(trustedContext.comparisonRecipeIds).toEqual(['a', 'b']);
    expect(evaluateKitchenIntentReadiness(intent, trustedContext).executable).toBe(true);
  });

  it('G: compare with 1 trusted selected id -> not executable', () => {
    const intent = si({ version: 1, intent: 'compare', source: 'vault', references: { comparisonTargets: 2 } });
    const { trustedContext } = resolveTrustedKitchenContext(intent, { selectedRecipeIds: ['a'] });
    expect(trustedContext.comparisonRecipeIds).toEqual(['a']);
    expect(evaluateKitchenIntentReadiness(intent, trustedContext)).toEqual({
      executable: false,
      reason: 'insufficient_comparison_context',
    });
  });

  it('H: compare dedupes trusted selected ids; insufficient unique ids fails', () => {
    const intent = si({ version: 1, intent: 'compare', source: 'vault', references: { comparisonTargets: 2 } });
    const ok = resolveTrustedKitchenContext(intent, { selectedRecipeIds: ['a', 'a', 'b'] }).trustedContext;
    expect(ok.comparisonRecipeIds).toEqual(['a', 'b']);
    expect(evaluateKitchenIntentReadiness(intent, ok).executable).toBe(true);

    const bad = resolveTrustedKitchenContext(intent, { selectedRecipeIds: ['a', 'a'] }).trustedContext;
    expect(bad.comparisonRecipeIds).toEqual(['a']);
    expect(evaluateKitchenIntentReadiness(intent, bad)).toEqual({
      executable: false,
      reason: 'insufficient_comparison_context',
    });
  });

  it('I: model semantic comparisonTargets does NOT create recipe ids', () => {
    const intent = si({ version: 1, intent: 'compare', source: 'vault', references: { comparisonTargets: 3 } });
    const { trustedContext } = resolveTrustedKitchenContext(intent, {});
    expect(trustedContext.comparisonRecipeIds).toBeUndefined();
    expect(evaluateKitchenIntentReadiness(intent, trustedContext)).toEqual({
      executable: false,
      reason: 'insufficient_comparison_context',
    });
  });
});

describe('kitchenIntentPolicy: clarification & meaningfulness gate', () => {
  it('L: requiresClarification=true stays meaningful but execution is blocked', () => {
    const intent = si({
      version: 1,
      intent: 'find_recipes',
      source: 'vault',
      constraints: { includeIngredients: ['rice'] },
      requiresClarification: true,
    });
    expect(isMeaningfulKitchenIntent(intent)).toBe(true);
    expect(evaluateKitchenIntentReadiness(intent, {})).toEqual({
      executable: false,
      reason: 'requires_clarification',
    });
  });

  it('M: requiresClarification=false with valid context -> executable', () => {
    const intent = si({ version: 1, intent: 'meal_suggestion', source: 'vault' });
    expect(evaluateKitchenIntentReadiness(intent, {}).executable).toBe(true);
  });

  it('N: malformed / non-meaningful sanitized intent -> execution blocked', () => {
    const intent = si({ version: 1, intent: 'find_recipes', source: 'vault' });
    expect(evaluateKitchenIntentReadiness(intent, {})).toEqual({ executable: false, reason: 'not_meaningful' });
    expect(sanitizeKitchenIntent({})).toBeNull();
  });
});

describe('kitchenIntentPolicy: source policy', () => {
  const vault = si({ version: 1, intent: 'meal_suggestion', source: 'vault' });
  const vtw = si({ version: 1, intent: 'meal_suggestion', source: 'vault_then_web' });
  const web = si({ version: 1, intent: 'meal_suggestion', source: 'web' });

  it('O: vault -> initial vault, forbidden web, no immediate web execution', () => {
    expect(resolveKitchenSourcePolicy(vault)).toEqual({
      initialSource: 'vault',
      webDiscoveryPermission: 'forbidden',
      mayExecuteWebDiscoveryNow: false,
    });
  });

  it('P: vault_then_web -> initial vault, offer_if_weak, no immediate web execution', () => {
    expect(resolveKitchenSourcePolicy(vtw)).toEqual({
      initialSource: 'vault',
      webDiscoveryPermission: 'offer_if_weak',
      mayExecuteWebDiscoveryNow: false,
    });
  });

  it('Q: web -> initial web, explicitly_requested, immediate web execution allowed', () => {
    expect(resolveKitchenSourcePolicy(web)).toEqual({
      initialSource: 'web',
      webDiscoveryPermission: 'explicitly_requested',
      mayExecuteWebDiscoveryNow: true,
    });
  });

  it('R: vault_then_web NEVER produces automatic web execution', () => {
    for (const source of ['vault_then_web', 'vault'] as const) {
      const intent = si({ version: 1, intent: 'find_recipes', source });
      expect(resolveKitchenSourcePolicy(intent).mayExecuteWebDiscoveryNow).toBe(false);
    }
  });

  it('S: weak-result policy by itself NEVER flips mayExecuteWebDiscoveryNow=true', () => {
    // The policy is derived only from the source; a "weak results" notion has no
    // input here and can never turn vault_then_web into immediate web execution.
    const p = resolveKitchenSourcePolicy(vtw);
    expect(p.mayExecuteWebDiscoveryNow).toBe(false);
    expect(p.initialSource).toBe('vault');
  });

  it('T: discover_online + web source -> executable via explicitly-requested source policy', () => {
    const intent = si({ version: 1, intent: 'discover_online', source: 'web' });
    const policy = resolveKitchenSourcePolicy(intent);
    expect(policy.webDiscoveryPermission).toBe('explicitly_requested');
    expect(policy.mayExecuteWebDiscoveryNow).toBe(true);
    expect(evaluateKitchenIntentReadiness(intent, {}).executable).toBe(true);
  });

  it('U: discover_online + contradictory vault source -> safe source conflict', () => {
    const intent = si({ version: 1, intent: 'discover_online', source: 'vault' });
    expect(evaluateKitchenIntentReadiness(intent, {})).toEqual({ executable: false, reason: 'source_conflict' });
    // vault_then_web also forbids immediate web execution -> conflict.
    const vtwDiscover = si({ version: 1, intent: 'discover_online', source: 'vault_then_web' });
    expect(evaluateKitchenIntentReadiness(vtwDiscover, {})).toEqual({
      executable: false,
      reason: 'source_conflict',
    });
  });

  it('V: source policy is pure metadata with no side effects (plain object)', () => {
    const p = resolveKitchenSourcePolicy(web);
    expect(p).toEqual({
      initialSource: 'web',
      webDiscoveryPermission: 'explicitly_requested',
      mayExecuteWebDiscoveryNow: true,
    });
    expect(Object.keys(p).sort()).toEqual([
      'initialSource',
      'mayExecuteWebDiscoveryNow',
      'webDiscoveryPermission',
    ]);
  });

  it('non-discover intents with a web source are permitted (not blanket-rejected)', () => {
    const intent = si({ version: 1, intent: 'find_recipes', source: 'web', constraints: { includeIngredients: ['rice'] } });
    expect(evaluateKitchenIntentReadiness(intent, {}).executable).toBe(true);
    expect(resolveKitchenSourcePolicy(intent).mayExecuteWebDiscoveryNow).toBe(true);
  });
});

describe('kitchenIntentPolicy: sanitization order (prepare composes the pipeline)', () => {
  it('W: raw constraints.similarToRecipeId cannot make an intent executable on its own', () => {
    const raw = {
      version: 1,
      intent: 'similar_recipe',
      source: 'vault',
      references: { currentRecipe: true },
      constraints: { similarToRecipeId: 'model-id', includeIngredients: ['chicken'] },
    };
    const prepared = expectOk(prepareKitchenIntentForExecution(raw, {}));
    // The model id is drained before evaluation:
    expect(prepared.intent.constraints.similarToRecipeId).toBeUndefined();
    // ...and cannot become executable for that reason: no trusted id -> blocked.
    expect(prepared.readiness).toEqual({ executable: false, reason: 'missing_current_recipe' });
  });

  it('X: raw top-level targetRecipeId is stripped before resolution', () => {
    const prepared = expectOk(
      prepareKitchenIntentForExecution({ version: 1, intent: 'meal_suggestion', source: 'vault', targetRecipeId: 'x' }, {})
    );
    expect((prepared.intent as unknown as Record<string, unknown>)['targetRecipeId']).toBeUndefined();
  });

  it('Y: raw model comparisonRecipeIds are stripped; trusted selectedRecipeIds are the sole authority', () => {
    const prepared = expectOk(
      prepareKitchenIntentForExecution(
        {
          version: 1,
          intent: 'compare',
          source: 'vault',
          references: { comparisonTargets: 2 },
          comparisonRecipeIds: ['m1', 'm2'],
        },
        { selectedRecipeIds: ['t1', 't2'] }
      )
    );
    expect(prepared.trustedContext.comparisonRecipeIds).toEqual(['t1', 't2']);
  });

  it('prepare returns ok:false upfront for an invalid intent', () => {
    const prepared = prepareKitchenIntentForExecution({ version: 1, intent: 'nope', source: 'vault' }, {});
    expect(prepared.ok).toBe(false);
  });

  it('prepare is pure and never mutates its raw inputs', () => {
    const raw = Object.freeze({ version: 1, intent: 'meal_suggestion', source: 'vault' });
    const trusted = Object.freeze({ currentRecipeId: 'a' });
    const before = JSON.stringify({ raw, trusted });
    prepareKitchenIntentForExecution(raw, trusted);
    expect(JSON.stringify({ raw, trusted })).toBe(before);
  });
});
