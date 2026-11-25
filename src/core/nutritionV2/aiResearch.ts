/**
 * The Kitchen Codex — AI nutrition web-research contract.
 *
 * PURE, platform-neutral, provider-free. This module owns the bounded request /
 * response shapes and the DETERMINISTIC quantity scaling used when an external
 * source reports nutrition on a published basis (per 100 g or per labeled
 * serving). It never fetches a URL and never treats a source URL as proof by
 * itself: the server must have retrieved the page before the extraction model
 * may cite it.
 *
 * SOURCE-BACKED VS ESTIMATED
 *   - A `source_backed` contribution must carry a fetched, provider-grounded URL.
 *   - A source reporting per 100 g can support a mass target only when the
 *     authored quantity has a deterministic gram amount.
 *   - A source serving can support a volume/count target only when the labeled
 *     serving unit/amount matches the authored unit/amount.
 *   - Anything else remains unresolved. No density, serving weight or nutrient
 *     value is invented.
 */

import { NUTRIENT_IDS, NUTRIENT_REGISTRY, type NutrientId } from './nutrients';
import { isValidNutrientAmount, type CanonicalUnit } from './units';
import { canonicalStringify, sha256Hex } from './usda/digest';
import type { AiNutrientContribution } from './aiContribution';

export const AI_RESEARCH_REQUEST_VERSION = 'nutrition_ai_web_research_request_v1' as const;
export const AI_RESEARCH_RESPONSE_VERSION = 'nutrition_ai_web_research_response_v1' as const;
export const MAX_RESEARCH_TARGETS = 3;
export const MAX_RESEARCH_SOURCES = 3;
export const MAX_RESEARCH_EVIDENCE = 3;
export const MAX_RESEARCH_INGREDIENT_TEXT = 300;
export const MAX_RESEARCH_SOURCE_TEXT = 14_000;
export const MAX_RESEARCH_ASSUMPTION = 300;
export const MAX_RESEARCH_NUTRIENTS = 34;
export const MAX_RESEARCH_SCALE = 100_000;

export type ResearchMeasurementKind = 'mass' | 'volume' | 'count' | 'unknown';
export type ResearchAmbiguity = 'missing_information' | 'identity_ambiguous';

export interface ResearchTarget {
  readonly line_ref: string;
  readonly ingredient_text: string;
  readonly amount: number | null;
  readonly unit: string | null;
  readonly measurement_kind: ResearchMeasurementKind;
  readonly quantity_grams?: number;
  readonly quantity_ml?: number;
  readonly ambiguity: ResearchAmbiguity;
}

export interface ResearchTargetSanitizeResult {
  readonly ok: boolean;
  readonly targets: ReadonlyArray<ResearchTarget>;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || CONTROL.test(trimmed)) return undefined;
  return trimmed;
}

function finitePositive(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || Object.is(value, -0)) return undefined;
  return value;
}

function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Object.is(value, -0)) return undefined;
  return value;
}

export function sanitizeResearchTargets(raw: unknown): ReadonlyArray<ResearchTarget> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const out: ResearchTarget[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_RESEARCH_TARGETS) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const lineRef = boundedText(row.line_ref, 200);
    const ingredientText = boundedText(row.ingredient_text, MAX_RESEARCH_INGREDIENT_TEXT);
    if (!lineRef || !ingredientText || seen.has(lineRef)) continue;
    const amount = row.amount === null || row.amount === undefined ? null : finiteNonNegative(row.amount);
    if (row.amount !== null && row.amount !== undefined && amount === undefined) continue;
    const unit = row.unit === null || row.unit === undefined ? null : boundedText(row.unit, 60);
    if (row.unit !== null && row.unit !== undefined && unit === undefined) continue;
    const measurement = row.measurement_kind;
    if (measurement !== 'mass' && measurement !== 'volume' && measurement !== 'count' && measurement !== 'unknown') continue;
    const quantityGrams = row.quantity_grams === undefined ? undefined : finitePositive(row.quantity_grams);
    if (row.quantity_grams !== undefined && quantityGrams === undefined) continue;
    const quantityMl = row.quantity_ml === undefined ? undefined : finitePositive(row.quantity_ml);
    if (row.quantity_ml !== undefined && quantityMl === undefined) continue;
    const ambiguity = row.ambiguity;
    if (ambiguity !== 'missing_information' && ambiguity !== 'identity_ambiguous') continue;
    seen.add(lineRef);
    out.push(Object.freeze({
      line_ref: lineRef,
      ingredient_text: ingredientText,
      amount,
      unit,
      measurement_kind: measurement,
      ...(quantityGrams !== undefined ? { quantity_grams: quantityGrams } : {}),
      ...(quantityMl !== undefined ? { quantity_ml: quantityMl } : {}),
      ambiguity,
    }));
  }
  return Object.freeze(out);
}

