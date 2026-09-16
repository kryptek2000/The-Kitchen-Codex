/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: runtime barrel.
 *
 * PURE, platform-neutral, offline. Intentionally NOT re-exported from
 * `src/core/nutritionV2/index.ts` or `src/core/index.ts`: the browser production
 * loader imports it explicitly and it stays out of the shared-core public
 * surface.
 */

export * from './bundle';
export { decodeBoundedGzip, decodeUtf8Strict, hasGzipDecodeCapability, GzipDecodeError } from './gzip';
export type { GzipDecodeReason } from './gzip';
// Pure UTF-8 encoding primitive for the fixed asset source (no Node/Buffer).
export { utf8Encode } from '../usda/digest';
