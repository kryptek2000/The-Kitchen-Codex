/**
 * Validated, model-authored nutrient contributions. These values are estimates
 * and deliberately carry no USDA identity, FDC id, source release, or portion
 * authority. Callers must bind them to the current recipe line set before use.
 */
import { NUTRIENT_IDS, NUTRIENT_REGISTRY, isNutrientId, type NutrientId } from './nutrients';
import { isValidNutrientAmount, type CanonicalUnit } from './units';
import {
  BRANDED_ASSERTION_VERSION,
  brandedApplyAuthenticationMatches,
  computeBrandedContributionDigest,
  isBrandedApplyAuthentication,
  type BrandedApplyAuthentication,
} from './brandedEvidenceTrust';
import type { AdvisoryNutritionPreview, NutrientTotalResult } from './calculation/types';

export const AI_NUTRITION_CONTRIBUTION_VERSION = 'ai_nutrition_contribution_v1' as const;
export const MAX_AI_NUTRITION_LINES = 200;
export const MAX_AI_NUTRITION_ASSUMPTION_LENGTH = 500;

/** The exact local target that was used to scale a branded product. */
export interface AiBrandedTargetBinding {
  readonly query: string;
  readonly amount: number | null;
  readonly unit: string | null;
  readonly measurement_kind: 'mass' | 'volume' | 'count' | 'unknown';
  readonly quantity_grams?: number;
  readonly quantity_ml?: number;
}

/** A server-issued, ECDSA-signed assertion for one exact contribution. */
export interface AiBrandedVerification {
  readonly version: typeof BRANDED_ASSERTION_VERSION;
  readonly key_id: string;
  readonly signature: string;
  readonly canonical_digest: string;
  readonly recipe_digest: string;
  readonly review_identity: string;
  readonly issued_at: string;
  readonly expires_at: string;
}

/**
 * Exact USDA Branded provenance carried INSIDE the existing source-backed
 * contribution. This is deliberately not a new nutrition engine: the record is
 * external label evidence, not a member of the pinned generic USDA catalog.
 */
