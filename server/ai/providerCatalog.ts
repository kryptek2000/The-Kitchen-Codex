/**
 * The Kitchen Codex — Provider / Model Catalog (BYOK-1 foundation).
 *
 * A server-owned, READ-ONLY catalog of the AI providers and the curated models
 * this deployment can actually execute — text providers (the `AiProvider`
 * abstraction) AND image providers (the `ImageProvider` abstraction). It is the
 * observability surface that enables the Provider Settings UI to show the truth
 * about provider/model capability WITHOUT granting BYOK-style selection, key
 * entry, or write access.
 *
 * SECURITY / TRUTH INVARIANTS:
 *   - The catalog NEVER exposes a key, token, masked secret, env name, model
 *     prompt, or provider-secret metadata — only booleans, ids, names, model
 *     ids, formats, and byte limits.
 *   - Capability truth comes ONLY from the registry (`effectiveCapabilities`):
 *     provider baseline + curated per-model overrides. An unknown model NEVER
 *     gains a capability automatically; it falls back to the provider baseline.
 *   - Models are sourced EXCLUSIVELY from the shared server-owned curated set
 *     (`curatedTextModels(providerId)`, itself derived from AI_OPERATIONS +
 *     `roleModelsForProvider`) — the exact same source connection-test,
 *     user-selection, and server-pin validation use. The catalog does NOT
 *     invent or probe for models.
 *   - Image visibility reflects the PRODUCTION image provider singleton
 *     (`GeminiImageProvider` + `DEFAULT_GEMINI_IMAGE_MODEL`). The
 *     `DeterministicImageProvider` test seam is never catalogued.
 *   - Deterministic + network-free: no request executes, no remote connection,
 *     no provider introspection. `configured`/`enabled`/`available` mirror the
 *     provider-status semantics (see `server/ai/providerStatus.ts`).
 *
 * BYOK-1/2 SCOPE: this is observability ONLY. It changes no provider behavior and
 * exposes no selection/write surface; the payload additionally reports the
 * effective SERVER-MANAGED selection truth (BYOK-2) so the UI can display it
 * read-only without a mutation channel.
 */

import type { AiCapabilities } from "./types.js";
import type { RegisteredProvider } from "./providerRegistry.js";
import { effectiveCapabilities, getRegisteredProviders } from "./providerRegistry.js";
import {
  getServerSecretSync,
  providerSecretIdForProvider,
} from "../platform/ServerEnvironmentSecretAdapter.js";
import type { SecretStorageScope } from "../../src/application/adapters/SecretAdapter.js";
import { roleModelsForProvider, curatedTextModels, selectableTextModels } from "./roleModels.js";
import { AI_OPERATIONS } from "./operations.js";
import {
  getImageSelection,
  getTextSelection,
  type ProviderSelectionState,
} from "./providerSelection.js";
import {
  getRegisteredImageProviders,
  findRegisteredImageProvider,
  selectableImageModels,
} from "./imageProviderRegistry.js";
import type { GeneratedImageMime } from "../../src/core/recipeImage.js";
import { connectionTestKindForProvider, type ConnectionTestKind } from "./connectionTest.js";
import { findRegisteredProvider } from "./providerRegistry.js";
import { isSessionByokSupportedDeployment } from "./sessionByokDeployment.js";
import {
  findOpenRouterCatalogModel,
  getOpenRouterCatalogSnapshot,
  isCapabilityVerifiedOpenRouterTextModel,
  isCompatibleOpenRouterTextModel,
  isSelectableOpenRouterTextModel,
  openRouterSelectableTextModelIds,
  openRouterSelectableImageModelIds,
  type OpenRouterCatalogModel,
} from "./openRouterCatalog.js";
import {
  supportsSessionBoundTextProvider,
  supportsSessionBoundImageProvider,
} from "./credentialResolver.js";

