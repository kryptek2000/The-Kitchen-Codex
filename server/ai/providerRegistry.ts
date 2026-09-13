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
import { openRouterDynamicCapabilities } from "./openRouterCatalog.js";
import { DeepSeekProvider, DEEPSEEK_MODEL_CAPABILITIES } from "./deepSeekProvider.js";
import { getServerSecretSync } from "../platform/ServerEnvironmentSecretAdapter.js";
import type { AiCapabilities, AiProvider } from "./types.js";
import {
  normalizeProviderError,
  ProviderOperationError,
  isFallbackEligible,
  toProviderDiagnostic,
  type ProviderDiagnostic,
  type ProviderErrorCode,
} from "./providerErrors.js";
import { logFallbackAttempt } from "../providerDiagnostics.js";
import type { CredentialSource } from "./credentialResolver.js";

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
  /**
   * v0.8.0: optional DYNAMIC per-model capability resolver (e.g. the live
   * OpenRouter catalog). Consulted AFTER the provider baseline but BEFORE the
   * curated `modelCapabilities` override, so curated truth always wins. Never a
   * config/secret surface; returns undefined for unknown models.
   */
  dynamicCapabilities?: (model: string) => Partial<AiCapabilities> | undefined;
  /** When false, the provider is skipped by selection. Defaults to true. */
  enabled?: boolean;
}

