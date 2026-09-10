/**
 * The Kitchen Codex — SERVER-MANAGED provider/model selection config (BYOK-2).
 *
 * A validated, server-owned selection layer for TEXT (`AiProvider`) and IMAGE
 * (`ImageProvider`) AI. The operator pins providers/models via server env:
 *
 *   KITCHEN_CODEX_TEXT_PROVIDER / KITCHEN_CODEX_TEXT_MODEL
 *   KITCHEN_CODEX_IMAGE_PROVIDER / KITCHEN_CODEX_IMAGE_MODEL
 *
 * This is BYOK-2 (SERVER-MANAGED), NOT user BYOK:
 *   - No browser-entered API keys, no session/persistent secret storage.
 *   - No `VITE_*` ever.
 *   - No dynamic arbitrary environment access: ONLY the four canonical env names
 *     above are read, and the model id is validated against the curated catalog.
 *
 * SEMANTICS:
 *   - `server_default`  -> no pin configured; behavior is unchanged from before
 *                          (the safe Gemini image default is used).
 *   - `server_managed`  -> a pin is configured. `valid` is TRUE only when the
 *                          provider is registered+enabled AND the model (if any)
 *                          exists in the curated catalog. An EXPLICIT invalid
 *                          pin reports itself truthfully (`valid:false`) and the
 *                          RUNTIME FAILS CLOSED: no image provider is resolved
 *                          and the route returns a bounded not-configured/invalid
 *                          failure — an invalid pin NEVER silently falls back to
 *                          Gemini and never executes an unknown provider/model.
 *   - Selected fields expose only provider/model IDS — never secret values.
 *
 * CAPABILITY TRUTH stays in the registry (+ per-model overrides) and in the
 * candidate selector. Pinned mode pins the provider (and optionally the exact
 * model); it does NOT grant capabilities.
 */

import { AI_OPERATIONS } from "./operations.js";
import { findRegisteredProvider, getRegisteredProviders } from "./providerRegistry.js";
import { roleModelsForProvider } from "./roleCandidates.js";
import {
  curatedImageModels,
  findRegisteredImageProvider,
  getDefaultImageProviderPair,
  getRegisteredImageProviders,
} from "./imageProviderRegistry.js";
import type { ImageProvider } from "./imageProvider.js";

/** The effective selection mode reported to catalog/UI (truth, non-secret). */
export type SelectionMode = "server_default" | "server_managed";

/** Read-only selection truth exposed by the catalog (never a secret value). */
export interface ProviderSelectionState {
  selectionMode: SelectionMode;
  /** Present only when server-managed (env provider pin). */
  selectedProviderId?: string;
  /** Present only when server-managed (env model pin; optional). */
  selectedModelId?: string;
  /**
   * False when the pin references an unknown/disabled provider or a model that is
   * not in the curated catalog. FAIL CLOSED: an explicit invalid pin resolves no
   * provider at runtime (never a silent fallback to the safe server default).
   */
  valid: boolean;
}

/** Canonical read-only server-managed text-selection env names. */
export const TEXT_PROVIDER_ENV = "KITCHEN_CODEX_TEXT_PROVIDER";
export const TEXT_MODEL_ENV = "KITCHEN_CODEX_TEXT_MODEL";
/** Canonical read-only server-managed image-selection env names. */
export const IMAGE_PROVIDER_ENV = "KITCHEN_CODEX_IMAGE_PROVIDER";
export const IMAGE_MODEL_ENV = "KITCHEN_CODEX_IMAGE_MODEL";

const SELECTION_ENV_NAMES = [TEXT_PROVIDER_ENV, TEXT_MODEL_ENV, IMAGE_PROVIDER_ENV, IMAGE_MODEL_ENV] as const;

/** Reads + trims one of the four canonical selection env vars (never arbitrary env). */
function envValue(name: (typeof SELECTION_ENV_NAMES)[number]): string | undefined {
  const raw = process.env?.[name];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The curated model set a text provider can execute (from role-model config). */
function textCuratedModels(providerId: string): Set<string> {
  const models = new Set<string>();
  for (const operation of AI_OPERATIONS) {
    for (const model of roleModelsForProvider(providerId, operation)) {
      models.add(model);
    }
  }
  return models;
}

/** Validation-truth for the TEXT selection (does NOT consult runtime availability). */
export function getTextSelection(): ProviderSelectionState {
  const providerId = envValue(TEXT_PROVIDER_ENV);
  if (!providerId) return { selectionMode: "server_default", valid: true };
  const registered = findRegisteredProvider(getRegisteredProviders(), providerId);
  const modelId = envValue(TEXT_MODEL_ENV);
  const curated = textCuratedModels(providerId);
  const modelValid = !modelId || curated.has(modelId);
  const valid = Boolean(registered && registered.enabled !== false) && modelValid;
  return {
    selectionMode: "server_managed",
    selectedProviderId: providerId,
    selectedModelId: modelId,
    valid,
  };
}

/** Validation-truth for the IMAGE selection (does NOT consult runtime availability). */
export function getImageSelection(): ProviderSelectionState {
  const providerId = envValue(IMAGE_PROVIDER_ENV);
  if (!providerId) return { selectionMode: "server_default", valid: true };
  const registered = findRegisteredImageProvider(providerId);
  const modelId = envValue(IMAGE_MODEL_ENV);
  // The pinned model must be in the provider's CURATED image-model set.
  const modelValid = !modelId || (registered ? curatedImageModels(registered).has(modelId) : false);
  const valid = Boolean(registered && registered.enabled !== false) && modelValid;
  return {
    selectionMode: "server_managed",
    selectedProviderId: providerId,
    selectedModelId: modelId,
    valid,
  };
}

/**
 * Resolves the runtime image provider pair honoring server-managed selection.
 * If the selection is UNSET, the safe server default is returned (real Gemini +
 * its proven default model — the deterministic seam is never a default).
 * If the selection is EXPLICITLY set but INVALID, null is returned (FAIL CLOSED):
 * no provider executes — the route surfaces a bounded not-configured/invalid
 * failure, and Gemini is NEVER silently invoked (no surprise cross-provider cost).
 */
export function resolveSelectedImagePair(): { provider: ImageProvider; model: string } | null {
  const selection = getImageSelection();
  if (selection.selectionMode === "server_managed" && selection.valid && selection.selectedProviderId) {
    const registered = findRegisteredImageProvider(selection.selectedProviderId);
    if (registered) {
      return { provider: registered.provider, model: selection.selectedModelId ?? registered.defaultModel };
    }
  }
  // UNSET -> safe server default (Gemini). EXPLICIT but INVALID -> null (fail closed).
  if (selection.selectionMode === "server_managed") return null;
  return getDefaultImageProviderPair();
}