/** A single curated text model row in the catalog. */
export interface ProviderCatalogTextModel {
  /** Curated provider model id (e.g. `gemini-3.7-flash`). */
  id: string;
  /** True when this model is the primary (first) role candidate for any operation. */
  default: boolean;
  /** Per-model EFFECTIVE capabilities (provider baseline + curated override). */
  capabilities: AiCapabilities;
  /** Non-secret display name (dynamic catalog; falls back to the id). */
  displayName?: string;
  /** Input context window length (dynamic catalog; 0 when unknown). */
  contextLength?: number;
  /** Normalized per-token pricing (dynamic catalog; secret-free). */
  pricing?: {
    promptPerToken: number | null;
    completionPerToken: number | null;
    imageOutputPerToken: number | null;
    variable: boolean;
  };
  /** Proven zero-cost (dynamic catalog truth). */
  isFree?: boolean;
  /** True only when every pricing field was parsed finite from a live record. */
  pricingVerified?: boolean;
  /** Server-owned verified strict-structured compatibility. */
  structuredVerified?: boolean;
  /** True when a CURRENT runtime capability verification made this model executable. */
  capabilityVerified?: boolean;
  /** True when the model may execute on the current Kitchen Codex transport. */
  executionCompatible?: boolean;
  /** UI compatibility state (never inferred optimistically). */
  compatibility?: "compatible" | "experimental" | "unsupported";
  /** An OpenRouter router id (e.g. `openrouter/free`). */
  isRouter?: boolean;
  /** User-facing cost class. */
  costClass?: "free" | "budget" | "paid" | "variable";
  /** Input/output modalities (dynamic catalog). */
  inputModalities?: string[];
  outputModalities?: string[];
  /** Compact capability badges derived ONLY from catalog metadata. */
  vision?: boolean;
  largeContext?: boolean;
}

/** A read-only text-provider row in the catalog. */
export interface ProviderCatalogTextProvider {
  providerId: string;
  name: string;
  /** A server operator secret exists for this provider. */
  configured: boolean;
  /** The registry descriptor permits selection (authoritative). */
  enabled: boolean;
  /** Cheap local availability check (no network probe). */
  available: boolean;
  /** Truthful storage scope of the provider's operator secret. */
  storageScope: SecretStorageScope;
  /** Whether provider secrets can be written through the secret boundary. */
  supportsSecretWrites: boolean;
  /** The connection-test surface for this provider. */
  connectionTest: ConnectionTestKind;
  /** True when the user may select this provider on this surface. */
  selectable: boolean;
  /**
   * BYOK-5F: server-owned, static capability truth — whether this provider can be
   * authorized by an EXACT provider-scoped SESSION credential. When true (and the
   * deployment supports session-only BYOK), the provider is selectable with
   * `credentialSource=session_only` EVEN IF its operator environment credential is
   * unconfigured/unavailable. Never a secret.
   */
  sessionKeySupported: boolean;
  /** Curated models this provider can actually execute (structurally unique). */
  models: ProviderCatalogTextModel[];
  /**
   * v0.8.0: DISCOVERED but NON-SELECTABLE models (informational only). These are
   * never executable/selectable; the picker may display them as experimental.
   */
  discoveredModels?: ProviderCatalogTextModel[];
}

/** A single curated image model row in the catalog. */
export interface ProviderCatalogImageModel {
  id: string;
  default: boolean;
  /** Non-secret display name (dynamic catalog; falls back to the id). */
  displayName?: string;
  /** Normalized per-token pricing (dynamic catalog; secret-free). */
  pricing?: {
    promptPerToken: number | null;
    completionPerToken: number | null;
    imageOutputPerToken: number | null;
    variable: boolean;
  };
  /** Proven zero-cost (dynamic catalog truth). */
  isFree?: boolean;
  /** True only when every pricing field was parsed finite from a live record. */
  pricingVerified?: boolean;
  /** UI compatibility state (curated `/images` transport allowlist). */
  compatibility?: "compatible" | "experimental" | "unsupported";
  /** User-facing cost class. */
  costClass?: "free" | "budget" | "paid" | "variable";
}

/** A read-only image-provider row in the catalog. */
export interface ProviderCatalogImageProvider {
  providerId: string;
  name: string;
  configured: boolean;
  enabled: boolean;
  available: boolean;
  /** The connection-test surface for this provider. */
  connectionTest: ConnectionTestKind;
  /** True when the user may select this provider on this surface. */
  selectable: boolean;
  /**
   * BYOK-5F: server-owned, static capability truth — whether this image provider
   * can be authorized by an EXACT provider-scoped SESSION credential (independent
   * of the operator environment key). Never a secret.
   */
  sessionKeySupported: boolean;
  /** Provider-owned image-generation capability truth. */
  imageGeneration: boolean;
  /** Generated MIME types the provider emits (subset of the shared allowlist). */
  formats: GeneratedImageMime[];
  /** Provider-documented hard byte limit. */
  maxBytes: number;
  models: ProviderCatalogImageModel[];
}

