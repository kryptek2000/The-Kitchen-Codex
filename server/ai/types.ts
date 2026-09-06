/**
 * The Kitchen Codex — Provider-Neutral AI Contracts (compatibility re-export shim).
 *
 * Phase 4B moved the provider-neutral AI contracts into the platform-neutral
 * shared core (`src/core/ai/types.ts`). This file is a LOGIC-FREE re-export shim
 * so the existing provider layer (provider barrel, Gemini adapter, runtime
 * registry) and the feature adapters keep resolving the same contracts without a
 * large import rewrite. The Gemini SDK, providerRegistry runtime, geminiClient,
 * and provider diagnostics remain in the server/infrastructure layer and are NOT
 * moved into core.
 */
export * from '../../src/core/ai/types';