export interface ResearchSource {
  readonly title: string;
  readonly url: string;
}

export interface ResearchBasis {
  readonly kind: 'per_100_g' | 'per_serving';
  readonly serving_amount?: number;
  readonly serving_unit?: string;
  readonly serving_grams?: number;
}

export interface ResearchNutrient {
  readonly id: NutrientId;
  readonly amount: number;
  readonly unit: CanonicalUnit;
}

export interface ResearchEvidence {
  readonly line_ref: string;
  readonly source_url: string;
  readonly source_title: string;
  readonly food_identity: string;
  readonly basis: ResearchBasis;
  readonly nutrients: ReadonlyArray<ResearchNutrient>;
  readonly confidence: 'low' | 'medium' | 'high';
  readonly assumptions: ReadonlyArray<string>;
  readonly limitations: ReadonlyArray<string>;
}

export interface ResearchExtractionSanitizeResult {
  readonly ok: boolean;
  readonly evidence: ReadonlyArray<ResearchEvidence>;
  readonly code?: string;
}

const EVIDENCE_KEYS = new Set([
  'line_ref',
  'source_url',
  'source_title',
  'food_identity',
  'basis',
  'nutrients',
  'confidence',
  'assumptions',
  'limitations',
]);
const BASIS_KEYS = new Set(['kind', 'serving_amount', 'serving_unit', 'serving_grams']);
const NUTRIENT_KEYS = new Set(['id', 'amount', 'unit']);

function sameUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    if (left.protocol !== 'https:' || right.protocol !== 'https:') return false;
    left.hash = '';
    right.hash = '';
    return left.toString() === right.toString();
  } catch {
    return false;
  }
}

/**
 * Strictly reads the extraction model's evidence. A citation is accepted ONLY
 * when its URL is one of the pages the server actually retrieved for this run.
 */
