/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: release manifest contract.
 *
 * PURE, platform-neutral. A strict, closed contract for a future generated
 * local USDA bundle. Validation NEVER fetches a URL: source URLs are inert data
 * checked only for scheme/host/shape.
 *
 * SHA-256 CAVEAT
 * --------------
 * A SHA-256 digest proves identity/integrity against a pinned expected manifest.
 * It does NOT, by itself, prove USDA authorship; that requires a separately
 * trusted acquisition process. Phase 1 makes no authenticity claim from a hash.
 */

import {
  isPlainObject,
  serializedBlockBytes,
  toInertValue,
} from '../schema';
import { canonicalStringify, sha256Hex } from './digest';
import { USDA_NUTRIENT_MAP_VERSION } from './nutrientMap';
import {
  BUNDLE_RELEASE_PATTERN,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_COMPONENTS,
  MAX_USDA_ATTRIBUTION_LENGTH,
  MAX_USDA_BUNDLE_RECORDS,
  MAX_USDA_GENERATOR_LENGTH,
  MAX_USDA_RELEASE_ID_LENGTH,
  MAX_USDA_URL_LENGTH,
  MAX_USDA_WARNING_CODE_LENGTH,
  MAX_USDA_WARNINGS,
  SHA256_HEX_PATTERN,
  USDA_ATTRIBUTION,
  USDA_CANONICALIZATION_VERSION,
  USDA_DATA_TYPES,
  USDA_MANIFEST_SCHEMA,
  USDA_SOURCE_HOST,
  type UsdaBundleManifest,
  type UsdaDataType,
  type UsdaManifestComponent,
  type UsdaManifestValidation,
  type UsdaManifestWarning,
} from './types';

const MANIFEST_KEYS = new Set([
  'manifest_schema',
  'bundle_release',
  'generator',
  'created_at',
  'data_types',
  'components',
  'canonical_record_count',
  'rejected_record_count',
  'canonical_content_digest',
  'nutrient_map_version',
  'canonicalization_version',
  'warnings',
  'attribution',
]);
const GENERATOR_KEYS = new Set(['name', 'schema_version']);
const COMPONENT_KEYS = new Set(['data_type', 'upstream_release', 'source_url', 'source_sha256']);
const WARNING_KEYS = new Set(['code', 'count']);

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isSafeNonNegativeInteger(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= max;
}

function isSupportedDataType(value: unknown): value is UsdaDataType {
  return typeof value === 'string' && (USDA_DATA_TYPES as ReadonlyArray<string>).includes(value);
}

function isValidTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  );
}

/**
 * An official USDA source URL: https, exact host, no credentials, no query, no
 * fragment, bounded length, nonempty path. This never performs a request.
 */
export function isOfficialUsdaSourceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_USDA_URL_LENGTH) {
    return false;
  }
  if (!value.startsWith('https://')) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    if (url.hostname !== USDA_SOURCE_HOST) return false;
    if (url.username !== '' || url.password !== '') return false;
    if (url.search !== '' || url.hash !== '') return false;
    if (url.pathname === '' || url.pathname === '/') return false;
    return true;
  } catch {
    return false;
  }
}

/** True for an exact lowercase 64-hex SHA-256 value. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

/**
 * Deterministic bundle identity over the AUTHORITATIVE inputs only: manifest
 * schema, generator schema, included data types, each component's data type /
 * upstream release / source URL / source digest, the nutrient-map version, and
 * the canonicalization version. Counts, timestamps, warnings, attribution, and
 * the (derived) bundle release id are intentionally excluded.
 */
export function computeBundleIdentity(manifest: UsdaBundleManifest): string {
  const components = [...manifest.components]
    .map((component) => ({
      data_type: component.data_type,
      upstream_release: component.upstream_release,
      source_url: component.source_url,
      source_sha256: component.source_sha256,
    }))
    .sort((a, b) => (a.data_type < b.data_type ? -1 : a.data_type > b.data_type ? 1 : 0));
  const payload = {
    manifest_schema: manifest.manifest_schema,
    generator: {
      name: manifest.generator.name,
      schema_version: manifest.generator.schema_version,
    },
    data_types: [...manifest.data_types].sort(),
    components,
    nutrient_map_version: manifest.nutrient_map_version,
    canonicalization_version: manifest.canonicalization_version,
  };
  return sha256Hex(canonicalStringify(payload));
}

