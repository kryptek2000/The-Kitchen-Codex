/**
 * The Kitchen Codex — effective provider/model selection (BYOK-4).
 *
 * Resolves the AUTHORITATIVE (provider, model) for a text or image AI call,
 * honoring strict precedence:
 *
 *   server_managed (valid env pin)  >  user_selected (valid, catalog-validated)  >  server_default
 *
 * SECURITY / TRUTH:
 *   - A server-managed env pin is ALWAYS authoritative. It wins over any saved
 *     user selection; a stale/invalid user pick is never executed.
 *   - A user selection is honored ONLY when it is well-formed AND validated
 *     against the CURRENT catalog (provider registered+enabled, model curated,
 *     capability satisfied for the operation).
 *   - FAIL CLOSED, never silent cross-provider replacement: an EXPLICIT user
 *     selection that is stale/invalid/unavailable resolves to NO candidates
 *     (text -> the operation's deterministic fallback) or NO image provider
 *     (image -> a bounded provider-unavailable result) — NEVER the server-default
 *     chain and never a DIFFERENT paid provider. Server-default execution resumes
 *     ONLY when the user explicitly resets to server default (no explicit
 *     user_selected in the request).
 *   - This module never reads a secret and never returns keys/tokens/raw errors.
 */

import type { AiCandidate, AiCapabilityKey, RegisteredProvider } from "./providerRegistry.js";
import {
  effectiveCapabilities,
  findRegisteredProvider,
  getRegisteredProviders,
  hasAllCapabilities,
  selectCandidates,
} from "./providerRegistry.js";
import {
  getImageSelection,
  getTextSelection,
  type ProviderSelectionState,
} from "./providerSelection.js";
import {
  findRegisteredImageProvider,
  getRegisteredImageProviders,
  selectableImageModels,
  type RegisteredImageProvider,
} from "./imageProviderRegistry.js";
import { roleModelsForProvider, selectableTextModels } from "./roleModels.js";
import type { AiOperation } from "./operations.js";
import { operationRequiredCapabilities } from "./operations.js";
import type { AiProvider } from "./types.js";
import type { ImageProvider } from "./imageProvider.js";
import type { SelectionIntent } from "./parseSelectionMetadata.js";
import { openRouterPricingGuard, type PricingGuardCode } from "./openRouterCatalog.js";
import {
  createSessionBoundImageProvider,
  createSessionBoundTextProvider,
  isCredentialSource,
  supportsSessionBoundImageProvider,
  supportsSessionBoundTextProvider,
  type CredentialSource,
} from "./credentialResolver.js";

/** The per-request, NON-SECRET selection metadata supplied by the client. */
export interface SelectedOperationMetadata {
  /**
   * The client-declared selection intent. `user_selected` makes the selection
   * EXPLICIT (fail-closed when invalid — never the server default). Providers of
   * an older header shape omit it; the presence of `providerId` implies the same
   * explicit intent.
   */
  mode?: "user_selected" | "server_default";
  providerId?: string;
  modelId?: string;
  /**
   * BYOK-5C: WHOSE credential authorizes the selected provider/model. Non-secret
   * metadata; NEVER inferred from the provider/model. Omitted -> the default
   * `server_environment`.
   */
  credentialSource?: CredentialSource;
  /**
   * v0.8.0: the cost class the user ACKNOWLEDGED when selecting this model
   * (non-secret). Used to detect a FREE -> PAID transition and fail closed.
   */
  selectedCostClass?: "free" | "budget" | "paid" | "variable";
}

/**
 * The selection input accepted by the resolver: either the STRICT discriminated
 * `SelectionIntent` produced by the header parser (preferred), or the legacy
 * bounded `SelectedOperationMetadata` shape (kept for direct callers/tests).
 */
export type SelectionInput = SelectionIntent | SelectedOperationMetadata | undefined;

/** True when the request carries an EXPLICIT user selection attempt. */
export function hasExplicitUserSelection(metadata: SelectedOperationMetadata | undefined): boolean {
  return Boolean(metadata?.providerId) || metadata?.mode === "user_selected";
}

