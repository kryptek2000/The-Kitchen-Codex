/**
 * The Kitchen Codex — provider registry + capability-aware selection (v0.7 1A).
 *
 * Extends the v0.6 registry from "default Gemini only" to a capability-aware,
 * ordered provider/model selection surface, while keeping `getDefaultAiProvider`
 * and `getAiProvider` exactly compatible for existing zero-config consumers.
 *
 * DESIGN:
 *   - capability TRUTH lives in the registry (provider descriptor defaults + an
 *     OPTIONAL per-model override). User/provider config must NEVER define
 *     capability truth.
 *   - selection filters by required capability + availability, preserving
 *     configured provider order. No scores/weights/randomization.
 *   - `runWithAiFallback` is the explicit fallback policy: it never executes a
 *     candidate that lacks the required capability, and never silently changes
 *     operation semantics (e.g. an ordinary text model can never satisfy
 *     `webSearch`).
 *
 * Phase 1A registers ONLY Gemini. OpenRouter (1B) and DeepSeek (1C) plug in by
 * appending a `RegisteredProvider` descriptor — no rewrite of selection logic.
 */

import { GeminiProvider } from "./geminiProvider.js";
import { OpenRouterProvider, OPENROUTER_MODEL_CAPABILITIES } from "./openRouterProvider.js";
import type { AiCapabilities, AiProvider } from "./types.js";
import {
  normalizeProviderError,
  ProviderOperationError,
  isFallbackEligible,
  toProviderDiagnostic,
  type ProviderDiagnostic,
} from "./providerErrors.js";

/** A single capability key (the shape of `AiCapabilities`). */
export type AiCapabilityKey = keyof AiCapabilities;

/** A registered provider with its authoritative capability description. */
export interface RegisteredProvider {
  provider: AiProvider;
  /** Authoritative provider-level capability baseline (registry-owned truth). */
  defaultCapabilities: AiCapabilities;
  /**
   * Optional per-MODEL capability override. It may NARROW or WIDEN a capability
   * for a specific model (the registry owns the truth; user/provider *config*
   * never controls capability truth). An unknown model falls back to
   * `defaultCapabilities` and never magically gains a capability.
   */
  modelCapabilities?: Record<string, Partial<AiCapabilities>>;
  /** When false, the provider is skipped by selection. Defaults to true. */
  enabled?: boolean;
}

/** A single (provider, model) execution candidate. */
export interface AiCandidate {
  provider: AiProvider;
  model: string;
}

/** Result of a successful fallback run. */
export interface FallbackResult<T> {
  result: T;
  providerId: string;
  model: string;
  diagnostics: ProviderDiagnostic[];
}

let defaultProvider: AiProvider | null = null;
let registry: RegisteredProvider[] | null = null;

function ensureDefault(): AiProvider {
  if (!defaultProvider) defaultProvider = new GeminiProvider();
  return defaultProvider;
}

/** True when an OpenRouter key is present (server env only). */
function openRouterConfigured(): boolean {
  return (process.env.OPENROUTER_API_KEY || "").trim().length > 0;
}

/**
 * The built-in registry. Built lazily (no import side effects). Provider ORDER
 * is the selection order: Gemini first (preserves zero-config behavior), OpenRouter
 * second. OpenRouter is INERT (descriptor `enabled` false) unless an
 * `OPENROUTER_API_KEY` is configured, so existing zero-config Gemini users are
 * untouched.
 */
export function getRegisteredProviders(): RegisteredProvider[] {
  if (!registry) {
    const gemini = ensureDefault();
    const openRouter = new OpenRouterProvider();
    registry = [
      {
        provider: gemini,
        defaultCapabilities: { ...gemini.capabilities },
        enabled: true,
      },
      {
        provider: openRouter,
        defaultCapabilities: { ...openRouter.capabilities },
        modelCapabilities: OPENROUTER_MODEL_CAPABILITIES,
        // Config-driven in the sense that it reflects whether a key is configured;
        // it is NOT user-set capability truth, and it is never a raw secret.
        enabled: openRouterConfigured(),
      },
    ];
  }
  return registry;
}

/** The single active/default provider (Gemini). Lazily constructed once. */
export function getDefaultAiProvider(): AiProvider {
  return ensureDefault();
}

/** Resolves a known registered provider by id. Unknown ids return undefined safely. */
export function getAiProvider(id: string): AiProvider | undefined {
  return findRegisteredProvider(getRegisteredProviders(), id)?.provider;
}

/** Finds the registered provider descriptor for a provider id. */
export function findRegisteredProvider(
  regs: RegisteredProvider[],
  id: string | undefined
): RegisteredProvider | undefined {
  return regs.find((r) => r.provider.id === id);
}