/**
 * The single concise bundle release id used as `source_releases.usda_fdc`.
 * Derived deterministically so it changes whenever any authoritative input
 * changes, and always within the 64-character bound.
 */
export function deriveBundleReleaseId(manifest: UsdaBundleManifest): string {
  return `usda_fdc_${computeBundleIdentity(manifest).slice(0, 32)}`;
}

function collectComponentErrors(
  raw: Record<string, unknown>,
  diag: string[],
  dataTypes: UsdaDataType[]
): UsdaManifestComponent[] {
  const components: UsdaManifestComponent[] = [];
  if (!Array.isArray(raw.components) || raw.components.length < 1) {
    diag.push('invalid_components');
    return components;
  }
  if (raw.components.length > MAX_MANIFEST_COMPONENTS) {
    diag.push('too_many_components');
    return components;
  }
  const seen = new Set<string>();
  for (const entry of raw.components) {
    if (!isPlainObject(entry)) {
      diag.push('invalid_component');
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!COMPONENT_KEYS.has(key)) diag.push('unknown_component_field');
    }
    const dataType = entry.data_type;
    if (!isSupportedDataType(dataType)) {
      diag.push('invalid_component_data_type');
      continue;
    }
    if (seen.has(dataType)) {
      diag.push('duplicate_component_data_type');
      continue;
    }
    seen.add(dataType);
    if (!isBoundedString(entry.upstream_release, 1, MAX_USDA_RELEASE_ID_LENGTH)) {
      diag.push('invalid_upstream_release');
    }
    if (!isOfficialUsdaSourceUrl(entry.source_url)) {
      diag.push('invalid_source_url');
    }
    if (!isSha256Hex(entry.source_sha256)) {
      diag.push('invalid_source_sha256');
    }
    components.push({
      data_type: dataType,
      upstream_release: entry.upstream_release as string,
      source_url: entry.source_url as string,
      source_sha256: entry.source_sha256 as string,
    });
  }
  for (const dataType of dataTypes) {
    if (!seen.has(dataType)) diag.push(`missing_component:${dataType}`);
  }
  for (const component of components) {
    if (!dataTypes.includes(component.data_type)) diag.push('component_without_data_type');
  }
  return components;
}

function collectWarningErrors(raw: Record<string, unknown>, diag: string[]): UsdaManifestWarning[] | undefined {
  if (!hasOwn(raw, 'warnings')) return undefined;
  if (!Array.isArray(raw.warnings) || raw.warnings.length > MAX_USDA_WARNINGS) {
    diag.push('invalid_warnings');
    return undefined;
  }
  const warnings: UsdaManifestWarning[] = [];
  for (const entry of raw.warnings) {
    if (!isPlainObject(entry)) {
      diag.push('invalid_warning');
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!WARNING_KEYS.has(key)) diag.push('unknown_warning_field');
    }
    if (!isBoundedString(entry.code, 1, MAX_USDA_WARNING_CODE_LENGTH)) {
      diag.push('invalid_warning_code');
    }
    if (!isSafeNonNegativeInteger(entry.count, MAX_USDA_BUNDLE_RECORDS)) {
      diag.push('invalid_warning_count');
    }
    warnings.push({ code: entry.code as string, count: entry.count as number });
  }
  return warnings;
}

/**
 * Strictly validates a release manifest from an untrusted value. The value is
 * materialized inertly first (single descriptor pass; no getters/toJSON/valueOf
 * are invoked). Unknown, duplicate, missing, contradictory, unsafe, or
 * oversized fields fail closed. URLs are never fetched.
 */
