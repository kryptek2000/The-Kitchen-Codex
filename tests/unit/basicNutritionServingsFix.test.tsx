import { resolveRecipeNutritionPresentation, deriveAdvancedCompactNutrition } from '../../src/core/nutritionV2/phase5c/presentation';
import { acceptAiEstimateOffer, buildAiEstimateUiSnapshot, AI_ESTIMATE_OFFER_LABEL } from '../../src/core/nutritionV2/phase4/aiEstimateAccept';
import { aiEstimateSnapshotBinding } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { workingChoiceFingerprint } from '../../src/core/nutritionV2/phase4/aiMidFlight';
import { buildCountPortionChoice } from '../../src/core/nutritionV2/phase4/countPortion';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK as lock } from '../../src/core/nutritionV2/usda/releaseLock';
import { calculateBasicNutrition, basicEstimateToNutrition } from '../../src/application/basicNutrition';
import { adaptRecipe, analyzeRecipe, buildReviewRows, buildCalculationRequest, hydrateWorkingReview, phase4Reducer } from '../../src/core/nutritionV2/phase4';
import { INITIAL_PHASE4_STATE } from '../../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity, type AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import { buildAiEstimateSelection } from '../../src/core/nutritionV2/phase4/aiEstimateSelection';
import { applyAdvancedNutrition } from '../../src/application/advancedNutritionApply';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown, parseIngredientLine, scaleIngredientText } from '../../src/utils/markdownParser';
import { decodeCodexNutrition } from '../../src/core/nutritionV2/validate';
import { isPartialMachineNutrition, nutritionForRequestedServings } from '../../src/utils/nutrition';
import type { ObsidianRecipe } from '../../src/types';

export const GUAC = ['3 ripe avocados','1 lime, juiced','1/2 white onion, finely diced','1 serrano chile, minced','1 roma tomato, seeded and diced','1/4 cup chopped cilantro','1/2 tsp kosher salt'];
const authored = readFileSync(join(__dirname, '../fixtures/nutritionRepairEnchiladas.md'), 'utf8');
let session: AdvancedNutritionSession;
const recipe = (lines: string[], servings = 6) => parseObsidianRecipeMarkdown(`---\ntitle: Test\nservings: ${servings}\n---\n# Test\n## Ingredients\n${lines.map(l => '- '+l).join('\n')}\n## Instructions\n1. Mix.`, 'test.md', 'Recipes/test.md');

beforeAll(async () => {
  const r = await composeAdvancedNutritionSessionFromBundle({ files: lock.artifact_filenames.map(name => ({ name, bytes: new Uint8Array(readFileSync(join(__dirname, '../../data/advanced-nutrition/usda', lock.bundle_release, name))) })) });
  if (!r.ok) throw r;
  session = r.session;
}, 300000);

