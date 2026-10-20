/** Basic uses the same authenticated USDA analyzer and calculator as Advanced.
 * No provider calls. Partial nutrient subtotals are never recipe totals.
 */
import { adaptRecipe } from '../core/nutritionV2/phase4/adapt';
import { normalizeIngredientMeasurement } from '../utils/measurements';
import { findFoodReference, resolveFoodMass, getFoodCountWeight } from '../data/foodReference';
import { normalizeQuery } from '../core/nutritionV2/matching/normalize';
import { projectQueryText } from '../core/nutritionV2/matching/query';
import { buildCalculationRequest, buildReviewRows } from '../core/nutritionV2/phase4/rows';
import { buildCountPortionChoice } from '../core/nutritionV2/phase4/countPortion';
import type { Phase4State } from '../core/nutritionV2/phase4/types';
import { analyzeRecipe } from '../core/nutritionV2/phase4/analyzer';
import { parseRawIngredientMeasurementParts } from '../utils/measurements';
import { resolveRecipeBaseServings, roundNutritionForDisplay } from '../utils/nutrition';
import type { AdvancedNutritionSession } from '../core/nutritionV2/phase4/types';
import type { BasicNutritionEstimate, BasicNutritionInput, BasicNutritionTotals, BasicNutritionLine } from './basicNutrition';