export interface AiUsdaBrandedProvenance {
  readonly fdc_id: number;
  readonly description: string;
  readonly brand_owner?: string;
  readonly brand_name?: string;
  readonly serving_size?: number;
  readonly serving_size_unit?: string;
  readonly basis: 'per_serving_g' | 'per_serving_ml' | 'per_100_g' | 'unsupported';
  readonly publication_date?: string;
  readonly snapshot_digest: string;
  /** Server-held source-snapshot handle. Required for trusted Apply. */
  readonly evidence_id?: string;
  /** Exact authored target used for deterministic scaling. */
  readonly target?: AiBrandedTargetBinding;
  /** Server-issued verification over the exact canonical contribution. */
  readonly verification?: AiBrandedVerification;
}

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
  /** Present only for a validated USDA-hosted, manufacturer-supplied record. */
  readonly source_kind?: 'usda_branded';
  readonly usda_branded?: AiUsdaBrandedProvenance;
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
  /** Apply requires a per-Apply authenticated branded capability. */
  readonly requireTrustedBranded?: boolean;
  /** Minted only after the exact attached assertion is cryptographically verified. */
  readonly brandedAuthentication?: BrandedApplyAuthentication;
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
  const requireTrustedBranded = binding.requireTrustedBranded !== false;
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

    let usdaBranded: AiUsdaBrandedProvenance | undefined;
    if (row.source_kind !== undefined) {
      if (row.source_kind !== 'usda_branded' || row.classification !== 'source_backed') {
        return { ok: false, code: 'invalid_branded_source' };
      }
      if (!row.usda_branded || typeof row.usda_branded !== 'object' || Array.isArray(row.usda_branded)) {
        return { ok: false, code: 'invalid_branded_source' };
      }
      const branded = row.usda_branded as Record<string, unknown>;
      const evidenceIdRaw = branded.evidence_id;
      const targetRaw = branded.target;
      const verificationRaw = branded.verification;
      if (
        typeof branded.fdc_id !== 'number' ||
        !Number.isSafeInteger(branded.fdc_id) ||
        branded.fdc_id <= 0 ||
        !boundedString(branded.description, 500) ||
        (branded.brand_owner !== undefined && !boundedString(branded.brand_owner, 200)) ||
        (branded.brand_name !== undefined && !boundedString(branded.brand_name, 200)) ||
        (branded.serving_size !== undefined &&
          (typeof branded.serving_size !== 'number' || !Number.isFinite(branded.serving_size) || branded.serving_size <= 0 || branded.serving_size > 100_000)) ||
        (branded.serving_size_unit !== undefined && !boundedString(branded.serving_size_unit, 30)) ||
        (branded.basis !== 'per_serving_g' &&
          branded.basis !== 'per_serving_ml' &&
          branded.basis !== 'per_100_g' &&
          branded.basis !== 'unsupported') ||
        (branded.publication_date !== undefined && !boundedString(branded.publication_date, 40)) ||
        typeof branded.snapshot_digest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(branded.snapshot_digest) ||
        !boundedString(evidenceIdRaw, 80) ||
        !targetRaw || typeof targetRaw !== 'object' || Array.isArray(targetRaw) ||
        !verificationRaw || typeof verificationRaw !== 'object' || Array.isArray(verificationRaw)
      ) {
        return { ok: false, code: 'invalid_branded_source' };
      }
      const targetValue = targetRaw as Record<string, unknown>;
      if (
        !boundedString(targetValue.query, 120) ||
        (targetValue.amount !== null && !isValidNutrientAmount(targetValue.amount)) ||
        (targetValue.unit !== null && !boundedString(targetValue.unit, 30)) ||
        (targetValue.measurement_kind !== 'mass' &&
          targetValue.measurement_kind !== 'volume' &&
          targetValue.measurement_kind !== 'count' &&
          targetValue.measurement_kind !== 'unknown') ||
        (targetValue.quantity_grams !== undefined &&
          (typeof targetValue.quantity_grams !== 'number' || !Number.isFinite(targetValue.quantity_grams) || targetValue.quantity_grams <= 0 || targetValue.quantity_grams > 1_000_000)) ||
        (targetValue.quantity_ml !== undefined &&
          (typeof targetValue.quantity_ml !== 'number' || !Number.isFinite(targetValue.quantity_ml) || targetValue.quantity_ml <= 0 || targetValue.quantity_ml > 1_000_000))
      ) {
        return { ok: false, code: 'invalid_branded_target' };
      }
      const verificationValue = verificationRaw as Record<string, unknown>;
      if (
        verificationValue.version !== BRANDED_ASSERTION_VERSION ||
        !boundedString(verificationValue.key_id, 64) ||
        !boundedString(verificationValue.signature, 4096) ||
        typeof verificationValue.canonical_digest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(verificationValue.canonical_digest) ||
        typeof verificationValue.recipe_digest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(verificationValue.recipe_digest) ||
        !boundedString(verificationValue.review_identity, 300) ||
        !boundedString(verificationValue.issued_at, 40) ||
        !boundedString(verificationValue.expires_at, 40)
      ) {
        return { ok: false, code: 'invalid_branded_verification' };
      }
      usdaBranded = Object.freeze({
        fdc_id: branded.fdc_id,
        description: branded.description,
        ...(branded.brand_owner !== undefined ? { brand_owner: branded.brand_owner as string } : {}),
        ...(branded.brand_name !== undefined ? { brand_name: branded.brand_name as string } : {}),
        ...(branded.serving_size !== undefined ? { serving_size: branded.serving_size as number } : {}),
        ...(branded.serving_size_unit !== undefined ? { serving_size_unit: branded.serving_size_unit as string } : {}),
        basis: branded.basis,
        ...(branded.publication_date !== undefined ? { publication_date: branded.publication_date as string } : {}),
        snapshot_digest: branded.snapshot_digest,
        evidence_id: evidenceIdRaw as string,
        target: Object.freeze({
          query: targetValue.query as string,
          amount: targetValue.amount as number | null,
          unit: targetValue.unit as string | null,
          measurement_kind: targetValue.measurement_kind,
          ...(targetValue.quantity_grams !== undefined ? { quantity_grams: targetValue.quantity_grams as number } : {}),
          ...(targetValue.quantity_ml !== undefined ? { quantity_ml: targetValue.quantity_ml as number } : {}),
        }),
        verification: Object.freeze({
          version: BRANDED_ASSERTION_VERSION,
          key_id: verificationValue.key_id as string,
          signature: verificationValue.signature as string,
          canonical_digest: verificationValue.canonical_digest as string,
          recipe_digest: verificationValue.recipe_digest as string,
          review_identity: verificationValue.review_identity as string,
          issued_at: verificationValue.issued_at as string,
          expires_at: verificationValue.expires_at as string,
        }),
      });
    } else if (row.usda_branded !== undefined) {
      return { ok: false, code: 'invalid_branded_source' };
    }
    seen.add(ref);
    const contribution: AiNutrientContribution = Object.freeze({
      line_ref: ref, ingredient: row.ingredient, quantity_basis: row.quantity_basis,
      ...(row.weight_grams !== undefined ? { weight_grams: row.weight_grams as number } : {}),
      disposition,
      exclusion_role: exclusionRole,
      exclusion_assumption: exclusionAssumption,
      classification: row.classification,
      ...(usdaBranded !== undefined
        ? { source_kind: 'usda_branded' as const, usda_branded: usdaBranded }
        : {}),
      nutrients: Object.freeze(nutrients),
      unknown_nutrients: Object.freeze([...new Set(row.unknown_nutrients as NutrientId[])]),
      assumptions: Object.freeze([...(row.assumptions as string[])]), confidence: row.confidence,
      sources: Object.freeze(sources),
    });
    if (usdaBranded !== undefined) {
      if (usdaBranded.verification !== undefined) {
        if (computeBrandedContributionDigest(contribution) !== usdaBranded.verification.canonical_digest) {
          return { ok: false, code: 'branded_evidence_tampered' };
        }
        if (usdaBranded.verification.recipe_digest !== binding.recipe_digest) {
          return { ok: false, code: 'branded_evidence_context_mismatch' };
        }
      }
      if (requireTrustedBranded) {
        const authentication = binding.brandedAuthentication;
        if (
          !authentication ||
          !isBrandedApplyAuthentication(authentication) ||
          !brandedApplyAuthenticationMatches(authentication, contribution, binding.recipe_digest)
        ) {
          return { ok: false, code: 'branded_evidence_untrusted' };
        }
      }
    }
    result.push(contribution);
  }
  return { ok: true, contributions: Object.freeze(result) };
}