/** The full provider + model catalog (server-owned truth, secret-free). */
export interface ProviderCatalog {
  textProviders: ProviderCatalogTextProvider[];
  imageProviders: ProviderCatalogImageProvider[];
  /**
   * Effective SERVER-MANAGED selection truth (BYOK-2), non-secret: mode plus the
   * validated provider/model pins. When unset -> `server_default`; when a pin is
   * invalid -> `valid:false` and the runtime FAILS CLOSED for that surface (text:
   * no AI candidates, so the deterministic fallback engages; image: no provider
   * resolves, so image generation returns a bounded not-configured failure). An
   * invalid pin NEVER silently falls back to another provider.
   */
  selection: {
    text: ProviderSelectionState;
    image: ProviderSelectionState;
    /**
     * True when a user selection is currently PERMITTED on a surface:
     * honored ONLY when there is no valid server-managed pin (server_default).
     * When a valid server-managed pin exists, this is false and the UI must
     * expose the selection as read-only (`userSelectionAllowed` gated in the
     * preference storage + per-request header transport).
     */
    userSelectionAllowed: { text: boolean; image: boolean };
    /**
     * RUNTIME PROVIDER-AVAILABILITY truth, non-secret and DISTINCT from the
     * config-valid `valid` flag above. `valid` answers "is the pin syntactically/
     * config correct?" (registered + enabled + curated model); `executable`
     * answers "is the effective provider configured/available RIGHT NOW?" — it
     * additionally requires the provider to report runtime availability
     * (`isAvailable()`).
     *
     * This is DELIBERATELY NOT an operation-readiness claim: a provider may be
     * available yet unable to satisfy a specific operation's capability contract
     * (e.g. DeepSeek has no schema-constrained structured output / webSearch).
     * The UI labels this "Runtime provider available/unavailable".
     *
     *   - server_managed: true only when `valid` AND the pinned provider is
     *     runtime-available.
     *   - server_default: true when at least one provider in the default chain
     *     (text) / the default image provider (image) is runtime-available.
     */
    executable: { text: boolean; image: boolean };
  };
  /**
   * BYOK-5E: server-reported DEPLOYMENT capability for session-only BYOK (local/
   * single-user only). Non-secret; drives the UI's enable/disable of session-key
   * controls. The UI MUST NOT infer this from the browser hostname.
   */
  sessionByokSupported: boolean;
  /**
   * v0.8.0: non-secret dynamic OpenRouter catalog observability (source, counts,
   * fetch time). Never contains a secret, URL, or raw upstream payload.
   */
  dynamicCatalog?: {
    source: "live" | "cached" | "curated_fallback";
    fetchedAt: number;
    pricingFresh: boolean;
    textModelCount: number;
    freeTextModelCount: number;
    verifiedFreeTextCount: number;
    selectableTextCount: number;
    imageModelCount: number;
    freeImageModelCount: number;
    selectableImageCount: number;
    freeRouterVerified: boolean;
  };
}

/**
 * Computes whether the user is currently allowed to override the surface
 * selection: true ONLY when selection mode is server_default (a valid
 * server-managed pin always blocks user selection override).
 */
function userSelectionAllowed(selection: ProviderSelectionState): boolean {
  return selection.selectionMode === "server_default";
}

/**
 * Runtime executability for a TEXT selection (see `selection.executable`).
 * Distinct from config `valid`: a config-valid pin whose provider is not
 * runtime-available is executable:false (truthful, no cross-provider fallback).
 */
function textSelectionExecutable(selection: ProviderSelectionState): boolean {
  const regs = getRegisteredProviders();
  if (selection.selectionMode === "server_managed") {
    if (!selection.valid || !selection.selectedProviderId) return false;
    const registered = findRegisteredProvider(regs, selection.selectedProviderId);
    return Boolean(
      registered && registered.enabled !== false && registered.provider.isAvailable()
    );
  }
  return regs.some(
    (r) =>
      r.enabled !== false &&
      r.provider.isAvailable() &&
      curatedTextModels(r.provider.id).length > 0
  );
}