const KEYS = ['calories', 'protein', 'carbohydrates', 'fat', 'fiber', 'sodium'] as const;
export function calculateCatalogBasicNutrition(input: BasicNutritionInput, session: AdvancedNutritionSession): BasicNutritionEstimate {
  const servings = resolveRecipeBaseServings(input.servings);
  // Raw text is authoritative for this action in BOTH UIs; use the shared
  // parser rather than forwarding stale structured fields from prior scaling.
  const ingredients = input.ingredients.map(item => {
    const original = (typeof item === 'string' ? item : item.original || `${item.amount ?? ''} ${item.unit ?? ''} ${item.name ?? ''}`).replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').trim();
    const p = parseRawIngredientMeasurementParts(original, { includeCount: true });
    return { original, amount: p.amount, unit: p.unit ?? '', name: p.name };
  });
  const adaptation = adaptRecipe({ title: '', servings, ingredients });
  if (!adaptation.ok) throw new Error('Nutrition could not read these ingredient quantities.');
  const analysis = analyzeRecipe(session, adaptation.recipe.adapted, servings);
  let preview = analysis.preview;
  const assumed = new Map<string, string>();
  if (preview) {
    const adapted = adaptation.recipe.adapted;
    const state = { rows: buildReviewRows(session, adapted), matches: analysis.matches, portions: analysis.portions,
      countPortions: { ...analysis.countPortions }, householdPortions: analysis.householdPortions,
      userMasses: {}, baseServings: servings } as unknown as Phase4State;
    // A missing size may use the source's MEDIUM portion as a disclosed
    // quantity estimate. It never changes the selected food identity.
    for (let i = 0; i < adapted.length; i++) {
      const e = preview.ingredients[i], row = analysis.rows[i], entry = adapted[i];
      if (e.outcome !== 'no_mass' || !e.fdc_id) continue;
      const p = ingredients[i];
      if (p.unit || !p.amount || p.amount <= 0 || p.amount > 1000) continue;
      const review = session.reviewCountPortions(entry.ingredient, e.fdc_id, { unit: null, size: 'medium' });
      if (!review.ok || review.review.candidates.length !== 1) continue;
      const choice = analysis.matches[entry.line_ref];
      const built = buildCountPortionChoice(session, { lineRef: entry.line_ref, ingredient: entry.ingredient,
        review: row.review, selection: choice ? { kind: 'candidate', fdc_id: choice.fdc_id, review_digest: choice.review_digest } : undefined,
        automaticSelection: !!choice, fdcId: e.fdc_id, portionIndex: review.review.candidates[0].index,
        countRequirementHint: { unit: null, size: 'medium' } });
      if (!built.ok) continue;
      (state.countPortions as Record<string, unknown>)[entry.line_ref] = built.choice;
      assumed.set(entry.line_ref, `Estimated quantity: assumes medium size; ${review.review.candidates[0].display_label}. Actual size was not authored.`);
    }
    const request = buildCalculationRequest(adapted, state) as { servings: number; nutrient_scope: import('../core/nutritionV2/nutrients').NutrientId[]; ingredients: Record<string, unknown>[] };
    // Reuse the existing documented curated quantity conversions ONLY as
    // estimates, after USDA has independently established food identity. Their
    // nutrient values are never used. No RACC or package amount is inferred.
    const estimatedInputs = request.ingredients.map((item, i) => {
      const e = preview!.ingredients[i], p = ingredients[i];
      if (e.outcome !== 'no_mass' || !e.fdc_id || assumed.has(e.line_ref)) return item;
      const identity = projectQueryText(normalizeQuery(p.name).text);
      const quantityName = identity.core_tokens.filter(t => !identity.variety_tokens.includes(t)).join(' ');
      const ref = findFoodReference(p.name) ?? findFoodReference(quantityName);
      if (!ref) return item;
      // A curated density carries a preparation state (notably raw chicken
      // breast versus cooked shredded chicken). Do not apply it to a different
      // or unstated USDA record state; identity may be valid while the mass
      // conversion is not.
      const referenceState = /\bcooked\b/i.test(ref.sourceNote ?? '') ? 'cooked'
        : /\braw\b/i.test(ref.sourceNote ?? '') ? 'raw' : null;
      const selectedDescription = analysis.rows[i]?.selected_description ?? '';
      const selectedState = /\bcooked\b|\broasted\b|\bgrilled\b|\bbaked\b|\bfried\b|\bboiled\b/i.test(selectedDescription) ? 'cooked'
        : /\braw\b/i.test(selectedDescription) ? 'raw' : null;
      if ((referenceState === 'cooked' && selectedState !== 'cooked') ||
          (referenceState === 'raw' && selectedState === 'cooked')) return item;
      const measurement = normalizeIngredientMeasurement({ amount: p.amount, unit: p.unit, name: p.name });
      const mass = resolveFoodMass(measurement, ref);
      const count = !p.unit ? getFoodCountWeight(ref, null) : undefined;
      const grams = mass.grams ?? (count && p.amount != null ? count.gramsPerItem * p.amount : undefined);
      const note = mass.note ?? count?.note;
      if (grams === undefined || !Number.isFinite(grams) || grams <= 0 || grams > 1000000 || !note) return item;
      assumed.set(e.line_ref, `Estimated quantity: ${note} Applied to ${rowFood(analysis.rows[i].selected_description)}; nutrient identity unchanged.`);
      // The separate estimate calculation is an explicit derived gram input,
      // not an assertion that the recipe author weighed this ingredient.
      const derived = { original: `${grams} g ${p.name}`, amount: grams, unit: 'g', name: p.name };
      const reviewed = session.reviewIngredient(derived);
      return { line_ref: e.line_ref, ingredient: derived, selection: {
        kind: 'manual', fdc_id: e.fdc_id, record_digest: e.record_digest,
        catalog_digest: preview!.catalog_digest, line_ref: e.line_ref, review_digest: reviewed.review_digest,
      } };
    });
    const calculated = session.calculate({ ...request, ingredients: estimatedInputs });
    if (calculated.ok) preview = calculated.preview;
  }
  if (!preview) throw new Error('The local USDA calculation could not be completed.');
  const totals = {} as Record<typeof KEYS[number], number | null>;
  const knownSubtotal = {} as Record<typeof KEYS[number], number | null>;
  const perServing = {} as Record<typeof KEYS[number], number | null>;
  for (const key of KEYS) {
    const n = preview.totals[key];
    knownSubtotal[key] = n && n.covered_ingredient_count > 0 ? n.amount : null;
    totals[key] = n?.status === 'complete' ? n.amount : null;
    perServing[key] = totals[key] === null ? null : (roundNutritionForDisplay({ [key]: totals[key]! / servings })[key] ?? null);
  }
  const missingNutrients = KEYS.filter(key => totals[key] === null);
  const lines: BasicNutritionLine[] = preview.ingredients.map((e, i) => {
    const row = analysis.rows[i];
    const resolved = e.outcome === 'calculated';
    const portions = e.fdc_id ? session.reviewPortions(e.fdc_id) : undefined;
    const portion = portions?.ok ? portions.review.candidates.find(p => p.index === e.portion_index) : undefined;
    const portionNote = portion ? ` Source measure: ${portion.measure}${portion.modifier && /[a-z]/i.test(portion.modifier) ? ` (${portion.modifier})` : ''} = ${portion.gram_weight} g.` : '';
    return {
      ingredient: ingredients[i].original,
      status: resolved ? 'resolved' : e.qualitative ? 'qualitative' : 'unresolved',
      grams: e.resolved_grams ?? null,
      basis: !resolved ? null : assumed.has(e.line_ref) ? 'estimated_quantity' : e.mass_source === 'direct_mass' ? 'direct_mass' : resolved ? 'source_portion' : null,
      matchedFood: row.selected_description ?? null,
      note: resolved ? (assumed.get(e.line_ref) ?? `USDA FDC ${e.fdc_id}; ${e.mass_source}; pinned release ${preview.bundle_release}.${portionNote}${e.contributing_nutrients.includes('calories') ? '' : ' Calories unavailable in this source record.'}`) : null,
      reason: resolved || e.qualitative ? null : e.outcome === 'no_mass' ? 'Food matched; no applicable portion or weight. Supply a weight or review an estimate.' : 'Food identity needs review in the local USDA catalog.',
    };
  });
  const resolved = lines.filter(l => l.status === 'resolved').length;
  const qualitative = lines.filter(l => l.status === 'qualitative').length;
  const unresolved = lines.length - resolved - qualitative;
  const complete = unresolved === 0 && resolved > 0;
  const servingsNote = typeof input.servings === 'number' && Number.isFinite(input.servings) && input.servings > 0
    ? ''
    : ' Servings were not authored; per-serving figures use an assumed 4-serving basis. Enter the recipe yield to replace this assumption.';
  const confidenceNote = `${resolved}/${lines.length - qualitative} measurable ingredient lines resolved using the pinned USDA catalog. ${complete ? 'Ingredient quantities covered.' : 'PARTIAL estimate: recipe totals are unknown; resolved contributions are only a subtotal.'} ${missingNutrients.length ? `Unknown nutrients: ${missingNutrients.join(', ')} (incomplete source coverage).` : ''}${servingsNote} ${[...assumed.values()].join(' ')}`;
  return {
    ok: resolved > 0, message: resolved ? null : 'No ingredient contribution could be calculated. Review food identities and quantities.',
    source: 'offline_heuristic', confidence: assumed.size ? 'low' : 'medium', confidenceNote, baseServings: servings,
    totals: Object.freeze(totals), perServing: Object.freeze(perServing), knownSubtotal: Object.freeze(knownSubtotal),
    coverage: { total: lines.length, resolved, qualitative, unresolved, complete },
    assumptions: [confidenceNote, ...assumed.values()], lines,
  };
}

function rowFood(description: string | undefined) { return description ?? 'the matched USDA food'; }