export const AI_NUTRIENT_SUPPLEMENT_VERSION = 'ai_nutrient_supplement_v1' as const;
export const MAX_AI_NUTRIENT_SUPPLEMENTS = 200;

/**
 * A separately attributed AI estimate for ONE nutrient missing from an existing
 * verified source-backed ingredient line. It never replaces the source line.
 */
export interface AiNutrientSupplement {
  readonly supplement_version: typeof AI_NUTRIENT_SUPPLEMENT_VERSION;
  readonly line_ref: string;
  readonly ingredient: string;
  readonly nutrient_id: NutrientId;
  readonly amount: number;
  readonly unit: CanonicalUnit;
  readonly classification: 'ai_estimate';
  readonly source_kind: 'ai_supplement';
  readonly source_food_id: string;
  readonly source_release: string;
  readonly weight_grams?: number;
  readonly quantity_basis: string;
  readonly assumptions: readonly string[];
  readonly confidence: 'low' | 'medium' | 'high';
  readonly recipe_digest: string;
  readonly review_identity: string;
}

export interface NutrientSupplementSourceBinding {
  /**
   * Nutrients the verified source genuinely contributes. Persisted v6 blocks
   * carry this per line as `source_nutrients`; a supplement whose source line
   * has no coverage is not verifiable and fails closed.
   */
  readonly nutrient_ids: readonly NutrientId[];
  readonly source_food_id?: string;
  readonly source_release?: string;
  readonly weight_grams?: number;
}

