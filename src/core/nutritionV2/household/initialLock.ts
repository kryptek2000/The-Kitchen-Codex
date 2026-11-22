/**
 * The Kitchen Codex — Household-Portion Registry (registry-track Phase 5, repair):
 * reviewed separate-module source-controlled lock.
 *
 * TRUST ANCHOR
 * ------------
 * This file is the reviewed, source-controlled lock for the initial data slice,
 * deliberately separate from `initialData.ts` so that editing data without a
 * reviewed lock edit fails closed. It pins:
 *   - the Phase 4 registry schema version and release;
 *   - the exact authenticated record count and complete registry digest;
 *   - the complete provenance/equivalence digest;
 *   - the aggregate release digest committing to the registry AND provenance
 *     digests together.
 *
 * The loader recomputes every digest from the data and fails closed unless all
 * match. This is NOT an external signature or external distribution trust
 * service, and no external cryptographic trust anchor exists yet: the lock is a
 * repository-local reviewed constant set.
 */

import { HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION } from './types';

/** Reviewed registry release identifier for the initial USDA-derived slice. */
export const HOUSEHOLD_INITIAL_REGISTRY_RELEASE = 'household_portion_initial_usda_v1';

/**
 * Fixed Phase 4 registry lock. Deliberately a literal, never derived from the
 * data at runtime; a data edit without a lock edit fails every test.
 */
export const HOUSEHOLD_INITIAL_REGISTRY_LOCK = Object.freeze({
  schema_version: HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION,
  registry_release: HOUSEHOLD_INITIAL_REGISTRY_RELEASE,
  record_count: 31,
  registry_digest: '096d10d1c79d1a2e8a1880c46e1daac800e0636299070ca45fa549bebbb7ac27',
});

/** Fixed provenance/equivalence digest for the reviewed dataset. */
export const HOUSEHOLD_INITIAL_PROVENANCE_DIGEST =
  '1f8db8ea18de0203ab44df400aec4058303395303ab95a433b70be8778cdf088';

/** Fixed aggregate release digest committing to the registry + provenance digests. */
export const HOUSEHOLD_INITIAL_AGGREGATE_RELEASE_DIGEST =
  '062fcbf8ab724e73b7b73069a8fce9712b1bbbf9b68d00cb86dc926afa0a7d2e';