/** True when an input value is a strict discriminated `SelectionIntent`. */
function isSelectionIntent(value: unknown): value is SelectionIntent {
  return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}

/** The bounded resolver view of a selection input. */
export interface CoercedSelectionInput {
  /** A PRESENT but malformed/incoherent payload -> fail closed. */
  invalid: boolean;
  /** An explicit user selection attempt (valid or invalid). */
  explicit: boolean;
  /** The bounded metadata for a valid explicit selection (undefined otherwise). */
  metadata?: SelectedOperationMetadata;
}

/**
 * Normalizes either selection-input shape into a single bounded view. A strict
 * `INVALID` intent (or an invalid legacy shape) yields `invalid:true` so the
 * resolver FAILS CLOSED — it is never collapsed to server_default.
 */
export function coerceSelectionInput(input: SelectionInput): CoercedSelectionInput {
  if (input === undefined || input === null) return { invalid: false, explicit: false };
  if (isSelectionIntent(input)) {
    switch (input.kind) {
      case "ABSENT":
      case "EXPLICIT_DEFAULT":
        return { invalid: false, explicit: false };
      case "EXPLICIT_SELECTED": {
        const metadata: SelectedOperationMetadata = { mode: "user_selected", providerId: input.providerId };
        if (input.modelId) metadata.modelId = input.modelId;
        if (input.credentialSource) metadata.credentialSource = input.credentialSource;
        if (input.selectedCostClass) metadata.selectedCostClass = input.selectedCostClass;
        return { invalid: false, explicit: true, metadata };
      }
      case "INVALID":
      default:
        return { invalid: true, explicit: true };
    }
  }
  const legacy = coerceLegacyOperationSelection(input);
  if (legacy.invalid) return { invalid: true, explicit: true };
  return { invalid: false, explicit: hasExplicitUserSelection(legacy.metadata), metadata: legacy.metadata };
}

/**
 * STRICT coercion of the legacy raw metadata shape. Unlike the bounded ID
 * normalizer, a PRESENT but invalid `credentialSource` (unknown value, wrong
 * type, or empty) FAILS CLOSED (`invalid:true`) instead of being silently
 * dropped into the implicit `server_environment` path.
 */
export function coerceLegacyOperationSelection(raw: unknown): {
  invalid: boolean;
  metadata: SelectedOperationMetadata;
} {
  if (typeof raw !== "object" || raw === null) return { invalid: false, metadata: {} };
  const row = raw as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(row, "credentialSource") &&
    !isCredentialSource(row["credentialSource"])
  ) {
    return { invalid: true, metadata: {} };
  }
  const metadata = normalizeOperationSelection(raw);
  if (isCredentialSource(row["credentialSource"])) {
    metadata.credentialSource = row["credentialSource"];
  }
  return { invalid: false, metadata };
}

/**
 * Bounds + normalizes one operation's selection metadata into string IDs. This
 * is a bounded ID normalizer ONLY (provider/model/mode); credentialSource is
 * handled by `coerceLegacyOperationSelection` so a malformed present value can
 * never be silently omitted.
 */
export function normalizeOperationSelection(raw: unknown): SelectedOperationMetadata {
  if (typeof raw !== "object" || raw === null) return {};
  const row = raw as Record<string, unknown>;
  const providerId = typeof row["providerId"] === "string" ? row["providerId"].trim().slice(0, 64) : "";
  const modelId = typeof row["modelId"] === "string" ? row["modelId"].trim().slice(0, 128) : "";
  const out: SelectedOperationMetadata = {};
  if (row["mode"] === "user_selected" || row["mode"] === "server_default") out.mode = row["mode"];
  if (providerId) out.providerId = providerId;
  if (modelId) out.modelId = modelId;
  const costClass = row["selectedCostClass"];
  if (costClass === "free" || costClass === "budget" || costClass === "paid" || costClass === "variable") {
    out.selectedCostClass = costClass;
  }
  return out;
}