export function validateManifest(raw: unknown): UsdaManifestValidation {
  try {
    const materialized = toInertValue(raw);
    if (!materialized.ok) {
      return { ok: false, errors: [`unsafe_manifest:${(materialized as { ok: false; reason: string }).reason}`] };
    }
    if (!isPlainObject(materialized.value)) return { ok: false, errors: ['not_an_object'] };
    const value = materialized.value;

    const bytes = serializedBlockBytes(value, MAX_MANIFEST_BYTES);
    if (bytes > MAX_MANIFEST_BYTES) return { ok: false, errors: ['manifest_too_large'] };

    const diag: string[] = [];
    for (const key of Object.keys(value)) {
      if (!MANIFEST_KEYS.has(key)) diag.push('unknown_field');
    }

    if (value.manifest_schema !== USDA_MANIFEST_SCHEMA) diag.push('invalid_manifest_schema');

    if (typeof value.bundle_release !== 'string' || !BUNDLE_RELEASE_PATTERN.test(value.bundle_release)) {
      diag.push('invalid_bundle_release');
    }

    let generatorName = '';
    let generatorSchema = '';
    if (!isPlainObject(value.generator)) {
      diag.push('invalid_generator');
    } else {
      for (const key of Object.keys(value.generator)) {
        if (!GENERATOR_KEYS.has(key)) diag.push('unknown_generator_field');
      }
      if (!isBoundedString(value.generator.name, 1, MAX_USDA_GENERATOR_LENGTH)) {
        diag.push('invalid_generator_name');
      } else {
        generatorName = value.generator.name;
      }
      if (!isBoundedString(value.generator.schema_version, 1, MAX_USDA_GENERATOR_LENGTH)) {
        diag.push('invalid_generator_schema');
      } else {
        generatorSchema = value.generator.schema_version;
      }
    }

    if (!isValidTimestamp(value.created_at)) diag.push('invalid_created_at');

    const dataTypes: UsdaDataType[] = [];
    if (!Array.isArray(value.data_types) || value.data_types.length < 1 || value.data_types.length > MAX_MANIFEST_COMPONENTS) {
      diag.push('invalid_data_types');
    } else {
      const seen = new Set<string>();
      for (const entry of value.data_types) {
        if (!isSupportedDataType(entry)) {
          diag.push('invalid_data_type');
        } else if (seen.has(entry)) {
          diag.push('duplicate_data_type');
        } else {
          seen.add(entry);
          dataTypes.push(entry);
        }
      }
    }

    const components = collectComponentErrors(value, diag, dataTypes);

    if (!isSafeNonNegativeInteger(value.canonical_record_count, MAX_USDA_BUNDLE_RECORDS)) {
      diag.push('invalid_canonical_record_count');
    } else if (value.canonical_record_count < 1) {
      diag.push('empty_canonical_record_count');
    }
    if (!isSafeNonNegativeInteger(value.rejected_record_count, MAX_USDA_BUNDLE_RECORDS)) {
      diag.push('invalid_rejected_record_count');
    }

    if (!isSha256Hex(value.canonical_content_digest)) diag.push('invalid_canonical_content_digest');

    if (value.nutrient_map_version !== USDA_NUTRIENT_MAP_VERSION) diag.push('invalid_nutrient_map_version');
    if (value.canonicalization_version !== USDA_CANONICALIZATION_VERSION) {
      diag.push('invalid_canonicalization_version');
    }

    const warnings = collectWarningErrors(value, diag);

    if (value.attribution !== USDA_ATTRIBUTION) diag.push('invalid_attribution');

    if (diag.length > 0) return { ok: false, errors: diag };

    const manifest: UsdaBundleManifest = {
      manifest_schema: USDA_MANIFEST_SCHEMA,
      bundle_release: value.bundle_release as string,
      generator: { name: generatorName, schema_version: generatorSchema },
      created_at: value.created_at as string,
      data_types: dataTypes,
      components,
      canonical_record_count: value.canonical_record_count as number,
      rejected_record_count: value.rejected_record_count as number,
      canonical_content_digest: value.canonical_content_digest as string,
      nutrient_map_version: value.nutrient_map_version as string,
      canonicalization_version: value.canonicalization_version as string,
      ...(warnings ? { warnings } : {}),
      attribution: value.attribution as string,
    };

    // Bundle identity must bind every authoritative input. A declared release id
    // that does not match the derived identity is contradictory and fails.
    if (manifest.bundle_release !== deriveBundleReleaseId(manifest)) {
      return { ok: false, errors: ['bundle_identity_mismatch'] };
    }

    return { ok: true, manifest, errors: [] };
  } catch {
    return { ok: false, errors: ['validation_error'] };
  }
}

/**
 * Deterministic canonical-content digest over canonical records. Records are
 * ordered by FDC id (then digest) so the digest is independent of input order.
 */
export function computeCanonicalContentDigest(
  records: ReadonlyArray<{ fdc_id: number; record_digest: string }>
): string {
  const ordered = [...records]
    .map((record) => ({ fdc_id: record.fdc_id, record_digest: record.record_digest }))
    .sort((a, b) => (a.fdc_id !== b.fdc_id ? a.fdc_id - b.fdc_id : a.record_digest < b.record_digest ? -1 : 1));
  return sha256Hex(canonicalStringify(ordered));
}
