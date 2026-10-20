/**
 * Validated, model-authored nutrient contributions. These values are estimates
 * and deliberately carry no USDA identity, FDC id, source release, or portion
 * authority. Callers must bind them to the current recipe line set before use.
 */
import { NUTRIENT_IDS, NUTRIENT_REGISTRY, type NutrientId } from './nutrients';
import { isValidNutrientAmount, type CanonicalUnit } from './units';
import type { AdvisoryNutritionPreview, NutrientTotalResult } from './calculation/types';

export const AI_NUTRITION_CONTRIBUTION_VERSION = 'ai_nutrition_contribution_v1' as const;
export const MAX_AI_NUTRITION_LINES = 200;
export const MAX_AI_NUTRITION_ASSUMPTION_LENGTH = 500;

export interface AiNutrientContribution {
  readonly line_ref: string;
  readonly ingredient: string;
  readonly quantity_basis: string;
  readonly weight_grams?: number;
  /** Excluded cooking materials are review dispositions, never consumed foods. */
  readonly disposition: 'edible' | 'excluded';
  readonly exclusion_role: 'none' | 'cooking_wrapper';
  readonly exclusion_assumption: string;
  readonly classification: 'ai_estimate' | 'source_backed';
  readonly nutrients: Readonly<Partial<Record<NutrientId, { readonly amount: number; readonly unit: CanonicalUnit }>>>;
  readonly unknown_nutrients: readonly NutrientId[];
  readonly assumptions: readonly string[];
  readonly confidence: 'low' | 'medium' | 'high';
  readonly sources: readonly { readonly title: string; readonly url: string }[];
}

export interface AiContributionRecipeBinding {
  readonly recipe_digest: string;
  readonly line_refs: readonly string[];
  /** Exact authored ingredient text and instructions are required to authorize exclusions. */
  readonly line_text_by_ref?: Readonly<Record<string, string>>;
  readonly instructions?: readonly string[];
  readonly requireExclusionContext?: boolean;
}

const DEFINITIONS = new Map(Object.values(NUTRIENT_REGISTRY).map((item) => [item.id, item]));
const MAX_SOURCES = 8;
const MAX_SOURCE_TITLE = 160;
const MAX_SOURCE_URL = 1000;

/** A line can contribute to coverage only when at least one known nutrient is present. */
export function hasUsableAiNutrientValue(contribution: AiNutrientContribution): boolean {
  if (contribution.disposition === 'excluded') return false;
  return Object.entries(contribution.nutrients).some(([id, value]) =>
    DEFINITIONS.has(id as NutrientId) && value !== undefined && Number.isFinite(value.amount) && value.amount >= 0
  );
}

const WRAPPER_MATERIAL = /\b(?:banana\s+leaves?|corn\s+husks?|parchment(?:\s+paper)?|aluminum\s+foil|tin\s+foil|foil|cheesecloth)\b/i;
const WRAPPER_ACTION = /\b(?:line|lined|lining|wrap|wrapped|wrapping|cover|covered|covering|enclose|enclosed|enclosing)\b/i;
const COOKING_CONTEXT = /\b(?:roast|roasted|bake|baked|steam|steamed|cook|cooked|pan|oven|pot)\b/i;
const EXPLICITLY_UNSERVED = /\b(?:not\s+(?:eaten|served|consumed)|discard(?:ed)?|remove(?:d)?\s+before\s+serving|cooking\s+wrapper\s+only)\b/i;