/**
 * Validates a user's TEXT selection against the CURRENT registry.
 * Returns the resolved (provider, modelId) when valid, or null (fail-closed).
 * An uncurated model, disabled/unavailable provider, or unknown provider -> null.
 */
export function validateUserTextSelection(
  requested: SelectedOperationMetadata | undefined,
  regs: RegisteredProvider[],
  credentialSource: CredentialSource = "server_environment"
): { providerId: string; modelId?: string } | null {
  if (!requested?.providerId) return null;
  const registered = findRegisteredProvider(regs, requested.providerId);
  if (!registered) return null;
  if (credentialSource === "session_only") {
    // Session availability is governed by the SESSION store, NOT the operator
    // env key. The provider must be structurally session-bindable; a missing
    // session key is handled later (fail closed, never env fallback).
    if (!supportsSessionBoundTextProvider(registered.provider.id)) return null;
  } else {
    if (registered.enabled === false) return null;
    if (!registered.provider.isAvailable()) return null;
  }
  const modelId = requested.modelId;
  if (modelId) {
    // Model must be in the provider's SERVER-OWNED selectable set (curated role
    // models for most providers; curated + live normalized catalog for
    // OpenRouter). An arbitrary client-supplied id is never a member.
    if (!new Set(selectableTextModels(registered.provider.id)).has(modelId)) return null;
  }
  return modelId ? { providerId: registered.provider.id, modelId } : { providerId: registered.provider.id };
}

/** True when a user-selected TEXT (provider, modelId) satisfies an operation's capability. */
export function userTextSelectionMatchesOperation(
  registered: RegisteredProvider,
  modelId: string | undefined,
  operation: AiOperation
): boolean {
  const required = operationRequiredCapabilities(operation);
  if (modelId) return hasAllCapabilities(effectiveCapabilities(registered, modelId), required);
  // No model pin: ANY curated role model for this operation must satisfy it.
  return roleModelsForProvider(registered.provider.id, operation).some((m) =>
    hasAllCapabilities(effectiveCapabilities(registered, m), required)
  );
}

/**
 * Resolves the ORDERED TEXT candidate list honoring effective selection, for
 * `resolveRoleCandidates`. Returns one of:
 *   - server_managed valid: the pinned (provider, model) only.
 *   - server_managed invalid: [] (fail closed; caller uses the deterministic path).
 *   - valid user selection: the selected (provider, model) only (NO cross-provider
 *     fallback; capability mismatch -> filtered out by the selector).
 *   - EXPLICIT user selection that is stale/invalid/unavailable: [] (fail closed
 *     to the deterministic path — NEVER the server default chain or another
 *     paid provider).
 *   - server_default (no explicit user_selected): all enabled providers in
 *     registry order (unchanged).
 */