/** Resolves the EFFECTIVE capabilities for a provider + model (defaults + model override). */
export function effectiveCapabilities(
  registered: RegisteredProvider,
  model: string
): AiCapabilities {
  let caps: AiCapabilities = { ...registered.defaultCapabilities };
  const override = registered.modelCapabilities?.[model];
  if (override) {
    for (const key of Object.keys(override) as AiCapabilityKey[]) {
      caps = { ...caps, [key]: Boolean(override[key]) };
    }
  }
  return caps;
}

/** True when a capability set satisfies every required capability. */
export function hasAllCapabilities(caps: AiCapabilities, required: AiCapabilityKey[]): boolean {
  return required.every((k) => caps[k] === true);
}

/**
 * Filters an ordered candidate list down to those that satisfy the required
 * capabilities and are available, PRESERVING order. Unknown, disabled,
 * capability-mismatched, and unavailable providers/models are skipped.
 */
export function selectCandidates(
  regs: RegisteredProvider[],
  candidates: AiCandidate[],
  requiredCapabilities: AiCapabilityKey[]
): AiCandidate[] {
  const out: AiCandidate[] = [];
  for (const candidate of candidates) {
    const registered = findRegisteredProvider(regs, candidate.provider.id);
    if (!registered) continue; // unknown provider -> skip
    if (registered.enabled === false) continue; // disabled -> skip
    if (!hasAllCapabilities(effectiveCapabilities(registered, candidate.model), requiredCapabilities)) {
      continue; // capability mismatch -> skip (never execute)
    }
    if (!candidate.provider.isAvailable()) continue; // unavailable -> skip
    out.push(candidate);
  }
  return out;
}

/** Convenience: selects capable candidates against the built-in registry. */
export function selectAiCandidates(
  candidates: AiCandidate[],
  requiredCapabilities: AiCapabilityKey[]
): AiCandidate[] {
  return selectCandidates(getRegisteredProviders(), candidates, requiredCapabilities);
}

export interface FallbackRunOptions<T> {
  /** Ordered (provider, model) candidates. */
  candidates: AiCandidate[];
  /** Required capability; a candidate lacking it is NEVER executed. */
  requiredCapabilities: AiCapabilityKey[];
  /** Optional registry (defaults to the built-in Gemini-only registry). */
  registry?: RegisteredProvider[];
  /** Executes one candidate. Throws on failure. */
  run: (candidate: AiCandidate) => Promise<T>;
  /**
   * When true, an AUTH failure on one provider may fall back to a DIFFERENT
   * provider if one remains. The primary AUTH failure stays in `diagnostics`.
   */
  allowAuthFallback?: boolean;
}

/**
 * Explicit fallback policy: executes capable candidates in order, falling back
 * only on fallback-eligible errors; AUTH falls back only when a different
 * provider remains AND allowAuthFallback is set; never falls back on a capability
 * mismatch. Returns the winning result + diagnostics, or throws a normalized
 * terminal error.
 */
export async function runWithAiFallback<T>(
  options: FallbackRunOptions<T>
): Promise<FallbackResult<T>> {
  const regs = options.registry ?? getRegisteredProviders();
  const capable = selectCandidates(regs, options.candidates, options.requiredCapabilities);
  const diagnostics: ProviderDiagnostic[] = [];
  let last: ProviderOperationError | undefined;

  if (capable.length === 0) {
    throw new ProviderOperationError(
      "UNSUPPORTED_CAPABILITY",
      "No configured provider/model supports the required capability.",
      {}
    );
  }

  for (let i = 0; i < capable.length; i++) {
    const candidate = capable[i];
    try {
      const result = await options.run(candidate);
      return { result, providerId: candidate.provider.id, model: candidate.model, diagnostics };
    } catch (err) {
      const normalized = normalizeProviderError(err, {
        providerId: candidate.provider.id,
        model: candidate.model,
      });
      diagnostics.push(toProviderDiagnostic(normalized));
      last = normalized;

      // Capability mismatch must never be treated as an ordinary runtime fallback.
      if (normalized.code === "UNSUPPORTED_CAPABILITY") throw normalized;

      if (normalized.code === "AUTH") {
        const differentProviderRemains = capable
          .slice(i + 1)
          .some((x) => x.provider.id !== candidate.provider.id);
        if (!differentProviderRemains || !options.allowAuthFallback) {
          // The primary auth failure stays visible (no silent key swap).
          throw normalized;
        }
        continue;
      }

      if (!isFallbackEligible(normalized.code)) throw normalized;
      // fallback-eligible -> try the next capable candidate.
    }
  }

  throw last ?? new ProviderOperationError("PROVIDER_ERROR", "All AI candidates failed.", {});
}