/** A single (provider, model) execution candidate. */
export interface AiCandidate {
  provider: AiProvider;
  model: string;
  /**
   * BYOK-5C: the credential source this candidate must execute with. A
   * `session_only` candidate is selectable even when its provider is not enabled
   * by an operator env key, because availability is governed by the session
   * store instead (exact-provider scoped; never an env fallback).
   */
  credentialSource?: CredentialSource;
  /**
   * v0.8.x: when true, this candidate must receive EXACTLY ONE attempt — the
   * fallback runner NEVER retries it, regardless of the operation's retry policy.
   * Set from TRUSTED server state only (e.g. a verified-dynamic free model whose
   * output is not guaranteed); never from client input.
   */
  singleAttempt?: boolean;
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

/** True when an OpenRouter key is present (server operator env via allowlisted source). */
function openRouterConfigured(): boolean {
  return Boolean(getServerSecretSync("openrouter_api_key"));
}

/** True when a DeepSeek key is present (server operator env via allowlisted source). */
function deepSeekConfigured(): boolean {
  return Boolean(getServerSecretSync("deepseek_api_key"));
}

/**
 * The built-in registry. Built lazily (no import side effects). Provider ORDER
 * is the selection order: Gemini first (preserves zero-config behavior),
 * OpenRouter second, DeepSeek third. Both OpenRouter and DeepSeek are INERT
 * (descriptor `enabled` false) unless their respective `*_API_KEY` is
 * configured, so existing zero-config Gemini users are untouched and the order
 * stays deterministic (Gemini -> OpenRouter -> DeepSeek).
 */
export function getRegisteredProviders(): RegisteredProvider[] {
  if (!registry) {
    const gemini = ensureDefault();
    const openRouter = new OpenRouterProvider();
    const deepSeek = new DeepSeekProvider();
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
        // v0.8.0: live catalog capability truth (structured output / reasoning)
        // for dynamically discovered OpenRouter models.
        dynamicCapabilities: openRouterDynamicCapabilities,
        // Config-driven in the sense that it reflects whether a key is configured;
        // it is NOT user-set capability truth, and it is never a raw secret.
        enabled: openRouterConfigured(),
      },
      {
        provider: deepSeek,
        defaultCapabilities: { ...deepSeek.capabilities },
        modelCapabilities: DEEPSEEK_MODEL_CAPABILITIES,
        // Same rule as OpenRouter: enabled only when its key is configured.
        enabled: deepSeekConfigured(),
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
  // Dynamic catalog truth (if any) is applied BEFORE the curated override so the
  // curated per-model truth always remains authoritative.
  const dynamic = registered.dynamicCapabilities?.(model);
  if (dynamic) {
    for (const key of Object.keys(dynamic) as AiCapabilityKey[]) {
      caps = { ...caps, [key]: Boolean(dynamic[key]) };
    }
  }
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
    // A session_only candidate's availability is governed by the SESSION store,
    // not by the operator env-key enablement; it still must satisfy capabilities
    // and its own runtime availability check below.
    if (registered.enabled === false && candidate.credentialSource !== "session_only") continue;
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

/** Bounded, opt-in same-model transient retry policy. */
export interface FallbackRetryPolicy {
  /**
   * Maximum execution attempts for a SINGLE (provider, model) candidate.
   * `1` (or omitted) = no same-model retry (the default).
   */
  maxAttemptsPerCandidate: number;
  /** Bounded deterministic backoff between attempts of the same candidate (ms). */
  backoffMs?: number;
  /**
   * Error codes eligible for same-model retry. Defaults to `[]` (no same-model
   * retry). AUTH and UNSUPPORTED_CAPABILITY are NEVER retried, regardless.
   */
  retryableCodes?: ProviderErrorCode[];
  /**
   * Test seam for the delay function; defaults to a bounded `setTimeout`
   * promise. Present only to keep unit tests fast (no real sleeps).
   */
  sleep?: (ms: number) => Promise<void>;
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
  /**
   * OPT-IN bounded same-model retry. When omitted, behavior is EXACTLY one
   * attempt per candidate (no retry, no delay) — the default for every consumer.
   */
  retry?: FallbackRetryPolicy;
}

/**
 * Maps an already-normalized error into a typed terminal error carrying the full
 * sanitized attempt trail (non-enumerable so it never serializes into logs, UI,
 * or settings). Returns the error (adding the trail) or a default.
 */
function terminalError(
  last: ProviderOperationError | undefined,
  diagnostics: ProviderDiagnostic[]
): ProviderOperationError {
  const terminal = last ?? new ProviderOperationError("PROVIDER_ERROR", "All AI candidates failed.", {});
  if (diagnostics.length > 0) {
    Object.defineProperty(terminal, "diagnostics", {
      value: diagnostics.slice(),
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return terminal;
}

/**
 * Explicit fallback policy: executes capable candidates in order, falling back
 * only on fallback-eligible errors; AUTH falls back only when a different
 * provider remains AND allowAuthFallback is set; never falls back on a capability
 * mismatch. Same-model retry is OPT-IN via `options.retry` (default: exactly one
 * attempt per candidate). Returns the winning result + diagnostics, or throws a
 * normalized terminal error carrying the sanitized attempt trail.
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

  const retry = options.retry;
  const maxAttempts =
    retry && Number.isInteger(retry.maxAttemptsPerCandidate) && retry.maxAttemptsPerCandidate > 0
      ? retry.maxAttemptsPerCandidate
      : 1;
  const retryableCodes = retry?.retryableCodes ?? [];
  const backoffMs = retry?.backoffMs ?? 600;
  const sleep = retry?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let i = 0; i < capable.length; i++) {
    const candidate = capable[i];
    // A `singleAttempt` candidate (trusted server state) is NEVER retried, even
    // when the operation opts into same-model retry. Retries otherwise stay LOCAL
    // to this candidate (A1, A2, ...) before the next candidate.
    const candidateMaxAttempts = candidate.singleAttempt ? 1 : maxAttempts;
    for (let attempt = 1; attempt <= candidateMaxAttempts; attempt++) {
      try {
        const result = await options.run(candidate);
        // Successful fallback: surface intermediate attempt failures (sanitized)
        // so visibility is not discarded when a later provider/model recovers.
        for (const diag of diagnostics) logFallbackAttempt(diag);
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
          // AUTH is NEVER retried (same-model). Fallback to a DIFFERENT provider
          // is allowed only when explicitly permitted and one remains.
          const differentProviderRemains = capable
            .slice(i + 1)
            .some((x) => x.provider.id !== candidate.provider.id);
          if (!differentProviderRemains || !options.allowAuthFallback) {
            // The primary auth failure stays visible (no silent key swap).
            throw normalized;
          }
          break; // move to the next candidate (no same-model auth retry).
        }

        if (!isFallbackEligible(normalized.code)) throw normalized;

        // Same-model transient retry: bounded, only when opted in + code matches,
        // and only while more attempts remain for THIS candidate.
        const canRetry =
          candidateMaxAttempts > 1 && attempt < candidateMaxAttempts && retryableCodes.includes(normalized.code);
        if (canRetry) {
          await sleep(backoffMs);
          continue; // retry the SAME provider/model candidate.
        }
        break; // fallback-eligible but not same-model-retryable -> next candidate.
      }
    }
  }

  throw terminalError(last, diagnostics);
}