export function resolveTextCandidateContext(
  operation: AiOperation,
  regs: RegisteredProvider[],
  userSelection?: SelectionInput
): {
  candidates: AiCandidate[];
  source: "server_managed" | "user_selected" | "server_default";
  credentialSource: CredentialSource;
  /** v0.8.0: set when a FREE-acknowledged selection is blocked (fail closed). */
  pricingBlocked?: string;
} {
  const coerced = coerceSelectionInput(userSelection);

  // A PRESENT but malformed selection payload FAILS CLOSED FIRST — BEFORE any
  // server-managed pin resolution. Operator-pin precedence means a VALID client
  // intent cannot override the pin; it does NOT permit malformed client intent
  // to execute paid provider work. INVALID -> ZERO provider execution.
  if (coerced.invalid) {
    return { candidates: [], source: "user_selected", credentialSource: "server_environment" };
  }

  const serverSelection = getTextSelection();

  // A VALID server-managed pin is authoritative and wins over any VALID client
  // intent. The pin FORCES server_environment credentials and ignores any user
  // session key entirely.
  if (serverSelection.selectionMode === "server_managed") {
    if (!serverSelection.valid || !serverSelection.selectedProviderId) {
      // Explicit invalid server pin -> no candidates (deterministic fallback arms).
      return { candidates: [], source: "server_managed", credentialSource: "server_environment" };
    }
    const registered = findRegisteredProvider(regs, serverSelection.selectedProviderId);
    if (!registered || registered.enabled === false) {
      return { candidates: [], source: "server_managed", credentialSource: "server_environment" };
    }
    const models = serverSelection.selectedModelId
      ? [serverSelection.selectedModelId]
      : roleModelsForProvider(registered.provider.id, operation);
    return {
      candidates: models.map((model) => ({
        provider: registered.provider,
        model,
        credentialSource: "server_environment" as const,
      })),
      source: "server_managed",
      credentialSource: "server_environment",
    };
  }

  // WHOSE credential authorizes the user's selected provider. Never inferred
  // from the provider/model; defaults to the operator environment.
  const userCredentialSource: CredentialSource = coerced.metadata?.credentialSource ?? "server_environment";
  const userSel = validateUserTextSelection(coerced.metadata, regs, userCredentialSource);
  if (userSel) {
    // v0.8.0 FREE -> PAID spend protection: a selection acknowledged as FREE
    // that the current trusted catalog no longer verifies as free FAILS CLOSED.
    const pricing = openRouterPricingGuard(
      userSel.providerId,
      userSel.modelId,
      coerced.metadata?.selectedCostClass
    );
    if (pricing.ok === false) {
      return {
        candidates: [],
        source: "user_selected",
        credentialSource: userCredentialSource,
        pricingBlocked: pricing.code,
      };
    }
    const registered = findRegisteredProvider(regs, userSel.providerId)!;
    if (userTextSelectionMatchesOperation(registered, userSel.modelId, operation)) {
      const models = userSel.modelId
        ? [userSel.modelId]
        : roleModelsForProvider(registered.provider.id, operation);
      return {
        candidates: buildTextCandidates(registered, models, userCredentialSource),
        source: "user_selected",
        credentialSource: userCredentialSource,
      };
    }
    // Capability mismatch -> NO cross-provider fallback: empty -> deterministic path.
    return { candidates: [], source: "user_selected", credentialSource: userCredentialSource };
  }

  // EXPLICIT user_selected that is stale/invalid/unavailable FAILS CLOSED: never
  // the server-default candidate chain, never a different paid provider. The
  // empty candidate list arms the operation's own deterministic fallback (or a
  // bounded provider-unavailable result) instead of silently executing Gemini.
  if (coerced.explicit) {
    return { candidates: [], source: "user_selected", credentialSource: userCredentialSource };
  }

  // server_default: all enabled providers in registry order, operator
  // environment credentials ONLY — a session key is NEVER consumed implicitly.
  const candidates: AiCandidate[] = [];
  for (const registered of regs) {
    if (registered.enabled === false) continue;
    for (const model of roleModelsForProvider(registered.provider.id, operation)) {
      candidates.push({ provider: registered.provider, model, credentialSource: "server_environment" });
    }
  }
  return { candidates, source: "server_default", credentialSource: "server_environment" };
}

/**
 * Builds (provider, model) candidates bound to the exact credential source.
 * `session_only` resolves a REQUEST-SCOPED provider from the session store and
 * returns `[]` when no live session key exists (fail closed, NEVER env fallback).
 */
function buildTextCandidates(
  registered: RegisteredProvider,
  models: string[],
  credentialSource: CredentialSource
): AiCandidate[] {
  if (credentialSource === "session_only") {
    const bound = createSessionBoundTextProvider(registered.provider.id);
    if (!bound) return [];
    return models.map((model) => ({ provider: bound, model, credentialSource: "session_only" as const }));
  }
  return models.map((model) => ({
    provider: registered.provider,
    model,
    credentialSource: "server_environment" as const,
  }));
}

