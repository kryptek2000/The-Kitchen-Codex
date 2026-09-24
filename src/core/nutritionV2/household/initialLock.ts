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
  registry_digest: '6ad593ef558ca9325197549f005da5b1eee822211f2ec6b5290f5c58fedc4ac4',
});

/** Fixed provenance/equivalence digest for the reviewed dataset. */
export const HOUSEHOLD_INITIAL_PROVENANCE_DIGEST =
  'adba614327f9cb078ffd35d6abade50b25de180b43f4b373eea6ab8825694b31';

/** Fixed aggregate release digest committing to the registry + provenance digests. */
export const HOUSEHOLD_INITIAL_AGGREGATE_RELEASE_DIGEST =
  'f8fed2230ac210c8dc2548f3a300134091c3a490ac6eb68add2766ac9b85b256';
