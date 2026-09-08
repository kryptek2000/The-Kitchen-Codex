/**
 * The Kitchen Codex — AiProvider barrel (v0.6.0 Phase 1).
 *
 * Convenience re-exports so consumers/tests import the provider layer from one
 * place instead of reaching into each module.
 */

export type {
  AiCapability,
  AiCapabilities,
  AiGenerateOptions,
  AiJsonSchema,
  AiProvider,
  AiSearchOptions,
  AiSearchResult,
  AiStructuredOptions,
} from "./types.js";
export { GeminiProvider } from "./geminiProvider.js";
export {
  getAiProvider,
  getDefaultAiProvider,
  getRegisteredProviders,
  findRegisteredProvider,
  effectiveCapabilities,
  hasAllCapabilities,
  selectCandidates,
  selectAiCandidates,
  runWithAiFallback,
} from "./providerRegistry.js";
export type {
  RegisteredProvider,
  AiCandidate,
  AiCapabilityKey,
  FallbackResult,
  FallbackRunOptions,
} from "./providerRegistry.js";
export {
  ProviderOperationError,
  FALLBACK_ELIGIBLE_ERROR_CODES,
  classifyProviderError,
  normalizeProviderError,
  toProviderDiagnostic,
  isFallbackEligible,
} from "./providerErrors.js";
export type { ProviderErrorCode, ProviderErrorContext, ProviderDiagnostic } from "./providerErrors.js";
export { OPERATION_REQUIRED_CAPABILITIES, operationRequiredCapabilities } from "./operations.js";
export type { AiOperation } from "./operations.js";
