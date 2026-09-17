/**
 * The Kitchen Codex — Advanced Nutrition Phase 3: calculation-context authority.
 *
 * PURE, offline. This ONE lexical module owns the calculation-context authority
 * registry AND both public operations that need it:
 *   - `createNutritionCalculationContext` (registers the genuine context);
 *   - `calculateRecipeNutrition` (resolves authority for the exact context);
 *   - `reviewFoodPortions` (bounded portion review for the exact context).
 *
 * LEXICAL PRIVACY
 * ---------------
 * The registry is a module-local `WeakMap` with module-local registration and
 * retrieval functions. Neither is exported, so no other module — including via a
 * direct file-path import — can register a fake context or retrieve authority
 * state. A structural fake, clone, wrapper, proxy, or inherited object is not
 * registered and is rejected with `invalid_context`.
 */

import { computeCanonicalContentDigest, validateManifest } from '../usda/manifest';
import { validateCanonicalRecord } from '../usda/record';
import { evaluateEligibility } from '../matching/eligibility';
import { createReviewCatalog } from '../matching/review';
import type { ReviewCatalog } from '../matching/types';
import type { CanonicalUsdaFoodRecord, UsdaDataType } from '../usda/types';
import { runAdvisoryCalculation } from './calculate';
import { buildPortionReview } from './mass';
import {
  CALCULATION_CONTEXT_VERSION,
  CALCULATION_VERSION,
  phase3Failure,
  type CalculationContextMetadata,
  type CalculationContextResult,
  type CalculationResult,
  type NutritionCalculationContext,
  type PortionReviewResult,
} from './types';

interface ContextAuthority {
  readonly metadata: CalculationContextMetadata;
  readonly records: ReadonlyMap<number, CanonicalUsdaFoodRecord>;
  readonly catalog: ReviewCatalog;
}

const CONTEXT_AUTHORITY = new WeakMap<object, ContextAuthority>();

function registerContextAuthority(context: NutritionCalculationContext, authority: ContextAuthority): void {
  CONTEXT_AUTHORITY.set(context as object, authority);
}

function resolveContextAuthority(context: unknown): ContextAuthority | undefined {
  if (typeof context !== 'object' || context === null) return undefined;
  try {
    return CONTEXT_AUTHORITY.get(context as object);
  } catch {
    return undefined;
  }
}

function contextFailure(): CalculationContextResult {
  return { ok: false, failure: phase3Failure('invalid_context') };
}

/**
 * Builds a trusted calculation context from a valid Phase 1 manifest and
 * canonical records. Construction is all-or-nothing and registers the genuine
 * returned instance with its private authority state.
 */
export function createNutritionCalculationContext(
  manifestRaw: unknown,
  recordsRaw: unknown
): CalculationContextResult {
  const manifestValidation = validateManifest(manifestRaw);
  if (!manifestValidation.ok) return contextFailure();
  const manifest = manifestValidation.manifest;

  if (!Array.isArray(recordsRaw) || recordsRaw.length === 0) return contextFailure();

  const records: CanonicalUsdaFoodRecord[] = [];
  for (const raw of recordsRaw) {
    const validation = validateCanonicalRecord(raw);
    if (!validation.ok) return contextFailure();
    records.push(validation.record);
  }

  const componentByType = new Map<UsdaDataType, string>();
  for (const component of manifest.components) {
    componentByType.set(component.data_type, component.upstream_release);
  }

  const seenIds = new Set<number>();
  for (const record of records) {
    if (record.bundle_release !== manifest.bundle_release) return contextFailure();
    if (record.nutrient_map_version !== manifest.nutrient_map_version) return contextFailure();
    const expectedUpstream = componentByType.get(record.data_type);
    if (expectedUpstream === undefined || expectedUpstream !== record.upstream_release) {
      return contextFailure();
    }
    if (seenIds.has(record.fdc_id)) return contextFailure();
    seenIds.add(record.fdc_id);
  }

  // AUTHENTICATION-BEFORE-FILTERING: the complete source must pass count and
  // content-digest checks before eligibility filtering.
  if (records.length !== manifest.canonical_record_count) return contextFailure();
  if (computeCanonicalContentDigest(records) !== manifest.canonical_content_digest) {
    return contextFailure();
  }

  // Construct the genuine Phase 2 review catalog from the same validated inputs.
  const catalogResult = createReviewCatalog(manifest, records);
  if (!catalogResult.ok) return contextFailure();
  const catalog = catalogResult.catalog;

  // The calculation record map contains ONLY eligible home-recipe records, so an
  // excluded FDC id can never be reached for portions or calculation.
  const recordMap = new Map<number, CanonicalUsdaFoodRecord>();
  for (const record of records) {
    if (!evaluateEligibility(record).eligible) continue;
    recordMap.set(record.fdc_id, record);
  }

  const metadata: CalculationContextMetadata = Object.freeze({
    context_version: CALCULATION_CONTEXT_VERSION,
    calculation_version: CALCULATION_VERSION,
    bundle_release: manifest.bundle_release,
    catalog_digest: catalog.metadata().catalog_digest,
    nutrient_map_version: manifest.nutrient_map_version,
    record_count: recordMap.size,
    source_record_count: records.length,
    excluded_record_count: records.length - recordMap.size,
    data_types: Object.freeze([...manifest.data_types]),
  });

  const context: NutritionCalculationContext = Object.freeze({
    metadata(): CalculationContextMetadata {
      return metadata;
    },
  });

  registerContextAuthority(context, Object.freeze({ metadata, records: recordMap, catalog }));

  return { ok: true, context };
}

/**
 * Calculates the advisory entire-recipe preview for a genuine context. Never
 * throws; a non-genuine context yields `invalid_context`.
 */
export function calculateRecipeNutrition(contextRaw: unknown, requestRaw: unknown): CalculationResult {
  const authority = resolveContextAuthority(contextRaw);
  if (!authority) return { ok: false, failure: phase3Failure('invalid_context') };
  return runAdvisoryCalculation({
    bundleRelease: authority.metadata.bundle_release,
    catalogDigest: authority.metadata.catalog_digest,
    nutrientMapVersion: authority.metadata.nutrient_map_version,
    records: authority.records,
    catalog: authority.catalog,
    request: requestRaw,
  });
}

/** Bounded canonical portion candidates for one matched food in a genuine context. */
export function reviewFoodPortions(contextRaw: unknown, fdcIdRaw: unknown): PortionReviewResult {
  const authority = resolveContextAuthority(contextRaw);
  if (!authority) return { ok: false, failure: phase3Failure('invalid_context') };
  if (
    typeof fdcIdRaw !== 'number' ||
    !Number.isSafeInteger(fdcIdRaw) ||
    Object.is(fdcIdRaw, -0) ||
    fdcIdRaw <= 0
  ) {
    return { ok: false, failure: phase3Failure('invalid_request') };
  }
  const record = authority.records.get(fdcIdRaw);
  if (!record) return { ok: false, failure: phase3Failure('invalid_request') };
  return { ok: true, review: buildPortionReview(record, authority.metadata.bundle_release) };
}