/**
 * Runtime executability for an IMAGE selection (see `selection.executable`).
 * Distinct from config `valid`: a config-valid pin whose provider is not
 * runtime-available is executable:false (truthful, no cross-provider fallback).
 */
function imageSelectionExecutable(selection: ProviderSelectionState): boolean {
  if (selection.selectionMode === "server_managed") {
    if (!selection.valid || !selection.selectedProviderId) return false;
    const registered = findRegisteredImageProvider(selection.selectedProviderId);
    return Boolean(
      registered && registered.enabled !== false && registered.provider.isAvailable()
    );
  }
  const registered = getRegisteredImageProviders()[0];
  return Boolean(registered && registered.enabled !== false && registered.provider.isAvailable());
}

/**
 * The selectable text models for a provider: curated role models for most
 * providers; curated + live normalized catalog for OpenRouter (v0.8.0). This is
 * the exact source connection-test, user-selection, and server-pin validation
 * use, so all consumers agree by construction.
 */
function curatedModelsForProvider(registered: RegisteredProvider): string[] {
  return selectableTextModels(registered.provider.id);
}

/** Computes the models whose FIRST role occurrence marks them as the primary candidate. */
function primaryRoleModels(registered: RegisteredProvider): Set<string> {
  const primary = new Set<string>();
  for (const operation of AI_OPERATIONS) {
    const first = roleModelsForProvider(registered.provider.id, operation)[0];
    if (first) primary.add(first);
  }
  return primary;
}

function textProviderRows(regs: RegisteredProvider[]): ProviderCatalogTextProvider[] {
  return regs.map((registered) => {
    const secretId = providerSecretIdForProvider(registered.provider.id);
    const configured = secretId ? Boolean(getServerSecretSync(secretId)) : false;
    const enabled = registered.enabled !== false;
    const available = registered.provider.isAvailable();
    const primary = primaryRoleModels(registered);
    const isOpenRouter = registered.provider.id === "openrouter";

    const toRow = (model: OpenRouterCatalogModel): ProviderCatalogTextModel => {
      // Dynamic text executability is computed at call time so a just-recorded
      // capability verification is reflected without a catalog refetch. Image
      // executability stays the curated transport allowlist.
      const isImage = model.capabilities.imageGeneration;
      const selectable = isImage ? model.executionCompatible : isSelectableOpenRouterTextModel(model);
      const capabilityVerified = !isImage && isCapabilityVerifiedOpenRouterTextModel(model);
      return {
        id: model.modelId,
        default: primary.has(model.modelId),
        capabilities: effectiveCapabilities(registered, model.modelId),
        displayName: model.displayName,
        contextLength: model.contextLength,
        pricing: model.pricing,
        isFree: model.isFree,
        pricingVerified: model.pricingVerified,
        structuredVerified: model.structuredVerified,
        capabilityVerified,
        executionCompatible: selectable,
        compatibility: selectable
          ? "compatible"
          : model.capabilities.structuredOutput
          ? "experimental"
          : "unsupported",
        isRouter: model.isRouter,
        costClass: model.costClass,
        inputModalities: model.inputModalities,
        outputModalities: model.outputModalities,
        vision: model.capabilities.vision,
        largeContext: model.capabilities.largeContext,
      };
    };

    const models: ProviderCatalogTextModel[] = curatedModelsForProvider(registered).map((model) => {
      if (isOpenRouter) {
        const dyn = findOpenRouterCatalogModel(model);
        if (dyn) return toRow(dyn);
      }
      return {
        id: model,
        default: primary.has(model),
        capabilities: effectiveCapabilities(registered, model),
      };
    });

    // Informational-only discovered models (never selectable/executable).
    let discoveredModels: ProviderCatalogTextModel[] | undefined;
    if (isOpenRouter) {
      const snap = getOpenRouterCatalogSnapshot();
      discoveredModels = snap.textModels
        .filter((m) => isCompatibleOpenRouterTextModel(m) && !isSelectableOpenRouterTextModel(m))
        .slice(0, 250)
        .map(toRow);
    }

    return {
      providerId: registered.provider.id,
      name: registered.provider.name,
      configured,
      enabled,
      available,
      storageScope: "server_environment",
      supportsSecretWrites: false,
      connectionTest: connectionTestKindForProvider(registered.provider.id, "text"),
      selectable: enabled && available && models.length > 0,
      sessionKeySupported: supportsSessionBoundTextProvider(registered.provider.id),
      models,
      ...(discoveredModels ? { discoveredModels } : {}),
    };
  });
}

