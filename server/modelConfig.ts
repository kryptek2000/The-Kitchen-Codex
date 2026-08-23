/**
 * Centralized Gemini model configuration for The Kitchen Codex.
 *
 * NOTE ON MODEL IDENTIFIERS:
 * These identifiers MUST be verified against the Gemini API environment that is
 * actually reachable from this deployment (via GEMINI_API_KEY) before being
 * changed. In a build/CI environment without a valid API key, the model-list
 * endpoint returns 403 and cannot be queried programmatically, so these values
 * have been intentionally left as they were. If a model name is invalid for the
 * target environment, the nutrition estimator already degrades gracefully:
 * primary -> fallback -> offline algorithmic estimator, so no functionality is
 * lost — but for best accuracy confirm each ID resolves successfully.
 *
 * The identifiers are defined here once so they are not scattered across the
 * codebase. Update them in this single place after verifying availability.
 */
export const MODEL_CONFIG = {
  /** Recipe extraction (web/URL/HTML -> structured recipe). */
  recipeGrabber: "gemini-3.7-flash",
  /** Nutrition estimation primary model. */
  nutritionPrimary: "gemini-3.6-flash",
  /** Nutrition estimation fallback model. */
  nutritionFallback: "gemini-3.1-flash-lite",
  /** Vault metadata intelligence recovery primary model. */
  metadataRecoveryPrimary: "gemini-3.7-flash",
  /** Vault metadata intelligence recovery fallback model. */
  metadataRecoveryFallback: "gemini-3.1-flash-lite",
} as const;