export function sanitizeResearchEvidence(
  raw: unknown,
  allowedLineRefs: ReadonlySet<string>,
  fetchedSources: ReadonlyArray<ResearchSource>
): ResearchExtractionSanitizeResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, evidence: [], code: 'invalid_response' };
  const entries = (raw as Record<string, unknown>).evidence;
  if (!Array.isArray(entries) || entries.length > MAX_RESEARCH_EVIDENCE) {
    return { ok: false, evidence: [], code: 'invalid_response' };
  }
  const out: ResearchEvidence[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, evidence: [], code: 'invalid_response' };
    const row = item as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (!EVIDENCE_KEYS.has(key)) return { ok: false, evidence: [], code: 'invalid_response' };
    }
    const lineRef = boundedText(row.line_ref, 200);
    if (!lineRef || !allowedLineRefs.has(lineRef) || seen.has(lineRef)) {
      return { ok: false, evidence: [], code: 'invalid_line_ref' };
    }
    seen.add(lineRef);
    const sourceUrl = boundedText(row.source_url, 1000);
    if (!sourceUrl) return { ok: false, evidence: [], code: 'invalid_source' };
    const source = fetchedSources.find((entry) => sameUrl(entry.url, sourceUrl));
    if (!source) return { ok: false, evidence: [], code: 'unfetched_source' };
    const sourceTitle = boundedText(row.source_title, 200) ?? source.title;
    const foodIdentity = boundedText(row.food_identity, 200);
    if (!foodIdentity) return { ok: false, evidence: [], code: 'invalid_identity' };
    if (!row.basis || typeof row.basis !== 'object' || Array.isArray(row.basis)) {
      return { ok: false, evidence: [], code: 'invalid_basis' };
    }
    const basisRaw = row.basis as Record<string, unknown>;
    for (const key of Object.keys(basisRaw)) {
      if (!BASIS_KEYS.has(key)) return { ok: false, evidence: [], code: 'invalid_basis' };
    }
    if (basisRaw.kind !== 'per_100_g' && basisRaw.kind !== 'per_serving') {
      return { ok: false, evidence: [], code: 'invalid_basis' };
    }
    const servingAmount = basisRaw.serving_amount === undefined ? undefined : finitePositive(basisRaw.serving_amount);
    const servingGrams = basisRaw.serving_grams === undefined ? undefined : finitePositive(basisRaw.serving_grams);
    const servingUnit = basisRaw.serving_unit === undefined ? undefined : boundedText(basisRaw.serving_unit, 30);
    if (basisRaw.serving_amount !== undefined && servingAmount === undefined) return { ok: false, evidence: [], code: 'invalid_basis' };
    if (basisRaw.serving_grams !== undefined && servingGrams === undefined) return { ok: false, evidence: [], code: 'invalid_basis' };
    if (basisRaw.serving_unit !== undefined && servingUnit === undefined) return { ok: false, evidence: [], code: 'invalid_basis' };
    if (!Array.isArray(row.nutrients) || row.nutrients.length > MAX_RESEARCH_NUTRIENTS) {
      return { ok: false, evidence: [], code: 'invalid_nutrients' };
    }
    const nutrients: ResearchNutrient[] = [];
    const nutrientIds = new Set<string>();
    for (const nutrientRaw of row.nutrients) {
      if (!nutrientRaw || typeof nutrientRaw !== 'object' || Array.isArray(nutrientRaw)) {
        return { ok: false, evidence: [], code: 'invalid_nutrients' };
      }
      const nutrient = nutrientRaw as Record<string, unknown>;
      for (const key of Object.keys(nutrient)) {
        if (!NUTRIENT_KEYS.has(key)) return { ok: false, evidence: [], code: 'invalid_nutrients' };
      }
      const id = nutrient.id;
      if (typeof id !== 'string' || !NUTRIENT_IDS.includes(id as NutrientId) || nutrientIds.has(id)) {
        return { ok: false, evidence: [], code: 'invalid_nutrients' };
      }
      nutrientIds.add(id);
      const definition = NUTRIENT_REGISTRY[id as NutrientId];
      if (!definition || !isValidNutrientAmount(nutrient.amount) || nutrient.unit !== definition.unit) {
        return { ok: false, evidence: [], code: 'invalid_nutrients' };
      }
      nutrients.push(Object.freeze({ id: id as NutrientId, amount: nutrient.amount as number, unit: definition.unit }));
    }
    if (nutrients.length === 0) return { ok: false, evidence: [], code: 'invalid_nutrients' };
    if (row.confidence !== 'low' && row.confidence !== 'medium' && row.confidence !== 'high') {
      return { ok: false, evidence: [], code: 'invalid_confidence' };
    }
    const assumptions = Array.isArray(row.assumptions)
      ? row.assumptions.map((value) => boundedText(value, MAX_RESEARCH_ASSUMPTION)).filter((value): value is string => value !== undefined)
      : [];
    const limitations = Array.isArray(row.limitations)
      ? row.limitations.map((value) => boundedText(value, MAX_RESEARCH_ASSUMPTION)).filter((value): value is string => value !== undefined)
      : [];
    if (assumptions.length > 6 || limitations.length > 6) {
      return { ok: false, evidence: [], code: 'invalid_notes' };
    }
    out.push(Object.freeze({
      line_ref: lineRef,
      source_url: source.url,
      source_title: sourceTitle,
      food_identity: foodIdentity,
      basis: Object.freeze({
        kind: basisRaw.kind,
        ...(servingAmount !== undefined ? { serving_amount: servingAmount } : {}),
        ...(servingUnit !== undefined ? { serving_unit: servingUnit } : {}),
        ...(servingGrams !== undefined ? { serving_grams: servingGrams } : {}),
      }),
      nutrients: Object.freeze(nutrients),
      confidence: row.confidence,
      assumptions: Object.freeze(assumptions),
      limitations: Object.freeze(limitations),
    }));
  }
  return { ok: true, evidence: Object.freeze(out) };
}

export interface ResearchScalingResult {
  readonly ok: boolean;
  readonly contribution?: AiNutrientContribution;
  readonly reason?: string;
}

function normalizeUnit(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase().replace(/\.$/, '');
  if (lowered === 'tablespoon' || lowered === 'tablespoons') return 'tbsp';
  if (lowered === 'teaspoon' || lowered === 'teaspoons') return 'tsp';
  if (lowered === 'cup' || lowered === 'cups') return 'cup';
  if (lowered === 'gram' || lowered === 'grams') return 'g';
  if (lowered === 'kilogram' || lowered === 'kilograms') return 'kg';
  if (lowered === 'milliliter' || lowered === 'milliliters') return 'ml';
  if (lowered === 'liter' || lowered === 'liters') return 'l';
  if (lowered === 'ounce' || lowered === 'ounces') return 'oz';
  if (lowered === 'pound' || lowered === 'pounds') return 'lb';
  return lowered.length > 0 ? lowered : undefined;
}