/**
 * The production image-provider catalog rows (from the REAL image registry). The
 * registry exposes GeminiImageProvider + OpenRouterImageProvider — the
 * `DeterministicImageProvider` seam is never catalogued; `configured`/`available`
 * reflect the real server operator secrets, and `models` is the provider's FULL
 * curated image-model set (default model marked).
 */
function imageProviderRows(): ProviderCatalogImageProvider[] {
  return getRegisteredImageProviders().map((registered) => {
    const capabilities = registered.provider.capabilities;
    const secretId = providerSecretIdForProvider(registered.provider.id);
    const selectableModels = selectableImageModels(registered);
    const enabled = registered.enabled !== false;
    const available = registered.provider.isAvailable();
    const models: ProviderCatalogImageModel[] = selectableModels.map((model) => {
      const row: ProviderCatalogImageModel = {
        id: model,
        default: model === registered.defaultModel,
        compatibility: "compatible",
      };
      if (registered.provider.id === "openrouter-image") {
        const dyn = findOpenRouterCatalogModel(model);
        if (dyn) {
          row.displayName = dyn.displayName;
          row.pricing = dyn.pricing;
          row.isFree = dyn.isFree;
          row.pricingVerified = dyn.pricingVerified;
          row.costClass = dyn.costClass;
        }
      }
      return row;
    });
    return {
      providerId: registered.provider.id,
      name: registered.provider.name,
      configured: secretId ? Boolean(getServerSecretSync(secretId)) : false,
      enabled,
      available,
      connectionTest: connectionTestKindForProvider(registered.provider.id, "image"),
      selectable: enabled && available && selectableModels.length > 0,
      sessionKeySupported: supportsSessionBoundImageProvider(registered.provider.id),
      imageGeneration: capabilities.imageGeneration,
      formats: [...(capabilities.formats ?? [])],
      maxBytes: capabilities.maxBytes ?? 0,
      models,
    };
  });
}

/**
 * Builds the current provider + model catalog from the authoritative registries
 * (text + image) and the effective server-managed selection truth. Deterministic
 * (registry order), network-free, and secret-free. Safe to call on every request.
 */
export function buildProviderCatalog(): ProviderCatalog {
  const textSelection = getTextSelection();
  const imageSelection = getImageSelection();
  const snapshot = getOpenRouterCatalogSnapshot();
  return {
    textProviders: textProviderRows(getRegisteredProviders()),
    imageProviders: imageProviderRows(),
    selection: {
      text: textSelection,
      image: imageSelection,
      userSelectionAllowed: {
        text: userSelectionAllowed(textSelection),
        image: userSelectionAllowed(imageSelection),
      },
      executable: {
        text: textSelectionExecutable(textSelection),
        image: imageSelectionExecutable(imageSelection),
      },
    },
    sessionByokSupported: isSessionByokSupportedDeployment(),
    dynamicCatalog: {
      source: snapshot.source,
      fetchedAt: snapshot.fetchedAt,
      pricingFresh: snapshot.pricingFresh,
      textModelCount: snapshot.textModels.length,
      freeTextModelCount: snapshot.textModels.filter((m) => m.isFree).length,
      verifiedFreeTextCount: snapshot.textModels.filter((m) => m.isFree && m.pricingVerified).length,
      selectableTextCount: openRouterSelectableTextModelIds().length,
      imageModelCount: snapshot.imageModels.length,
      freeImageModelCount: snapshot.imageModels.filter((m) => m.isFree).length,
      selectableImageCount: openRouterSelectableImageModelIds().length,
      freeRouterVerified: snapshot.textModels.some(
        (m) => m.isRouter && m.isFree && m.pricingVerified
      ),
    },
  };
}