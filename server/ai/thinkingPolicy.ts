/**
 * The Kitchen Codex — provider thinking-level compatibility policy (Phase 9B-P1).
 *
 * ONE authoritative, deterministic, model-aware decision point for the
 * provider-specific `thinkingConfig.thinkingLevel` request option that Advanced
 * Nutrition semantic operations send. It exists because `thinkingLevel` support
 * is a property of the MODEL, not of the provider: the same provider rejects
 * `MINIMAL` on some models and accepts it on others.
 *
 * CALLER CONTRACT — and why the module name is provider-NEUTRAL:
 *   Application-layer semantic adapters (e.g. `server/nutritionInterpret.ts`)
 *   MUST NOT name or bind to a concrete provider — that neutrality is an
 *   enforced architectural invariant. They therefore import ONLY the neutral
 *   `resolveThinkingProviderOptions` entry point and ask the provider layer
 *   "what thinking options may this executing candidate receive?".
 *   All provider- and model-specific knowledge stays in THIS module, inside the
 *   `server/ai/` provider-infrastructure layer, beside `geminiProvider.ts`.
 *
 * ROOT CAUSE (confirmed by the Phase 9B-2C controlled real-provider smoke):
 *   - primary candidate  `gemini-3.7-flash` rejects `thinkingLevel: MINIMAL`
 *     with provider HTTP 400 / `INVALID_ARGUMENT`
 *     ("Thinking level MINIMAL is not supported for this model.")
 *   - fallback candidate `gemini-3.1-flash-lite` accepts `MINIMAL` and succeeds.
 * The prior code hard-coded `MINIMAL` at every call site, so the documented
 * primary candidate was never actually exercised.
 *
 * WHAT THIS MODULE IS NOT — deliberately:
 *   - It is NOT a second provider stack, registry, or capability source. The
 *     provider registry, candidate resolution, fallback ordering and the Gemini
 *     provider-option allowlist (`geminiProvider.ts`) are all UNCHANGED.
 *   - It does NOT probe a provider, call a catalog endpoint, or make any network
 *     request. The table below is a static, reviewed constant.
 *   - It does NOT decide whether a model is healthy, reachable, or entitled. It
 *     only answers: "if this EXACT (provider, model) is asked for a thinking
 *     level, which level may it safely receive?"
 *
 * FAIL-CLOSED BY DESIGN:
 *   A model id that is not in the table is treated as UNKNOWN. An unknown model
 *   gets NO explicit thinking option at all, rather than a guessed one. Guessing
 *   would reintroduce exactly the HTTP 400 this module exists to prevent, and
 *   would silently assume that models not yet reviewed share another model's
 *   capability. Adding a model to the table is an explicit, auditable act.
 *
 * PROVIDER ISOLATION:
 *   `thinkingConfig` is a Gemini-only request fragment. A candidate whose
 *   provider is not Gemini is never given one, regardless of its model id.
 *
 * MODEL MIGRATION IS OUT OF SCOPE:
 *   Model ids are a model-catalog/lifecycle decision (`server/modelConfig.ts`)
 *   and are NOT changed here. This table describes what the CURRENT ids accept.
 *
 * References:
 *   https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash
 *   https://ai.google.dev/gemini-api/docs/generate-content/thinking
 */

/** The single Gemini provider id that understands `thinkingConfig`. */
export const GEMINI_THINKING_PROVIDER_ID = 'gemini';

/**
 * The thinking level a caller would PREFER, before per-model compatibility is
 * applied. Callers keep stating their existing preference; this module decides
 * whether that preference is safe for the model actually selected.
 */
export type DesiredThinkingLevel = 'MINIMAL' | 'LOW';

/** What a single reviewed Gemini model id is known to accept. */
interface GeminiThinkingSupport {
  /** Whether this model accepts `MINIMAL`. */
  readonly minimal: boolean;
  /**
   * The level substituted when the caller asked for `MINIMAL` but this model
   * does not accept it. Every reviewed model accepts `LOW`.
   */
  readonly minimalReplacement: 'LOW';
}

/**
 * Reviewed Gemini thinking-level support, keyed by EXACT model id.
 *
 * Deliberately exact-match and deliberately small. `gemini-flash-latest` and
 * any future/alias model are deliberately ABSENT: they resolve to no entry and
 * therefore receive no explicit thinking option (see the fail-closed note above).
 */
const GEMINI_THINKING_SUPPORT: Readonly<Record<string, GeminiThinkingSupport>> = Object.freeze({
  // MINIMAL unsupported; LOW supported.
  'gemini-3.7-flash': Object.freeze({ minimal: false, minimalReplacement: 'LOW' }),
  // MINIMAL unsupported; LOW supported.
  'gemini-3.8-flash': Object.freeze({ minimal: false, minimalReplacement: 'LOW' }),
  // MINIMAL supported; LOW supported.
  'gemini-3.1-flash-lite': Object.freeze({ minimal: true, minimalReplacement: 'LOW' }),
});

/**
 * The narrow provider-options fragment handed to `generateStructured`.
 *
 * Typed as `Record<string, unknown>` so it drops straight into the existing
 * `AiGenerateOptions.providerOptions` slot. Its ONLY possible shape is
 * `{ thinkingConfig: { thinkingLevel: string } }`; the empty object means
 * "send no explicit thinking option at all".
 */
export type GeminiThinkingProviderOptions = Record<string, unknown>;

/**
 * Resolves the Gemini `providerOptions` fragment for one EXECUTION CANDIDATE.
 *
 * Must be called with the candidate that is ABOUT TO EXECUTE — i.e. inside the
 * fallback `run` callback — so a fallback candidate receives the configuration
 * appropriate to ITSELF, not to the preferred candidate that failed.
 *
 * Returns `{}` — meaning "send no explicit thinking option" — when:
 *   - the provider is not Gemini (provider isolation), or
 *   - the model id is unknown/unreviewed (fail closed), or
 *   - a level outside the two allowlisted values was requested.
 *
 * @param providerId The executing candidate's provider id (`candidate.provider.id`).
 * @param model The executing candidate's model id.
 * @param desired The caller's preferred level. Defaults to the historical
 *   `MINIMAL`, so a caller that only ever wanted `MINIMAL` keeps its intent and
 *   gains model-awareness without restating it.
 */
export function resolveThinkingProviderOptions(
  providerId: string,
  model: string,
  desired: DesiredThinkingLevel = "MINIMAL"
): GeminiThinkingProviderOptions {
  // Gemini-only request fragment: never attached to another provider.
  if (providerId !== GEMINI_THINKING_PROVIDER_ID) return {};
  if (typeof model !== 'string' || model.length === 0) return {};
  if (desired !== 'MINIMAL' && desired !== 'LOW') return {};

  const support = GEMINI_THINKING_SUPPORT[model];
  // Unknown / unreviewed model: OMIT rather than guess.
  if (support === undefined) return {};

  const thinkingLevel =
    desired === 'MINIMAL' && !support.minimal ? support.minimalReplacement : desired;
  return { thinkingConfig: { thinkingLevel } };
}
