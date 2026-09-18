/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: session authority, matching
 * review, source-portion, and advisory calculation.
 *
 * Uses the clearly labeled SYNTHETIC Phase 3 fixtures (never a production USDA
 * catalog).
 */

import { describe, it, expect } from 'vitest';
import * as sessionModule from '../../src/core/nutritionV2/phase4/session';
import {
  createAdvancedNutritionSession,
} from '../../src/core/nutritionV2/phase4/session';
import { buildPortionChoice } from '../../src/core/nutritionV2/phase4/portion';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import type { AdaptedIngredient } from '../../src/core/nutritionV2/phase4/types';
import { buildReviewRows, buildCalculationRequest } from '../../src/core/nutritionV2/phase4/rows';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import { buildCalculationBundle, CALC_FOODS } from '../fixtures/usdaCalculationFixtures';

function genuineSession(): AdvancedNutritionSession {
  const bundle = buildCalculationBundle(CALC_FOODS);
  const result = createAdvancedNutritionSession(bundle.manifest, bundle.records);
  if (!result.ok) throw new Error('session failed');
  return result.session;
}

function adapt(ingredients: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<AdaptedIngredient> {
  const result = adaptRecipe({ ingredients });
  if (!result.ok) {
    throw new Error(`adaptation failed: ${(result as { ok: false; failure: { code: string } }).failure.code}`);
  }
  return result.recipe.adapted;
}

function reviewOf(session: AdvancedNutritionSession, raw: unknown): any {
  return session.reviewIngredient(raw);
}

function confirmedSelection(review: any, fdcId: number) {
  return { kind: 'candidate', fdc_id: fdcId, review_digest: review.review_digest };
}

describe('phase 4 session — lexical authority encapsulation', () => {
  it('the session module exports only the intentional factory', () => {
    expect(Object.keys(sessionModule).sort()).toEqual(['createAdvancedNutritionSession'].sort());
    for (const key of Object.keys(sessionModule)) {
      expect(key).not.toMatch(/register|authority|registry|retrieve|bless|token/i);
    }
  });

  it('builds a genuine session from the same manifest/records and exposes bounded metadata', () => {
    const bundle = buildCalculationBundle(CALC_FOODS);
    const result = createAdvancedNutritionSession(bundle.manifest, bundle.records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const metadata = result.session.metadata();
    expect(metadata.bundle_release).toBe(bundle.bundleRelease);
    expect(metadata.record_count).toBe(CALC_FOODS.length);
    expect(metadata.catalog_digest).toMatch(/^[0-9a-f]{64}$/);
    // The session object exposes only its bounded operations.
    expect(Object.keys(result.session).sort()).toEqual(
      [
        'calculate',
        'confirmMatch',
        'metadata',
        'reviewCountPortions',
        'reviewIngredient',
        'reviewPortions',
      ].sort()
    );
  });

  it('rejects a structural fake / clone / spread / proxy / inherited / wrapper / null / primitive', () => {
    const session = genuineSession();
    const request = { servings: 1, nutrient_scope: ['calories'], ingredients: [{ line_ref: 'a', ingredient: 'Flour, wheat, white' }] };
    const fakes: unknown[] = [
      { metadata: () => session.metadata() },
      { ...session },
      Object.assign({}, session),
      new Proxy(session, {}),
      Object.create(session),
      () => session,
      null,
      42,
      'session',
      true,
    ];
    for (const fake of fakes) {
      const review = (session.reviewIngredient as any).call(fake, 'Flour, wheat, white');
      expect(review.outcome, JSON.stringify(fake)).toBe('invalid');
      const calc = (session.calculate as any).call(fake, request);
      expect(calc.ok, JSON.stringify(fake)).toBe(false);
      if (!calc.ok) expect(calc.failure.code).toBe('invalid_context');
      const portions = (session.reviewPortions as any).call(fake, 3001);
      expect(portions.ok).toBe(false);
    }
    // The genuine session still works.
    expect(session.calculate(request).ok).toBe(true);
  });

  it('does not expose private records or authority state', () => {
    const session = genuineSession();
    for (const forbidden of ['SESSION_AUTHORITY', 'resolveSessionAuthority', 'registerSessionAuthority', 'catalog', 'context', 'records']) {
      expect((session as unknown as Record<string, unknown>)[forbidden], forbidden).toBeUndefined();
      expect((sessionModule as unknown as Record<string, unknown>)[forbidden], forbidden).toBeUndefined();
    }
  });

  it('rejects a session built from mismatched inputs and cross-session reviews', () => {
    const bundleA = buildCalculationBundle(CALC_FOODS);
    const resultA = createAdvancedNutritionSession(bundleA.manifest, bundleA.records);
    if (!resultA.ok) throw new Error('A failed');
    const sessionA = resultA.session;

    // A different bundle (different canonical content digest) builds a distinct session.
    const otherFoods = [
      { fdcId: 4001, dataType: 'foundation' as const, description: 'Rice, white', nutrients: { calories: 130 } },
    ];
    const bundleB = buildCalculationBundle(otherFoods);
    const resultB = createAdvancedNutritionSession(bundleB.manifest, bundleB.records);
    if (!resultB.ok) throw new Error('B failed');
    const sessionB = resultB.session;

    expect(sessionA.metadata().catalog_digest).not.toBe(sessionB.metadata().catalog_digest);

    // A review produced by A cannot be confirmed against B.
    const review = reviewOf(sessionA, 'Butter');
    const selection = { kind: 'candidate', fdc_id: 3002, review_digest: review.review_digest };
    const cross = sessionB.confirmMatch(review, selection);
    expect(cross.outcome).toBe('invalid');
  });
});

describe('phase 4 session — explicit matching review', () => {
  it('never auto-selects an ambiguous candidate and requires an explicit choice', () => {
    const session = genuineSession();
    const review = reviewOf(session, 'Butter');
    expect(review.outcome).toBe('review_required');
    expect(review.candidates.length).toBeGreaterThan(0);

    // A wrong/absent digest is rejected.
    const bad = session.confirmMatch(review, { kind: 'candidate', fdc_id: 3002, review_digest: 'f'.repeat(64) });
    expect(bad.outcome).toBe('invalid');

    const ok = session.confirmMatch(review, confirmedSelection(review, 3002));
    expect(ok.outcome).toBe('confirmed');
    if (ok.outcome === 'confirmed') expect(ok.fdc_id).toBe(3002);
  });

  it('supports an explicit "none of these" rejection', () => {
    const session = genuineSession();
    const review = reviewOf(session, 'Butter');
    const none = session.confirmMatch(review, { kind: 'none', review_digest: review.review_digest });
    expect(none.outcome).toBe('rejected');
  });

  it('labels an automatic unique-exact match as NOT user-confirmed', () => {
    const session = genuineSession();
    const result = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient: 'Flour, wheat, white' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.preview.ingredients[0];
    expect(evidence.match_status).toBe('unique_exact');
    expect(evidence.user_confirmed).toBe(false);
  });

  it('rejects a stale review whose candidates were tampered with', () => {
    const session = genuineSession();
    const review = reviewOf(session, 'Butter');
    const tampered = { ...review, candidates: review.candidates.map((c: any) => ({ ...c, fdc_id: 999999 })) };
    const result = session.confirmMatch(tampered, { kind: 'candidate', fdc_id: 999999, review_digest: review.review_digest });
    expect(result.outcome).toBe('invalid');
  });

  it('marks a rejected (none) row as ambiguous and contributes nothing', () => {
    const session = genuineSession();
    const review = reviewOf(session, 'Butter');
    const result = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          line_ref: 'a',
          ingredient: 'Butter',
          review,
          selection: { kind: 'none', review_digest: review.review_digest },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].outcome).toBe('ambiguous');
    expect(result.preview.totals.calories).toBeUndefined();
  });
});