export interface NutrientSupplementBinding {
  readonly recipe_digest: string;
  readonly review_identity?: string;
  readonly line_text_by_ref?: Readonly<Record<string, string>>;
  readonly sources_by_ref: ReadonlyMap<string, NutrientSupplementSourceBinding>;
}

export type NutrientSupplementValidation =
  | { readonly ok: true; readonly supplements: readonly AiNutrientSupplement[] }
  | { readonly ok: false; readonly code: string };

/**
 * Validates supplemental nutrient proposals against the CURRENT verified
 * source lines. A supplement is allowed only when the source line genuinely
 * lacks the nutrient. Duplicate line+nutrient supplements are rejected.
 */
export function validateAiNutrientSupplements(
  raw: unknown,
  binding: NutrientSupplementBinding,
): NutrientSupplementValidation {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_AI_NUTRIENT_SUPPLEMENTS) {
    return { ok: false, code: 'invalid_supplements' };
  }
  const out: AiNutrientSupplement[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, code: 'invalid_supplement' };
    const row = item as Record<string, unknown>;
    const lineRef = typeof row.line_ref === 'string' ? row.line_ref : '';
    const source = binding.sources_by_ref.get(lineRef);
    if (!lineRef || !source) return { ok: false, code: 'unknown_line_ref' };
    const authored = binding.line_text_by_ref?.[lineRef];
    if (authored !== undefined && row.ingredient !== authored.slice(0, 200)) return { ok: false, code: 'line_text_mismatch' };
    if (typeof row.ingredient !== 'string' || row.ingredient.length === 0 || row.ingredient.length > 200) {
      return { ok: false, code: 'invalid_ingredient' };
    }
    const nutrientId = row.nutrient_id;
    if (typeof nutrientId !== 'string' || !isNutrientId(nutrientId)) return { ok: false, code: 'invalid_nutrient' };
    const definition = NUTRIENT_REGISTRY[nutrientId as NutrientId];
    if (row.unit !== definition.unit) return { ok: false, code: 'unit_mismatch' };
    if (typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount <= 0) {
      return { ok: false, code: 'invalid_amount' };
    }
    if (source.nutrient_ids.includes(nutrientId as NutrientId)) return { ok: false, code: 'source_already_has_nutrient' };
    const key = `${lineRef}\u0000${nutrientId}`;
    if (seen.has(key)) return { ok: false, code: 'duplicate_supplement' };
    const sourceFoodId = row.source_food_id;
    const sourceRelease = row.source_release;
    if (typeof sourceFoodId !== 'string' || sourceFoodId.length === 0 || sourceFoodId.length > 120) {
      return { ok: false, code: 'invalid_source_identity' };
    }
    if (source.source_food_id !== undefined && sourceFoodId !== source.source_food_id) {
      return { ok: false, code: 'source_identity_mismatch' };
    }
    if (typeof sourceRelease !== 'string' || sourceRelease.length === 0 || sourceRelease.length > 64) {
      return { ok: false, code: 'invalid_source_release' };
    }
    if (source.source_release !== undefined && sourceRelease !== source.source_release) {
      return { ok: false, code: 'source_release_mismatch' };
    }
    if (row.weight_grams === undefined) {
      // A source line with resolved grams MUST be bound to that weight basis;
      // an unweighted supplement could otherwise claim a different quantity.
      if (source.weight_grams !== undefined) return { ok: false, code: 'missing_weight' };
    } else {
      if (typeof row.weight_grams !== 'number' || !Number.isFinite(row.weight_grams) || row.weight_grams <= 0) {
        return { ok: false, code: 'invalid_weight' };
      }
      if (source.weight_grams !== undefined && Math.abs(row.weight_grams - source.weight_grams) > 1e-6) {
        return { ok: false, code: 'weight_mismatch' };
      }
    }
    if (typeof row.quantity_basis !== 'string' || row.quantity_basis.length === 0 || row.quantity_basis.length > 200) {
      return { ok: false, code: 'invalid_quantity_basis' };
    }
    if (!Array.isArray(row.assumptions) || row.assumptions.length === 0 || row.assumptions.length > 12) {
      return { ok: false, code: 'invalid_assumptions' };
    }
    const assumptions: string[] = [];
    for (const assumption of row.assumptions) {
      if (typeof assumption !== 'string') return { ok: false, code: 'invalid_assumptions' };
      const trimmed = assumption.trim();
      if (trimmed.length === 0 || trimmed.length > 500) return { ok: false, code: 'invalid_assumptions' };
      assumptions.push(trimmed);
    }
    if (row.confidence !== 'low' && row.confidence !== 'medium' && row.confidence !== 'high') {
      return { ok: false, code: 'invalid_confidence' };
    }
    if (row.supplement_version !== AI_NUTRIENT_SUPPLEMENT_VERSION) {
      return { ok: false, code: 'invalid_supplement_version' };
    }
    if (row.classification !== 'ai_estimate' || row.source_kind !== 'ai_supplement') {
      return { ok: false, code: 'invalid_supplement_classification' };
    }
    if (row.recipe_digest !== binding.recipe_digest) return { ok: false, code: 'stale_recipe' };
    if (typeof row.review_identity !== 'string' || row.review_identity.length === 0 || row.review_identity.length > 300) {
      return { ok: false, code: 'invalid_review_identity' };
    }
    if (binding.review_identity !== undefined && row.review_identity !== binding.review_identity) {
      return { ok: false, code: 'stale_review' };
    }
    seen.add(key);
    out.push(Object.freeze({
      supplement_version: AI_NUTRIENT_SUPPLEMENT_VERSION,
      line_ref: lineRef,
      ingredient: row.ingredient,
      nutrient_id: nutrientId as NutrientId,
      amount: row.amount,
      unit: definition.unit,
      classification: 'ai_estimate' as const,
      source_kind: 'ai_supplement' as const,
      source_food_id: sourceFoodId,
      source_release: sourceRelease,
      ...(row.weight_grams !== undefined ? { weight_grams: row.weight_grams as number } : {}),
      quantity_basis: row.quantity_basis,
      assumptions: Object.freeze(assumptions),
      confidence: row.confidence,
      recipe_digest: binding.recipe_digest,
      review_identity: row.review_identity,
    }));
  }
  return { ok: true, supplements: Object.freeze(out) };
}