/**
 * Resolves the EFFECTIVE, EXECUTABLE text candidates for an operation: the
 * effective-selection candidate list (server-managed pin > valid user selection >
 * server_default) filtered by the operation's required capabilities + runtime
 * availability. An EMPTY list means no AI provider can execute this operation
 * under the current selection, so the caller must use its deterministic fallback.
 *
 * This is the shared gate replacements for consumers that previously keyed on a
 * single default provider's availability (`getDefaultAiProvider().isAvailable()`):
 * it honors a valid selected/pinned provider even when the default provider is
 * unavailable, fails closed on an invalid explicit selection, and never
 * cross-executes a different provider.
 */
export function resolveExecutableTextCandidates(
  operation: AiOperation,
  regs: RegisteredProvider[] = getRegisteredProviders(),
  userSelection?: SelectionInput
): AiCandidate[] {
  const { candidates } = resolveTextCandidateContext(operation, regs, userSelection);
  return selectCandidates(regs, candidates, operationRequiredCapabilities(operation));
}

/**
 * v0.8.0 FLAG fix: surfaces a FREE -> PAID / pricing-unverified block for a TEXT
 * selection BEFORE any provider execution. It mirrors the guard inside
 * `resolveTextCandidateContext` (only an OTHERWISE-VALID selection can be
 * pricing-blocked; an arbitrary/invalid selection keeps its normal fail-closed
 * behavior). Returns undefined when there is no pricing block.
 */
export function textSelectionPricingBlock(
  userSelection?: SelectionInput,
  regs: RegisteredProvider[] = getRegisteredProviders()
): { code: PricingGuardCode; message: string } | undefined {
  const coerced = coerceSelectionInput(userSelection);
  if (coerced.invalid || !coerced.metadata) return undefined;
  const credentialSource: CredentialSource = coerced.metadata.credentialSource ?? "server_environment";
  const userSel = validateUserTextSelection(coerced.metadata, regs, credentialSource);
  if (!userSel) return undefined;
  const guard = openRouterPricingGuard(
    userSel.providerId,
    userSel.modelId,
    coerced.metadata.selectedCostClass
  );
  if (guard.ok === false) return { code: guard.code, message: guard.message };
  return undefined;
}

/**
 * Validates a user's IMAGE selection against the image registry.
 *
 * CREDENTIAL-SOURCE AWARE (BYOK-5F): for `session_only`, the operator-env
 * `enabled`/`isAvailable()` gates are BYPASSED (a provider can be executable with
 * a valid session credential even when no operator env key exists) while the
 * provider identity + curated model allowlist are still enforced. A missing
 * session credential is resolved later (fail closed), never substituted with env.
 * For `server_environment`, the existing enabled/availability checks are kept.
 */
export function validateUserImageSelection(
  requested: SelectedOperationMetadata | undefined,
  regs: RegisteredImageProvider[],
  credentialSource: CredentialSource = "server_environment"
): { providerId: string; modelId?: string } | null {
  if (!requested?.providerId) return null;
  const registered = findRegisteredImageProvider(requested.providerId);
  if (!registered) return null;
  if (credentialSource === "session_only") {
    if (!supportsSessionBoundImageProvider(registered.provider.id)) return null;
  } else {
    if (registered.enabled === false) return null;
    if (!registered.provider.isAvailable()) return null;
  }
  const modelId = requested.modelId;
  if (modelId) {
    const selectable: string[] = selectableImageModels(registered);
    if (!selectable.includes(modelId)) return null;
  }
  return modelId ? { providerId: registered.provider.id, modelId } : { providerId: registered.provider.id };
}

/** The effective image selection result (observability + execution source). */
export interface EffectiveImageSelection {
  provider: ImageProvider | null;
  model: string | undefined;
  source: "server_managed" | "user_selected" | "server_default";
  /**
   * True only when the request carried a PRESENT-but-malformed selection
   * payload (strict `INVALID` intent). The route uses this to return a distinct
   * bounded "selection invalid" failure instead of "provider not configured".
   */
  invalidIntent: boolean;
  /** v0.8.0: set when a FREE-acknowledged image selection is blocked. */
  pricingBlocked?: string;
  pricingMessage?: string;
}