describe('phase 4 session — source-portion workflow', () => {
  it('never auto-selects a portion and derives mass only from an explicit, bound choice', () => {
    const session = genuineSession();
    const adapted = adapt([{ original: '2 cups Flour, wheat, white', amount: 2, unit: 'cups' }]);
    const rows = buildReviewRows(session, adapted);
    expect(rows[0].outcome).toBe('matched_exact');

    // Without a portion selection the volume ingredient has no mass.
    const noPortion = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: adapted[0].line_ref, ingredient: adapted[0].ingredient }],
    });
    expect(noPortion.ok).toBe(true);
    if (noPortion.ok) expect(noPortion.preview.ingredients[0].outcome).toBe('no_mass');

    const choice = buildPortionChoice(session, {
      lineRef: adapted[0].line_ref,
      ingredient: adapted[0].ingredient,
      fdcId: 3001,
      portionIndex: 0,
    });
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;

    const withPortion = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        { line_ref: adapted[0].line_ref, ingredient: adapted[0].ingredient, portion_selection: choice.choice.selection },
      ],
    });
    expect(withPortion.ok).toBe(true);
    if (!withPortion.ok) return;
    expect(withPortion.preview.ingredients[0].mass_source).toBe('source_portion');
    expect(withPortion.preview.ingredients[0].resolved_grams).toBeCloseTo(250, 6);
  });

  it('treats a legitimately amount-less FNDDS portion as unusable (never invents 1)', () => {
    const session = genuineSession();
    const choice = buildPortionChoice(session, {
      lineRef: 'a',
      ingredient: 'Salt, table',
      fdcId: 3003,
      portionIndex: 0,
    });
    expect(choice.ok).toBe(false);
    expect((choice as { ok: false; failure: { code: string } }).failure.code).toBe('not_available');
  });

  it('rejects a stale candidate-set digest and derives no mass', () => {
    const session = genuineSession();
    const adapted = adapt([{ original: '2 cups Flour, wheat, white', amount: 2, unit: 'cups' }]);
    const choice = buildPortionChoice(session, {
      lineRef: adapted[0].line_ref,
      ingredient: adapted[0].ingredient,
      fdcId: 3001,
      portionIndex: 0,
    });
    if (!choice.ok) throw new Error('choice failed');
    const staleSelection = { ...(choice.choice.selection as Record<string, unknown>), candidates_digest: 'f'.repeat(64) };
    const result = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        { line_ref: adapted[0].line_ref, ingredient: adapted[0].ingredient, portion_selection: staleSelection },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preview.ingredients[0].outcome).toBe('no_mass');
  });

  it('rejects a portion for the wrong food identity', () => {
    const session = genuineSession();
    const choice = buildPortionChoice(session, {
      lineRef: 'a',
      ingredient: 'Flour, wheat, white',
      fdcId: 3002,
      portionIndex: 0,
    });
    // 3002 has a valid portion, but the ingredient identity is Flour, not Butter.
    expect(choice.ok).toBe(false);
  });
});