/** Conservative recipe-context check for an explicitly declared cooking wrapper. */
export function supportsCookingWrapperExclusion(lineText: string, instructions: readonly string[], assumption: string): boolean {
  if (!WRAPPER_MATERIAL.test(lineText) || !EXPLICITLY_UNSERVED.test(assumption)) return false;
  const material = lineText.match(WRAPPER_MATERIAL)?.[0];
  if (!material) return false;
  const escaped = material.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namedMaterial = new RegExp(`\\b${escaped.replace(/s?$/i, 's?')}\\b`, 'i');
  return instructions.some((step) => namedMaterial.test(step) && WRAPPER_ACTION.test(step) && COOKING_CONTEXT.test(step) && !/\b(?:serve|eat|consume)\b/i.test(step));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** Validates untrusted provider output against the current recipe's exact lines. */
export function validateAiNutrientContributions(
  raw: unknown,
  binding: AiContributionRecipeBinding,
): { readonly ok: true; readonly contributions: readonly AiNutrientContribution[] } | { readonly ok: false; readonly code: string } {
  if (!boundedString(binding.recipe_digest, 128) || !Array.isArray(binding.line_refs) || binding.line_refs.length > MAX_AI_NUTRITION_LINES) return { ok: false, code: 'invalid_binding' };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_AI_NUTRITION_LINES) return { ok: false, code: 'invalid_contributions' };
  const allowed = new Set(binding.line_refs);
  const seen = new Set<string>();
  const result: AiNutrientContribution[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, code: 'invalid_contribution' };
    const row = item as Record<string, unknown>;
    const ref = row.line_ref;
    if (!boundedString(ref, 500)) return { ok: false, code: 'missing_line_ref' };
    if (!allowed.has(ref)) return { ok: false, code: 'unknown_line_ref' };
    if (seen.has(ref)) return { ok: false, code: 'duplicate_line_ref' };
    if (!boundedString(row.ingredient, 200) || !boundedString(row.quantity_basis, 200)) return { ok: false, code: 'invalid_identity_or_basis' };
    const authoredLine = binding.line_text_by_ref?.[ref];
    if (authoredLine !== undefined && row.ingredient.trim() !== authoredLine.trim()) return { ok: false, code: 'line_text_mismatch' };
    // Legacy positive-weight AI rows predate the explicit disposition fields;
    // they remain edible. A zero weight never receives this compatibility default.
    const disposition = row.disposition ?? (row.weight_grams === 0 ? undefined : 'edible');
    const exclusionRole = row.exclusion_role ?? 'none';
    const exclusionAssumption = row.exclusion_assumption ?? '';
    if (disposition !== 'edible' && disposition !== 'excluded') return { ok: false, code: 'invalid_disposition' };
    if (exclusionRole !== 'none' && exclusionRole !== 'cooking_wrapper') return { ok: false, code: 'invalid_exclusion_role' };
    if (typeof exclusionAssumption !== 'string' || exclusionAssumption.length > MAX_AI_NUTRITION_ASSUMPTION_LENGTH) return { ok: false, code: 'invalid_exclusion_assumption' };
    if (row.classification !== 'ai_estimate' && row.classification !== 'source_backed') return { ok: false, code: 'invalid_classification' };
    if (row.weight_grams !== undefined && (typeof row.weight_grams !== 'number' || !Number.isFinite(row.weight_grams) || row.weight_grams < 0 || row.weight_grams > 1_000_000)) return { ok: false, code: 'invalid_weight' };
    if (row.confidence !== 'low' && row.confidence !== 'medium' && row.confidence !== 'high') return { ok: false, code: 'invalid_confidence' };
    if (!Array.isArray(row.assumptions) || row.assumptions.length > 12 || row.assumptions.some((s) => !boundedString(s, MAX_AI_NUTRITION_ASSUMPTION_LENGTH))) return { ok: false, code: 'invalid_assumptions' };
    if (!Array.isArray(row.unknown_nutrients) || row.unknown_nutrients.some((n) => !NUTRIENT_IDS.includes(n as NutrientId))) return { ok: false, code: 'invalid_unknown_nutrients' };
    if (!row.nutrients || typeof row.nutrients !== 'object' || Array.isArray(row.nutrients)) return { ok: false, code: 'invalid_nutrients' };
    const nutrients: Partial<Record<NutrientId, { amount: number; unit: CanonicalUnit }>> = {};
    for (const [key, value] of Object.entries(row.nutrients as Record<string, unknown>)) {
      const definition = DEFINITIONS.get(key as NutrientId);
      if (!definition || !value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'unknown_nutrient' };
      const nutrient = value as Record<string, unknown>;
      if (!isValidNutrientAmount(nutrient.amount) || nutrient.unit !== definition.unit) return { ok: false, code: 'invalid_nutrient_value' };
      nutrients[key as NutrientId] = { amount: nutrient.amount, unit: definition.unit };
    }
    if (disposition === 'excluded') {
      if (row.classification !== 'ai_estimate' || exclusionRole !== 'cooking_wrapper' || !boundedString(exclusionAssumption, MAX_AI_NUTRITION_ASSUMPTION_LENGTH) || row.weight_grams !== 0 || nutrients.calories?.amount !== 0 || Object.values(nutrients).some((n) => n.amount !== 0) || row.unknown_nutrients.length !== 0) return { ok: false, code: 'invalid_zero_weight' };
      const lineText = authoredLine;
      if (binding.requireExclusionContext !== false && (!lineText || !binding.instructions || !supportsCookingWrapperExclusion(lineText, binding.instructions, exclusionAssumption))) return { ok: false, code: 'unsupported_exclusion' };
    } else if (exclusionRole !== 'none' || exclusionAssumption !== '' || row.weight_grams === 0) {
      return { ok: false, code: 'invalid_zero_weight' };
    }
    const unknown = new Set(row.unknown_nutrients as NutrientId[]);
    if (Object.keys(nutrients).some((id) => unknown.has(id as NutrientId))) return { ok: false, code: 'known_and_unknown_overlap' };
    if (!Array.isArray(row.sources) || row.sources.length > MAX_SOURCES) return { ok: false, code: 'invalid_sources' };
    const sources: { title: string; url: string }[] = [];
    for (const source of row.sources) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) return { ok: false, code: 'invalid_source' };
      const s = source as Record<string, unknown>;
      if (!boundedString(s.title, MAX_SOURCE_TITLE) || !boundedString(s.url, MAX_SOURCE_URL)) return { ok: false, code: 'invalid_source' };
      let url: URL;
      try { url = new URL(s.url); } catch { return { ok: false, code: 'invalid_source_url' }; }
      if (url.protocol !== 'https:' || url.username || url.password) return { ok: false, code: 'invalid_source_url' };
      sources.push({ title: s.title, url: url.toString() });
    }
    if (row.classification === 'source_backed' && sources.length === 0) return { ok: false, code: 'source_missing' };
    if (row.classification === 'ai_estimate' && sources.length > 0 && !row.assumptions.length) return { ok: false, code: 'estimate_assumption_missing' };
    seen.add(ref);
    result.push(Object.freeze({
      line_ref: ref, ingredient: row.ingredient, quantity_basis: row.quantity_basis,
      ...(row.weight_grams !== undefined ? { weight_grams: row.weight_grams as number } : {}),
      disposition,
      exclusion_role: exclusionRole,
      exclusion_assumption: exclusionAssumption,
      classification: row.classification, nutrients: Object.freeze(nutrients),
      unknown_nutrients: Object.freeze([...new Set(row.unknown_nutrients as NutrientId[])]),
      assumptions: Object.freeze([...(row.assumptions as string[])]), confidence: row.confidence,
      sources: Object.freeze(sources),
    }));
  }
  return { ok: true, contributions: Object.freeze(result) };
}