describe('nutrition functional repair, pinned production USDA bundle', () => {
  it('compares Cochinita Basic assumptions against Advanced at the same whole-batch basis', () => {
    const r = parseObsidianRecipeMarkdown(readFileSync(join(__dirname, '../fixtures/nutritionRepairCochinitaPibil.md'), 'utf8'), 'cochinita.md', 'Recipes/cochinita.md');
    const a = adaptRecipe(r); if (!a.ok) throw new Error('adaptation failed');
    const basic = calculateBasicNutrition({ ingredients: r.ingredients, servings: 8 }, session);
    const advanced = analyzeRecipe(session, a.recipe.adapted, 8);
    expect(advanced.preview?.basis).toBe('total');
    expect(advanced.preview?.servings).toBe(8);
    expect(basic.baseServings).toBe(8);
    expect(basic.coverage.complete).toBe(false);
    expect(basic.totals.calories).toBeNull();
  });

  it('detects the real potato saved-mass conflict and recalculates the written range', () => {
    const raw = readFileSync(join(__dirname, '../fixtures/nutritionRepairPotatoes.md'), 'utf8');
    const potatoes = parseObsidianRecipeMarkdown(raw, 'potatoes.md', 'Recipes/potatoes.md');
    const before = serializeRecipeToObsidianMarkdown(potatoes);
    const presentation = resolveRecipeNutritionPresentation(potatoes);
    expect(presentation.stale_reasons).toContain('quantity_conflict');
    expect(presentation.advanced_complete).toBe(false);
    expect(deriveAdvancedCompactNutrition(presentation)?.calories).toBeUndefined();
    expect(serializeRecipeToObsidianMarkdown(potatoes)).toBe(before);
    const adapted = adaptRecipe(potatoes); if (!adapted.ok) throw adapted;
    const analysis = analyzeRecipe(session, adapted.recipe.adapted, 4);
    const potato = analysis.preview!.ingredients[4];
    expect(potato.resolved_grams).toBeCloseTo(2.5 * 453.59237, 5);
    const basic = calculateBasicNutrition({ingredients: potatoes.ingredients, servings: 4}, session);
    expect(basic.coverage.resolved).toBe(6);
    expect(basic.totals.calories).toBeGreaterThan(2500);
    expect(basic.totals.calories).toBeLessThan(3000);
    const hydrated = hydrateWorkingReview({session, adapted:adapted.recipe.adapted, rows:buildReviewRows(session, adapted.recipe.adapted), savedBlock:presentation.advanced!});
    const state = {...INITIAL_PHASE4_STATE, rows:buildReviewRows(session, adapted.recipe.adapted), ...hydrated, baseServings:4};
    const result = session.calculate(buildCalculationRequest(adapted.recipe.adapted, state));
    if (!result.ok) throw result;
    expect(result.preview.ingredients[4].resolved_grams).toBeCloseTo(2.5 * 453.59237, 5);
  }, 30000);

  it('reports actual authored enchiladas and guacamole coverage without AI', () => {
    const enchiladas = parseObsidianRecipeMarkdown(authored, 'enchiladas-verdes.md', 'Recipes/enchiladas-verdes.md');
    expect(enchiladas.ingredients).toHaveLength(12);
    expect(isPartialMachineNutrition(enchiladas.nutrition)).toBe(true);
    for (const r of [enchiladas, recipe(GUAC)]) {
      const e = calculateBasicNutrition({ ingredients: r.ingredients, servings: r.servings }, session);
      expect(e.coverage.resolved).toBe(r === enchiladas ? 9 : 7);
      expect(e.lines.filter(l => l.status === 'unresolved').every(l => !!l.reason)).toBe(true);
      if (!e.coverage.complete) {
        expect(e.totals.calories).toBeNull();
        expect(basicEstimateToNutrition(e)).toBeNull();
        const partial = basicEstimateToNutrition(e, { allowPartial: true });
        expect(partial?.confidenceNote).toMatch(/PARTIAL/);
        expect(partial?.calories).toBe(e.knownSubtotal?.calories ?? undefined);
      }
      expect(e.knownSubtotal!.calories).toBeGreaterThan(0);
    }
  }, 30000);
  it('never offers separated meat for eggs; resolves butter from an actual tbsp portion', () => {
    const a = adaptRecipe(recipe(['4 eggs, separated', '6 tbsp unsalted butter']));
    if (!a.ok) throw a;
    const r = analyzeRecipe(session, a.recipe.adapted, 6);
    expect(r.rows[0].candidates.length).toBeGreaterThan(0);
    expect(r.rows[0].candidates.every(c => !/mechanically|lamb|pork|beef/i.test(c.description))).toBe(true);
    expect(r.preview!.ingredients[0].resolved_grams).toBe(200);
    expect(r.preview!.ingredients[1].resolved_grams).toBeCloseTo(85.2, 6);
    expect(r.preview!.ingredients[1].mass_source).toBe('source_portion');
  });
  it('keeps identity constraints and missing major ingredients unknown; retains genuine source zero', () => {
    for (const text of ['100 g cooked rice','100 g raw chicken','100 g unsalted butter','100 g lime juice']) {
      const a = adaptRecipe(recipe([text])); if (!a.ok) throw a;
      const review = session.reviewIngredient(a.recipe.adapted[0].ingredient);
      if ('candidates' in review) expect(review.candidates.every(c => !/mechanically/i.test(c.description))).toBe(true);
    }
    for (const text of ['100 g lime', '100 g lime juice']) {
      const a=adaptRecipe(recipe([text]));if(!a.ok)throw a;
      const review=session.reviewIngredient(a.recipe.adapted[0].ingredient);
      const candidates='candidates' in review ? review.candidates : [];
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every(c => /juice/i.test(c.description) === text.includes('juice'))).toBe(true);
    }
    const e = calculateBasicNutrition({ ingredients: ['3 mysterious avocados from Mars', '1/2 tsp salt'], servings: 6 }, session);
    expect(e.coverage.complete).toBe(false);
    expect(e.totals.calories).toBeNull();
    expect(basicEstimateToNutrition(e)).toBeNull();
    const salt = calculateBasicNutrition({ ingredients: ['1/2 tsp salt'] }, session);
    expect(salt.totals.calories).toBe(0);
  });
  it('calculates additional ordinary recipes from catalog records outside the demonstrations', () => {
    for (const lines of [ ['200 g raw carrots', '100 g raw potatoes', '2 tbsp olive oil'], ['100 g rolled oats','1 cup whole milk','2 eggs'], ['100 g raw broccoli','150 g cooked white rice','20 g unsalted butter'] ]) {
      const e = calculateBasicNutrition({ ingredients: lines, servings: 4 }, session);
      expect(e.coverage.resolved).toBeGreaterThanOrEqual(2);
      expect(e.knownSubtotal!.calories).toBeGreaterThan(0);
    }
  });
  it('runs the real Huevos Rancheros and Cochinita Pibil recipe fixtures through the production analyzer', () => {
    const huevos=parseObsidianRecipeMarkdown(readFileSync(join(__dirname,'../fixtures/nutritionRepairHuevosRancheros.md'),'utf8'),'huevos-rancheros.md','Recipes/huevos-rancheros.md');
    const cochinita=parseObsidianRecipeMarkdown(readFileSync(join(__dirname,'../fixtures/nutritionRepairCochinitaPibil.md'),'utf8'),'cochinita-pibil.md','Recipes/cochinita-pibil.md');
    const huevosBasic=calculateBasicNutrition({ingredients:huevos.ingredients,servings:huevos.servings},session);
    const cochinitaBasic=calculateBasicNutrition({ingredients:cochinita.ingredients,servings:cochinita.servings},session);
    const adapted=adaptRecipe(cochinita);if(!adapted.ok)throw adapted;
    const cochinitaAnalysis=analyzeRecipe(session,adapted.recipe.adapted,cochinita.servings);
    expect(huevos.ingredients).toHaveLength(10);
    expect(cochinita.ingredients).toHaveLength(12);
    expect(huevosBasic.coverage.resolved).toBeGreaterThanOrEqual(8);
    expect(cochinitaBasic.coverage.resolved).toBe(5);
    // Raw shoulder mass is valid, but USDA's lean-only vs lean-and-fat cut
    // records materially disagree and the authored line does not choose one.
    expect(cochinitaBasic.lines[0].status).toBe('unresolved');
    expect(cochinitaAnalysis.rows[0].selected_fdc_id).toBeUndefined();
    expect(cochinitaAnalysis.rows[0].candidates.some(candidate=>/lean only/i.test(candidate.description))).toBe(true);
    expect(cochinitaAnalysis.rows[0].candidates.some(candidate=>/lean and fat/i.test(candidate.description))).toBe(true);
    for (const [text,expected,forbidden] of [
      ['100 g raw pork shoulder, separable lean only','lean only','lean and fat'],
      ['100 g raw pork shoulder, separable lean and fat','lean and fat','lean only'],
    ] as const) {
      const explicit=adaptRecipe(recipe([text]));if(!explicit.ok)throw explicit;
      const explicitAnalysis=analyzeRecipe(session,explicit.recipe.adapted,1);
      const descriptions=explicitAnalysis.rows[0].candidates.map(candidate=>candidate.description);
      expect(descriptions.some(description=>new RegExp(expected,'i').test(description))).toBe(true);
      expect(descriptions.every(description=>!new RegExp(forbidden,'i').test(description))).toBe(true);
    }
    // Sour orange remains an authored VOLUME. USDA has only generic orange
    // juice candidates here, so no source portion is silently accepted.
    expect(cochinitaAnalysis.rows[2].candidates.some(candidate=>/orange juice/i.test(candidate.description))).toBe(true);
    expect(cochinitaBasic.lines[2].status).toBe('unresolved');
    expect(adapted.recipe.adapted[2].ingredient).toMatchObject({unit:'cup',amount:0.5});
    expect(cochinitaAnalysis.rows[3].candidates.some(candidate=>/vinegar/i.test(candidate.description))).toBe(true);
    expect(cochinitaAnalysis.rows[1].candidates.every(candidate=>!/almond/i.test(candidate.description))).toBe(true);
    expect(cochinitaBasic.lines[11].basis).toBe('estimated_quantity');
    expect(cochinitaBasic.lines[11].note).toMatch(/Estimated quantity/);
    expect(cochinitaAnalysis.rows[8].candidates.every(candidate=>!/banana fruit|plantain/i.test(candidate.description))).toBe(true);
  },30000);
  it('scales authored ingredient quantities separately from the serving denominator', () => {
    const original=['4 eggs, separated','6 tbsp unsalted butter','1 cup whole milk'];
    const base=calculateBasicNutrition({ingredients:original,servings:6},session);
    const denominatorOnly=calculateBasicNutrition({ingredients:original,servings:8},session);
    expect(denominatorOnly.totals).toEqual(base.totals);
    const scaled=calculateBasicNutrition({ingredients:original.map(line=>scaleIngredientText(line,6,12)),servings:12},session);
    for(const key of ['calories','protein','carbohydrates','fat'] as const)expect(scaled.totals[key]!).toBeCloseTo(base.totals[key]!*2,5);
    expect(calculateBasicNutrition({ingredients:original,servings:6},session).totals).toEqual(base.totals);
  });
  it('persists accepted estimates through Apply, real Markdown, parse, and reauthenticated hydration', async () => {
    const r = recipe(['1 roma tomato', '6 tbsp unsalted butter', '2 corn tortillas']);
    const a = adaptRecipe(r); if (!a.ok) throw a;
    const analysis = analyzeRecipe(session, a.recipe.adapted, 6);
    let state = phase4Reducer(INITIAL_PHASE4_STATE, { type:'initialize', recipeKey:a.recipe.recipe_key, sessionIdentity:phase4SessionIdentity(session.metadata()), rows:buildReviewRows(session,a.recipe.adapted), baseServings:6 });
    state = phase4Reducer(state, { type:'apply_analysis', matches:analysis.matches, portions:analysis.portions, countPortions:analysis.countPortions, householdPortions:analysis.householdPortions, preview:analysis.preview });
    const countEntry = a.recipe.adapted[2], countRow = analysis.rows[2], countMatch = analysis.matches[countEntry.line_ref];
    const countReview = session.reviewCountPortions(countEntry.ingredient, countRow.selected_fdc_id!, {unit:null,size:'medium'});
    if(!countReview.ok || !countMatch)throw countReview;
    const countBuilt = buildCountPortionChoice(session,{lineRef:countEntry.line_ref,ingredient:countEntry.ingredient,review:countRow.review,
      selection:{kind:'candidate',fdc_id:countMatch.fdc_id,review_digest:countMatch.review_digest},automaticSelection:true,
      fdcId:countMatch.fdc_id,portionIndex:countReview.review.candidates[0].index,countRequirementHint:{unit:null,size:'medium'}});
    if(!countBuilt.ok)throw countBuilt;
    state=phase4Reducer(state,{type:'select_count_portion',lineRef:countEntry.line_ref,choice:countBuilt.choice});
    const e = analysis.preview!.ingredients[0];
    const snapshot = buildAiEstimateUiSnapshot(e.line_ref,analysis.rows[0],state.matches[e.line_ref]);
    const accepted=acceptAiEstimateOffer({line_ref:e.line_ref,label:AI_ESTIMATE_OFFER_LABEL,lower_grams:50,upper_grams:80,representative_grams:65,representative_policy:'midpoint'}, {
      currentState:state,offerFingerprint:workingChoiceFingerprint(state,e.line_ref),offerSnapshotBinding:aiEstimateSnapshotBinding(snapshot),snapshot,
      evidence:{line_ref:e.line_ref,fdc_id:e.fdc_id!,record_digest:e.record_digest!,ingredient_identity_digest:e.ingredient_identity_digest,bundle_release:lock.bundle_release},
    });
    if(!accepted.ok)throw accepted;
    const built={selection:accepted.choice.selection};
    state=phase4Reducer(state,{type:'select_ai_estimate',lineRef:e.line_ref,choice:accepted.choice});
    const calc = session.calculate(buildCalculationRequest(a.recipe.adapted,state)); if (!calc.ok) throw calc;
    state = phase4Reducer(state, {type:'preview_succeeded',seq:state.operationSeq,recipeKey:state.recipeKey!,preview:calc.preview});
    let markdown = ''; let writes=0;
    const result = await applyAdvancedNutrition({ session,recipe:r,state, write:async (saved:ObsidianRecipe)=>{writes++;markdown=serializeRecipeToObsidianMarkdown(saved);},readBack:async()=>markdown });
    expect(result, JSON.stringify(result)).toMatchObject({ok:true}); expect(writes).toBe(1);
    const reopened=parseObsidianRecipeMarkdown(markdown,r.fileName,r.filePath);
    const decoded=decodeCodexNutrition(reopened.codexNutrition); expect(decoded.kind).toBe('v4'); if(decoded.kind!=='v4')throw decoded;
    expect(decoded.value.ingredients[0]).toMatchObject({conversion_basis:'estimated_quantity',quantity_estimate:{provenance:'ai_estimate',lower_grams:50,upper_grams:80,representative_grams:65}});
    const b=adaptRecipe(reopened);if(!b.ok)throw b;
    const h=hydrateWorkingReview({session,adapted:b.recipe.adapted,rows:buildReviewRows(session,b.recipe.adapted),savedBlock:decoded.value});
    expect(h?.aiEstimates[e.line_ref]?.representative_grams).toBe(65);
    expect(h?.userMasses[e.line_ref]).toBeUndefined();
    expect(h?.countPortions[countEntry.line_ref]?.countRequirementHint).toEqual({unit:null,size:'medium'});
    let restored=phase4Reducer(INITIAL_PHASE4_STATE,{type:'initialize',recipeKey:b.recipe.recipe_key,sessionIdentity:phase4SessionIdentity(session.metadata()),rows:buildReviewRows(session,b.recipe.adapted),baseServings:6});
    restored=phase4Reducer(restored,{type:'hydrate',...h!});
    const reCalc=session.calculate(buildCalculationRequest(b.recipe.adapted,restored));if(!reCalc.ok)throw reCalc;
    expect(reCalc.preview.ingredients[0].mass_source).toBe('ai_estimate');
    expect(reCalc.preview.totals.calories).toEqual(calc.preview.totals.calories);
    const stale=await applyAdvancedNutrition({session,recipe:{...r,ingredients:[parseIngredientLine('2 roma tomatoes'),r.ingredients[1]]},state,write:async()=>{writes++;}});
    expect(stale.ok).toBe(false);expect(writes).toBe(1);
    const changedRange={...state,aiEstimates:{...state.aiEstimates,[e.line_ref]:{...state.aiEstimates![e.line_ref],selection:{...built.selection,lower_grams:55,upper_grams:75}}}};
    const changed=await applyAdvancedNutrition({session,recipe:r,state:changedRange,write:async()=>{writes++;}});
    expect(changed.ok).toBe(false);expect(writes).toBe(1);
    const forged=structuredClone(decoded.value);forged.ingredients[0].quantity_estimate={...forged.ingredients[0].quantity_estimate!,upper_grams:10000};
    expect(decodeCodexNutrition(forged).kind).toBe('malformed');
  });
});