describe('phase 4 request builder — no implicit selection', () => {
  it('does not supply a review/selection for an unselected ambiguous row', () => {
    const session = genuineSession();
    const adapted = adapt([{ original: 'Butter' }]);
    const rows = buildReviewRows(session, adapted);
    expect(rows[0].outcome).toBe('review_required');
    const state = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: 'k#1',
      sessionIdentity: 'k-session',
      rows,
      baseServings: 1,
    });
    const request = buildCalculationRequest(adapted, state) as {
      ingredients: Array<{ review?: unknown; selection?: unknown; portion_selection?: unknown }>;
    };
    expect(request.ingredients[0].review).toBeUndefined();
    expect(request.ingredients[0].selection).toBeUndefined();
    expect(request.ingredients[0].portion_selection).toBeUndefined();
  });

  it('supplies an explicit confirmation only after the user chooses', () => {
    const session = genuineSession();
    const adapted = adapt([{ original: 'Butter' }]);
    const rows = buildReviewRows(session, adapted);
    const review = rows[0].review as { review_digest: string };
    let state = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: 'k#1',
      sessionIdentity: 'k-session',
      rows,
      baseServings: 1,
    });
    state = phase4Reducer(state, {
      type: 'select_match',
      lineRef: adapted[0].line_ref,
      choice: { kind: 'candidate', fdc_id: 3002, review_digest: review.review_digest },
    });
    const request = buildCalculationRequest(adapted, state) as {
      ingredients: Array<{ review?: unknown; selection?: { kind: string; fdc_id?: number } }>;
    };
    expect(request.ingredients[0].review).toBeDefined();
    expect(request.ingredients[0].selection?.kind).toBe('candidate');
    expect(request.ingredients[0].selection?.fdc_id).toBe(3002);
  });

  it('never supplies a portion selection without an explicit portion choice', () => {
    const session = genuineSession();
    const adapted = adapt([{ original: '2 cups Flour, wheat, white', amount: 2, unit: 'cups' }]);
    const rows = buildReviewRows(session, adapted);
    const state = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: 'k#2',
      sessionIdentity: 'k-session',
      rows,
      baseServings: 1,
    });
    const request = buildCalculationRequest(adapted, state) as {
      ingredients: Array<{ portion_selection?: unknown }>;
    };
    expect(request.ingredients[0].portion_selection).toBeUndefined();
  });
});

describe('phase 4 session — advisory calculation boundary', () => {
  it('returns an AdvisoryNutritionPreview, never a codex_nutrition block', () => {
    const session = genuineSession();
    const result = session.calculate({
      servings: 4,
      nutrient_scope: ['calories', 'protein'],
      ingredients: [{ line_ref: 'a', ingredient: '100 g Flour, wheat, white' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.basis).toBe('total');
    expect(result.preview.advisory_only).toBe(true);
    expect(result.preview.application_authorized).toBe(false);
    expect('codex_nutrition' in result.preview).toBe(false);
    expect('schema' in result.preview).toBe(false);
    expect('computed_at' in result.preview).toBe(false);
  });

  it('keeps application authorization globally disabled', async () => {
    const { advancedNutritionApplicationAuthorization } = await import('../../src/core/nutritionV2/validate');
    expect(advancedNutritionApplicationAuthorization()).toEqual({
      ok: false,
      reasons: ['automated_application_disabled_pending_provenance_persistence'],
    });
  });
});
