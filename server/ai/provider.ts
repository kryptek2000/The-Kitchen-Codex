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
  AiStructuredOptions,
} from "./types.js";
export { GeminiProvider } from "./geminiProvider.js";
export { getAiProvider, getDefaultAiProvider } from "./providerRegistry.js";
