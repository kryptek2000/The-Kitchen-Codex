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
export { OpenRouterProvider, OPENROUTER_MODEL_CAPABILITIES, OPENROUTER_STRUCTURED_MODEL } from "./openRouterProvider.js";
export {
  DeepSeekProvider,
  DEEPSEEK_MODEL_CAPABILITIES,
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_PRO_MODEL,
} from "./deepSeekProvider.js";
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
  FallbackRetryPolicy,
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
export { resolveRoleCandidates } from "./roleCandidates.js";
export { roleModelsForProvider, curatedTextModels } from "./roleModels.js";
export {
  normalizeOperationSelection,
  coerceSelectionInput,
  hasExplicitUserSelection,
  validateUserTextSelection,
  userTextSelectionMatchesOperation,
  resolveTextCandidateContext,
  resolveExecutableTextCandidates,
  validateUserImageSelection,
  resolveEffectiveImageSelection,
} from "./effectiveSelection.js";
export type {
  EffectiveImageSelection,
  SelectedOperationMetadata,
  SelectionInput,
  CoercedSelectionInput,
} from "./effectiveSelection.js";
export {
  parseTextSelectionHeader,
  parseImageSelectionHeader,
  isExplicitSelectionIntent,
  selectionIntentToMetadata,
  SELECTION_HEADER_NAMES,
  SELECTION_HEADER_BOUNDS,
} from "./parseSelectionMetadata.js";
export type {
  SelectionHeaderSource,
  SelectionIntent,
  SelectionInvalidReason,
} from "./parseSelectionMetadata.js";
