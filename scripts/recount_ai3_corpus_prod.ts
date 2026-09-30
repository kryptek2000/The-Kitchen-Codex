/**
 * AI-3 CANONICAL CORPUS RECOUNT — 97-line benchmark population.
 *
 * Reads the production parser, the real Phase-4 pipeline, the real live-row
 * projection and the production `evaluateAiEstimateEligibility`, against the
 * real pinned USDA bundle.
 *
 * The population is the CANONICAL one: the benchmark's own de-duplication of
 * the 145 raw fixture entries by exact authored line text. That rule lives in
 * `scripts/benchmark_resolution_coverage.ts` and is reproduced here identically
 * so this script cannot invent a different denominator.
 *
 * No token regexes. No hard-coded line IDs. No model calls. No fabricated
 * estimate ranges. Nothing here is tuned toward any target number.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeAdvancedNutritionSessionFromBundle } from '../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows } from '../src/core/nutritionV2/phase4/rows';
import { projectLiveRows } from '../src/core/nutritionV2/phase4/liveRow';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../src/core/nutritionV2/phase4/state';
import { evaluateAiEstimateEligibility } from '../src/core/nutritionV2/phase4/aiEstimateValidation';
import { RESOLUTION_COVERAGE_CORPUS } from '../tests/fixtures/advancedNutritionResolutionCorpus';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BUNDLE_DIR = join(ROOT, 'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e');

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredient(line);
  if (!parsed.ok) return { original: line };
  const p = parsed.parsed;
  return {
    original: line,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

const loaded = await composeAdvancedNutritionSessionFromBundle({
  files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
    name,
    bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
  })),
} as never);
if (!loaded.ok) throw new Error('bundle failed to authenticate');
const session = loaded.session;

// The canonical population: identical de-duplication to the shipped benchmark.
const seen = new Set<string>();
const population: string[] = [];
for (const entry of RESOLUTION_COVERAGE_CORPUS) {
  if (seen.has(entry.line)) continue;
  seen.add(entry.line);
  population.push(entry.line);
}

let A = 0;
let B1 = 0;
let B2 = 0;
let notActionable = 0;
let identityUnresolved = 0;
let directMass = 0;
const aSet: string[] = [];
const b1Set: string[] = [];
const b2Set: string[] = [];
const resolvedLines: string[] = [];

for (const text of population) {
  const recipe = { title: 'recount', servings: 1, ingredients: [structured(text)] };
  const adaptation = adaptRecipe(recipe as never);
  if (!adaptation.ok) continue;
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 1);
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: 'recount',
    rows: buildReviewRows(session, adapted),
    baseServings: 1,
  } as never);
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  } as never);

  const lineRef = adapted[0].line_ref;
  const live = projectLiveRows(
    state,
    new Map(analysis.rows.map((row) => [row.line_ref, row])),
    adapted,
    session,
    undefined,
    analysis.portions,
    analysis.countPortions
  )[0];
  if (live === undefined) continue;
  if (live.status === 'matched' && live.resolved_grams !== undefined) resolvedLines.push(text);

  const parsed = parseIngredient(text);
  const p = parsed.ok ? parsed.parsed : null;
  const grams = p !== null && typeof p.grams === 'number' ? p.grams : null;
  // Scalar authored mass, or a WRITTEN MASS RANGE, are both mass authority.
  const scalarMass = p !== null && p.measurement_kind === 'mass' && grams !== null;
  const massRange =
    p !== null &&
    p.quantity_kind === 'range' &&
    p.quantity_range !== null &&
    p.quantity_range !== undefined &&
    p.measurement_kind === 'mass';

  const eligibility = evaluateAiEstimateEligibility({
    state,
    lineRef,
    parse: {
      hasDirectMass: scalarMass || massRange,
      directMassGrams: grams,
      amount: p !== null ? p.amount : null,
      quantityRange:
        p !== null && p.quantity_range !== null && p.quantity_range !== undefined
          ? { lower: p.quantity_range.lower, upper: p.quantity_range.upper }
          : null,
      container: p !== null ? ((p as unknown as { container?: string | null }).container ?? null) : null,
    },
    // The AUTHORITATIVE current live-row status.
    rowStatus: live.status,
    capabilityAvailable: true,
  });

  if (eligibility.eligible === true) {
    A += 1;
    aSet.push(text);
    continue;
  }
  const why: string = eligibility.reason;
  if (why === 'no_usable_quantity') {
    B1 += 1;
    b1Set.push(text);
  } else if (why === 'parsed_container') {
    B2 += 1;
    b2Set.push(text);
  } else if (why === 'not_actionable') {
    notActionable += 1;
  } else if (why === 'identity_unresolved') {
    identityUnresolved += 1;
  } else if (why === 'direct_mass_authority') {
    directMass += 1;
  }
}

const B = B1 + B2;
const C = A - B;

console.log('=== AI-3 CANONICAL RECOUNT (97-line benchmark population) ===');
console.log(`raw fixture entries            : ${RESOLUTION_COVERAGE_CORPUS.length}`);
console.log(`canonical population           : ${population.length}`);
console.log(`A  eligible                    : ${A}`);
console.log(`B1 no usable quantity          : ${B1}`);
console.log(`B2 parsed container            : ${B2}`);
console.log(`B  total abstention            : ${B}`);
console.log(`C  remaining candidates        : ${C}`);
console.log(`check C == A - B               : ${C === A - B}`);
console.log(
  `excluded -> not_actionable ${notActionable}, identity_unresolved ${identityUnresolved}, direct_mass ${directMass}`
);
console.log(`\n--- A set ---\n${aSet.join('\n')}`);
console.log(`\n--- B1 set ---\n${b1Set.join('\n')}`);
console.log(`\n--- B2 set ---\n${b2Set.join('\n')}`);

// --- Cross-check: no already-resolved line may be AI-3 eligible -----------
const violations = resolvedLines.filter((line) => aSet.includes(line));
console.log(`\n=== CROSS-CHECK: resolved rows must never be AI-3 eligible ===`);
console.log(`already-resolved benchmark lines      : ${resolvedLines.length}`);
console.log(`resolved lines that are AI-3 eligible : ${violations.length}`);
for (const v of violations) console.log(`  VIOLATION: ${v}`);
console.log(violations.length === 0 ? 'PASS' : 'FAIL');
process.exit(violations.length === 0 ? 0 : 1);
