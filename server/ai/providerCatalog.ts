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
 *   - Models are sourced EXCLUSIVELY from the curated role-model configuration
 *     (`roleModelsForProvider`) — the same source selection actually uses. The
 *     catalog does NOT invent or probe for models.
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
import { roleModelsForProvider } from "./roleCandidates.js";
import { AI_OPERATIONS } from "./operations.js";
import {
  getImageSelection,
  getTextSelection,
  type ProviderSelectionState,
} from "./providerSelection.js";
import { getRegisteredImageProviders } from "./imageProviderRegistry.js";
import type { GeneratedImageMime } from "../../src/core/recipeImage.js";

/** A single curated text model row in the catalog. */
export interface ProviderCatalogTextModel {
  /** Curated provider model id (e.g. `gemini-3.7-flash`). */
  id: string;
  /** True when this model is the primary (first) role candidate for any operation. */
  default: boolean;
  /** Per-model EFFECTIVE capabilities (provider baseline + curated override). */
  capabilities: AiCapabilities;
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
  /** Curated models this provider can actually execute (structurally unique). */
  models: ProviderCatalogTextModel[];
}

/** A single curated image model row in the catalog. */
export interface ProviderCatalogImageModel {
  id: string;
  default: boolean;
}

/** A read-only image-provider row in the catalog. */
export interface ProviderCatalogImageProvider {
  providerId: string;
  name: string;
  configured: boolean;
  enabled: boolean;
  available: boolean;
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
   * invalid -> `valid:false` and the runtime uses the safe server default.
   */
  selection: {
    text: ProviderSelectionState;
    image: ProviderSelectionState;
  };
}

/**
 * Collects the structurally-unique curated models for a provider, deduped in
 * role-model order. Only `roleModelsForProvider` is consulted — the catalog
 * never probes or invents models.
 */
function curatedModelsForProvider(registered: RegisteredProvider): string[] {
  const models: string[] = [];
  for (const operation of AI_OPERATIONS) {
    for (const model of roleModelsForProvider(registered.provider.id, operation)) {
      if (!models.includes(model)) models.push(model);
    }
  }
  return models;
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
    const primary = primaryRoleModels(registered);
    const models: ProviderCatalogTextModel[] = curatedModelsForProvider(registered).map(
      (model) => ({
        id: model,
        default: primary.has(model),
        capabilities: effectiveCapabilities(registered, model),
      })
    );
    return {
      providerId: registered.provider.id,
      name: registered.provider.name,
      configured,
      enabled: registered.enabled !== false,
      available: registered.provider.isAvailable(),
      storageScope: "server_environment",
      supportsSecretWrites: false,
      models,
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
    const curated = registered.models ?? [registered.defaultModel];
    const models: ProviderCatalogImageModel[] = curated.map((model) => ({
      id: model,
      default: model === registered.defaultModel,
    }));
    return {
      providerId: registered.provider.id,
      name: registered.provider.name,
      configured: secretId ? Boolean(getServerSecretSync(secretId)) : false,
      enabled: registered.enabled !== false,
      available: registered.provider.isAvailable(),
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
  return {
    textProviders: textProviderRows(getRegisteredProviders()),
    imageProviders: imageProviderRows(),
    selection: {
      text: getTextSelection(),
      image: getImageSelection(),
    },
  };
}