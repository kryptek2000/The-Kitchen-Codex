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
  /** Recipe extraction primary model (web/URL/HTML -> structured recipe). */
  recipeGrabberPrimary: "gemini-3.7-flash",
  /** Recipe extraction fallback model when high demand / 503 / 429 occurs. */
  recipeGrabberFallback: "gemini-3.1-flash-lite",
  /** Recipe extraction alias model for additional fallback. */
  recipeGrabberAlias: "gemini-flash-latest",
  /** Nutrition estimation primary model. */
  nutritionPrimary: "gemini-3.7-flash",
  /** Nutrition estimation fallback model. */
  nutritionFallback: "gemini-3.1-flash-lite",
  /** Vault metadata intelligence recovery primary model. */
  metadataRecoveryPrimary: "gemini-3.7-flash",
  /** Vault metadata intelligence recovery fallback model. */
  metadataRecoveryFallback: "gemini-3.1-flash-lite",
  /**
   * Kitchen AI (Ask My Kitchen) intent interpretation primary model. Used by
   * `/api/kitchen/interpret`. When it fails, `kitchenFallback` is attempted
   * before the deterministic interpreter takes over.
   */
  kitchenPrimary: "gemini-3.7-flash",
  /**
   * Kitchen AI (Ask My Kitchen) attempt fallback model. Used when the primary
   * model is unavailable/unsupported. On GitHub-Query-style failures this keeps
   * Ask My Kitchen usable instead of hard-failing.
   */
  kitchenFallback: "gemini-3.1-flash-lite",
  /**
   * Kitchen web-discovery primary model. Google Search grounding is required;
   * a result is only accepted when the model returns real grounding URLs.
   */
  kitchenDiscoveryPrimary: "gemini-3.7-flash",
  /**
   * Kitchen web-discovery fallback model. Tried only when the primary throws or
   * returns no provider-grounded URLs. Still requires grounding — no grounding,
   * no web result.
   */
  kitchenDiscoveryFallback: "gemini-3.1-flash-lite",
  /**
   * Hard ceiling for a single Gemini HTTP request (milliseconds).
   *
   * Without this, a hung connection or stalled generation pends the endpoint
   * indefinitely ("freezing"), and the multi-model cascades multiply the
   * wait before graceful degradation kicks in. On timeout the callers'
   * existing fallback chains engage (next model, then offline estimators).
   */
  requestTimeoutMs: 25_000,
  /**
   * Server-owned image-GENERATION timeout (milliseconds). Image generation is
   * routinely slower than a text model response (10-60s for real image models),
   * so it gets its OWN ceiling instead of reusing the 25s TEXT `requestTimeoutMs`
   * (which would false-time-out legitimate image generation). Applied to BOTH
   * the Gemini ImageProvider (SDK httpOptions) and the OpenRouter ImageProvider
   * (AbortSignal.timeout). No retries are added — a timeout is a TIMEOUT.
   */
  imageGenerationTimeoutMs: 60_000,
} as const;