/**
 * Resolves the EFFECTIVE image (provider, model). FAIL CLOSED:
 *   - server_managed valid -> pinned provider/model.
 *   - server_managed EXPLICIT but INVALID -> provider null (zero execution).
 *   - valid user selection -> selected provider/model only (no cross fallback).
 *   - EXPLICIT user selection that is stale/invalid/unavailable -> provider null
 *     (ZERO image execution — never a silent Gemini-image fallback).
 *   - otherwise (no explicit user_selected) -> safe server default (Gemini image).
 */
export function resolveEffectiveImageSelection(requested?: SelectionInput): EffectiveImageSelection {
  const regs = getRegisteredImageProviders();
  const coerced = coerceSelectionInput(requested);

  // A PRESENT but malformed selection payload FAILS CLOSED FIRST — BEFORE any
  // server-managed pin resolution. A VALID client intent cannot override the
  // pin; malformed client intent must NEVER execute paid provider work.
  if (coerced.invalid) {
    return { provider: null, model: undefined, source: "user_selected", invalidIntent: true };
  }

  const serverSelection = getImageSelection();

  // A VALID server-managed pin is authoritative and wins over any VALID client intent.
  if (serverSelection.selectionMode === "server_managed") {
    const registered = serverSelection.valid
      ? findRegisteredImageProvider(serverSelection.selectedProviderId)
      : undefined;
    if (serverSelection.valid && registered) {
      return {
        provider: registered.provider,
        model: serverSelection.selectedModelId ?? registered.defaultModel,
        source: "server_managed",
        invalidIntent: false,
      };
    }
    return { provider: null, model: undefined, source: "server_managed", invalidIntent: false };
  }

  // WHOSE credential authorizes the user's selected image provider. Never
  // inferred from the provider/model; defaults to the operator environment.
  const userCredentialSource: CredentialSource = coerced.metadata?.credentialSource ?? "server_environment";
  const userSel = validateUserImageSelection(coerced.metadata, regs, userCredentialSource);
  if (userSel) {
    // v0.8.0 FREE -> PAID spend protection (image surfaces).
    const pricing = openRouterPricingGuard(
      userSel.providerId,
      userSel.modelId,
      coerced.metadata?.selectedCostClass
    );
    if (pricing.ok === false) {
      return {
        provider: null,
        model: undefined,
        source: "user_selected",
        invalidIntent: false,
        pricingBlocked: pricing.code,
        pricingMessage: pricing.message,
      };
    }
    const registered = findRegisteredImageProvider(userSel.providerId)!;
    if (userCredentialSource === "session_only") {
      // BYOK-5F: a REQUEST-SCOPED provider bound to the EXACT image provider's
      // session credential. Missing/expired/revoked -> null (fail closed); there
      // is NO env fallback and NO cross-provider fallback.
      const bound = createSessionBoundImageProvider(userSel.providerId);
      if (!bound) {
        return { provider: null, model: undefined, source: "user_selected", invalidIntent: false };
      }
      return {
        provider: bound,
        model: userSel.modelId ?? registered.defaultModel,
        source: "user_selected",
        invalidIntent: false,
      };
    }
    return {
      provider: registered.provider,
      model: userSel.modelId ?? registered.defaultModel,
      source: "user_selected",
      invalidIntent: false,
    };
  }

  // EXPLICIT user_selected that is stale/invalid/unavailable FAILS CLOSED to a
  // NULL provider (ZERO image execution) — never a silent Gemini-image fallback.
  if (coerced.explicit) {
    return { provider: null, model: undefined, source: "user_selected", invalidIntent: false };
  }

  const defaultReg = regs[0];
  return {
    provider: defaultReg.provider,
    model: defaultReg.defaultModel,
    source: "server_default",
    invalidIntent: false,
  };
}