function scaleFactor(evidence: ResearchEvidence, target: ResearchTarget): { readonly ok: boolean; readonly factor?: number; readonly basis?: string } {
  const basis = evidence.basis;
  if (basis.kind === 'per_100_g') {
    if (target.quantity_grams === undefined || target.quantity_grams <= 0) return { ok: false };
    return { ok: true, factor: target.quantity_grams / 100, basis: `scaled from source per 100 g to ${target.quantity_grams} g` };
  }
  if (basis.serving_grams !== undefined && target.quantity_grams !== undefined && target.quantity_grams > 0) {
    return { ok: true, factor: target.quantity_grams / basis.serving_grams, basis: `scaled from ${basis.serving_grams} g source serving to ${target.quantity_grams} g` };
  }
  const targetUnit = normalizeUnit(target.unit);
  const servingUnit = normalizeUnit(basis.serving_unit);
  if (
    targetUnit !== undefined &&
    servingUnit !== undefined &&
    targetUnit === servingUnit &&
    target.amount !== null &&
    target.amount > 0 &&
    basis.serving_amount !== undefined &&
    basis.serving_amount > 0
  ) {
    return {
      ok: true,
      factor: target.amount / basis.serving_amount,
      basis: `scaled from source serving ${basis.serving_amount} ${basis.serving_unit ?? servingUnit} to ${target.amount} ${target.unit ?? targetUnit}`,
    };
  }
  return { ok: false };
}

/**
 * Converts published source evidence into one source-backed contribution for the
 * exact recipe target. The conversion is deterministic; the model never supplies
 * the final scaled amount.
 */
export function buildResearchContribution(
  evidence: ResearchEvidence,
  target: ResearchTarget,
  source: ResearchSource
): ResearchScalingResult {
  if (target.ambiguity !== 'missing_information') return { ok: false, reason: 'identity_ambiguous' };
  const scaled = scaleFactor(evidence, target);
  if (!scaled.ok || scaled.factor === undefined || !Number.isFinite(scaled.factor) || scaled.factor <= 0 || scaled.factor > MAX_RESEARCH_SCALE) {
    return { ok: false, reason: 'unsupported_quantity_basis' };
  }
  const nutrients: Partial<Record<NutrientId, { amount: number; unit: CanonicalUnit }>> = {};
  for (const nutrient of evidence.nutrients) {
    const amount = nutrient.amount * scaled.factor;
    if (!isValidNutrientAmount(amount)) return { ok: false, reason: 'invalid_scaled_nutrient' };
    nutrients[nutrient.id] = Object.freeze({
      amount: Math.round(amount * 1_000_000) / 1_000_000,
      unit: nutrient.unit,
    });
  }
  const unknown = NUTRIENT_IDS.filter((id) => nutrients[id] === undefined);
  const quantityBasis = `${target.ingredient_text} — ${scaled.basis}`.slice(0, 200);
  const assumptions = [
    ...evidence.assumptions,
    `Values transcribed from ${source.title} and scaled deterministically; verify the product label before relying on them.`,
  ].slice(0, 12).map((value) => value.slice(0, MAX_RESEARCH_ASSUMPTION));
  return {
    ok: true,
    contribution: Object.freeze({
      line_ref: target.line_ref,
      ingredient: target.ingredient_text,
      quantity_basis: quantityBasis,
      ...(target.quantity_grams !== undefined && target.quantity_grams > 0 ? { weight_grams: target.quantity_grams } : {}),
      disposition: 'edible',
      exclusion_role: 'none',
      exclusion_assumption: '',
      classification: 'source_backed',
      nutrients: Object.freeze(nutrients),
      unknown_nutrients: Object.freeze(unknown),
      assumptions: Object.freeze(assumptions),
      confidence: evidence.confidence,
      sources: Object.freeze([{ title: source.title, url: source.url }]),
    }),
  };
}

/** Stable binding over the exact research targets (line refs + authored text). */
export function researchRecipeBinding(targets: ReadonlyArray<ResearchTarget>): {
  readonly recipe_digest: string;
  readonly line_refs: ReadonlyArray<string>;
  readonly line_text_by_ref: Readonly<Record<string, string>>;
} {
  const canonical = targets.map((target) => ({
    line_ref: target.line_ref,
    ingredient_text: target.ingredient_text,
    amount: target.amount,
    unit: target.unit,
    measurement_kind: target.measurement_kind,
  }));
  return Object.freeze({
    recipe_digest: sha256Hex(canonicalStringify(canonical)),
    line_refs: Object.freeze(targets.map((target) => target.line_ref)),
    line_text_by_ref: Object.freeze(Object.fromEntries(targets.map((target) => [target.line_ref, target.ingredient_text]))),
  });
}