/** Sums supplemental nutrient amounts by nutrient; no whole-line replacement. */
export function sumNutrientSupplements(
  supplements: readonly AiNutrientSupplement[],
): Partial<Record<NutrientId, { readonly amount: number; readonly unit: CanonicalUnit; readonly covered_ingredient_count: number; readonly lines: ReadonlySet<string> }>> {
  const sums: Partial<Record<NutrientId, { amount: number; unit: CanonicalUnit; lines: Set<string> }>> = {};
  for (const supplement of supplements) {
    const row = sums[supplement.nutrient_id] ?? { amount: 0, unit: supplement.unit, lines: new Set<string>() };
    row.amount += supplement.amount;
    row.lines.add(supplement.line_ref);
    sums[supplement.nutrient_id] = row;
  }
  return Object.freeze(Object.fromEntries(Object.entries(sums).map(([id, value]) => [id, Object.freeze({
    amount: Math.round(value.amount * 1_000_000) / 1_000_000,
    unit: value.unit,
    covered_ingredient_count: value.lines.size,
    lines: value.lines,
  })]))) as Partial<Record<NutrientId, { amount: number; unit: CanonicalUnit; covered_ingredient_count: number; lines: ReadonlySet<string> }>>;
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
  supplements: readonly AiNutrientSupplement[] = [],
): AdvisoryNutritionPreview {
  const sourceResolved = new Set(preview.ingredients.filter((row) => row.outcome === 'calculated').map((row) => row.line_ref));
  const sourceByRef = new Map(preview.ingredients.filter((row) => row.outcome === 'calculated').map((row) => [row.line_ref, row]));
  const accepted = contributions.filter((row) => !sourceResolved.has(row.line_ref));
  const selected = accepted.filter((row) => hasUsableAiNutrientValue(row));
  const excludedRefs = new Set(accepted.filter((row) => row.disposition === 'excluded').map((row) => row.line_ref));
  const supplementSeen = new Set<string>();
  const safeSupplements = supplements.filter((supplement) => {
    const source = sourceByRef.get(supplement.line_ref);
    if (!source) return false;
    if (source.contributing_nutrients.includes(supplement.nutrient_id)) return false;
    const key = `${supplement.line_ref}\u0000${supplement.nutrient_id}`;
    if (supplementSeen.has(key)) return false;
    if (!Number.isFinite(supplement.amount) || supplement.amount <= 0) return false;
    if (NUTRIENT_REGISTRY[supplement.nutrient_id]?.unit !== supplement.unit) return false;
    supplementSeen.add(key);
    return true;
  });
  const contributionTotals = sumAiNutrientContributions(selected) as Record<string, { amount: number; unit: CanonicalUnit; covered_ingredient_count: number }>;
  const supplementTotals = sumNutrientSupplements(safeSupplements) as Record<string, { amount: number; unit: CanonicalUnit; covered_ingredient_count: number }>;
  const aiRefs = new Set(selected.map((row) => row.line_ref));
  // The denominator for a nutrient the source never reports: every calculated
  // source line plus every selected AI line plus every still-unresolved line
  // that is not represented by an AI contribution. This mirrors the
  // deterministic calculator's measurable-line denominator.
  const measurableFallback = sourceResolved.size + selected.length + preview.unresolved.filter(
    (row) => !aiRefs.has(row.line_ref) && !excludedRefs.has(row.line_ref),
  ).length;
  const totals: Partial<Record<NutrientId, NutrientTotalResult>> = { ...preview.totals };
  for (const id of preview.nutrient_scope) {
    const ai = contributionTotals[id];
    const supplement = supplementTotals[id];
    const base = preview.totals[id];
    const aiCovered = ai?.covered_ingredient_count ?? 0;
    const supplementCovered = supplement?.covered_ingredient_count ?? 0;
    if (!base && !ai && !supplement) continue;
    // The deterministic preview's denominator already counts unresolved recipe
    // lines. An AI contribution changes their coverage disposition; it must not
    // append those same ingredient lines to the denominator a second time.
    const measurable = base?.measurable_ingredient_count ?? measurableFallback;
    if (measurable === 0) continue;
    const covered = (base?.covered_ingredient_count ?? 0) + aiCovered + supplementCovered;
    const amount = (base?.amount ?? 0) + (ai?.amount ?? 0) + (supplement?.amount ?? 0);
    totals[id] = {
      amount: Math.round(amount * 1_000_000) / 1_000_000,
      unit: base?.unit ?? ai?.unit ?? supplement?.unit ?? 'g',
      covered_ingredient_count: covered,
      measurable_ingredient_count: measurable,
      coverage: measurable === 0 ? 0 : covered / measurable,
      status: measurable > 0 && covered === measurable ? 'complete' : 'partial',
    };
  }
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
    nutrient_supplements: Object.freeze(safeSupplements),
    unresolved: Object.freeze(unresolved),
    status,
  });
}
