/**
 * The Kitchen Codex — Household-Portion Registry Contract (registry-track Phase 4):
 * narrow public exports.
 *
 * CONTRACT-ONLY, ISOLATED. This barrel is NOT re-exported from
 * `src/core/nutritionV2/index.ts` or `src/core/index.ts`, and no
 * matching/calculation/UI/AI/persistence/server module may import it in
 * Phase 4. Tests reach it by explicit deep import.
 *
 * Authority boundary reminder:
 *
 * > Cryptographic integrity proves which reviewed record was loaded; it does
 * > not prove the real-world truth of the cited grams or authorize its use for
 * > a recipe.
 */

export {
  HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION,
  HOUSEHOLD_RELEASE_PATTERN,
  HOUSEHOLD_SHA256_HEX_PATTERN,
  HOUSEHOLD_DATE_PATTERN,
  HOUSEHOLD_FAILURE_MESSAGE,
  householdFailure,
  MAX_HOUSEHOLD_REGISTRY_RECORDS,
  MAX_HOUSEHOLD_REGISTRY_BYTES,
  MAX_HOUSEHOLD_FOOD_KEY_BYTES,
  MAX_HOUSEHOLD_FOOD_KEY_TOKENS,
  MAX_HOUSEHOLD_ALIASES,
  MAX_HOUSEHOLD_FDC_IDS,
  MAX_HOUSEHOLD_EXCLUDED_STATES,
  MAX_HOUSEHOLD_GRAMS_PER_UNIT,
  MAX_HOUSEHOLD_CITATION_BYTES,
  MAX_HOUSEHOLD_URL_BYTES,
  MAX_HOUSEHOLD_RELEASE_LENGTH,
  type HouseholdPortionAuthorityClass,
  type HouseholdPortionSourceKind,
  type HouseholdPortionQuantityBehavior,
  type HouseholdFailureCode,
  type HouseholdFailure,
  type HouseholdPortionSource,
  type HouseholdPortionBounds,
  type HouseholdPortionRecordInput,
  type AuthenticatedHouseholdPortionRecord,
  type HouseholdPortionRegistryLock,
  type HouseholdLookupKey,
} from './types';

export {
  HOUSEHOLD_SIZE_CLASSES,
  HOUSEHOLD_STATES,
  HOUSEHOLD_AUTHORITY_CLASSES,
  HOUSEHOLD_SOURCE_KINDS,
} from './normalize';

export {
  householdRecordCanonicalPayload,
  computeHouseholdRecordDigest,
  computeHouseholdRegistryDigest,
  sortHouseholdRecordsCanonical,
} from './digest';

export {
  validateHouseholdRecord,
  loadHouseholdPortionRegistry,
  type HouseholdRecordResult,
  type HouseholdRegistryMetadata,
  type HouseholdPortionRegistry,
  type HouseholdLookupResult,
  type HouseholdRegistryResult,
} from './registry';