/** Sums trusted line contributions; omitted nutrients stay unknown, explicit 0 stays known. */
export function sumAiNutrientContributions(contributions: readonly AiNutrientContribution[]) {
  const sums: Partial<Record<NutrientId, number>> = {};
  const counts: Partial<Record<NutrientId, number>> = {};
  for (const row of contributions) {
    if (row.disposition === 'excluded') continue;
    for (const [id, nutrient] of Object.entries(row.nutrients)) {
    const key = id as NutrientId;
    sums[key] = (sums[key] ?? 0) + nutrient.amount;
    counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return Object.freeze(Object.fromEntries(Object.entries(sums).map(([id, amount]) => [id, Object.freeze({
    amount: Math.round((amount as number) * 1_000_000) / 1_000_000,
    unit: DEFINITIONS.get(id as NutrientId)?.unit,
    covered_ingredient_count: counts[id as NutrientId] ?? 0,
  })])));
}

/** Per-serving AI values are always derived from unrounded recipe totals. */
export function aiNutrientPerServing(
  contributions: readonly AiNutrientContribution[],
  servings: number,
) {
  if (!Number.isFinite(servings) || servings <= 0 || servings > 1000) return undefined;
  const totals = sumAiNutrientContributions(contributions) as Record<string, { amount: number; unit: CanonicalUnit; covered_ingredient_count: number }>;
  return Object.freeze(Object.fromEntries(Object.entries(totals).map(([id, value]) => [id, Object.freeze({
    amount: Math.round((value.amount / servings) * 1_000_000) / 1_000_000,
    unit: value.unit,
    covered_ingredient_count: value.covered_ingredient_count,
  })])));
}

/** Merges validated AI lines only where the source calculator has no resolved line. */
export function combineAiContributionsWithPreview(
  preview: AdvisoryNutritionPreview,
  contributions: readonly AiNutrientContribution[],
): AdvisoryNutritionPreview {
  const sourceResolved = new Set(preview.ingredients.filter((row) => row.outcome === 'calculated').map((row) => row.line_ref));
  const accepted = contributions.filter((row) => !sourceResolved.has(row.line_ref));
  const selected = accepted.filter((row) => hasUsableAiNutrientValue(row));
  const excludedRefs = new Set(accepted.filter((row) => row.disposition === 'excluded').map((row) => row.line_ref));
  const contributionTotals = sumAiNutrientContributions(selected) as Record<string, { amount: number; unit: CanonicalUnit; covered_ingredient_count: number }>;
  const totals: Partial<Record<NutrientId, NutrientTotalResult>> = { ...preview.totals };
  for (const id of preview.nutrient_scope) {
    const ai = contributionTotals[id];
    const base = preview.totals[id];
    const aiCovered = ai?.covered_ingredient_count ?? 0;
    if (!base && !ai) continue;
    // The deterministic preview's denominator already counts unresolved recipe
    // lines. An AI contribution changes their coverage disposition; it must not
    // append those same ingredient lines to the denominator a second time.
    const measurable = base?.measurable_ingredient_count ?? aiCovered;
    if (measurable === 0 && (base?.covered_ingredient_count ?? 0) + aiCovered === 0) continue;
    const covered = (base?.covered_ingredient_count ?? 0) + aiCovered;
    const amount = (base?.amount ?? 0) + (ai?.amount ?? 0);
    totals[id] = {
      amount: Math.round(amount * 1_000_000) / 1_000_000,
      unit: base?.unit ?? ai?.unit ?? 'g',
      covered_ingredient_count: covered,
      measurable_ingredient_count: measurable,
      coverage: measurable === 0 ? 0 : covered / measurable,
      status: measurable > 0 && covered === measurable ? 'complete' : 'partial',
    };
  }
  const aiRefs = new Set(selected.map((row) => row.line_ref));
  const unresolved = preview.unresolved.filter((row) => !aiRefs.has(row.line_ref) && !excludedRefs.has(row.line_ref));
  const scopedNutrients = new Set(preview.nutrient_scope);
  const hasUnknownAiNutrients = selected.some((row) => row.unknown_nutrients.some((id) => scopedNutrients.has(id)));
  const hasIncompleteScopedTotals = preview.nutrient_scope.some((id) => {
    const total = totals[id];
    return total === undefined || total.status !== 'complete' || total.coverage !== 1;
  });
  const status = unresolved.length === 0
    ? hasUnknownAiNutrients || hasIncompleteScopedTotals ? 'partial' : 'complete'
    : selected.length > 0 || preview.status === 'partial' ? 'partial' : 'unresolved';
  return Object.freeze({
    ...preview,
    totals: Object.freeze(totals),
    ai_contributions: Object.freeze(accepted.filter((row) => selected.includes(row) || excludedRefs.has(row.line_ref))),
    unresolved: Object.freeze(unresolved),
    status,
  });
}
