/**
 * The Kitchen Codex — image provider registry (BYOK-2 / BYOK-3).
 *
 * A REAL, server-owned image-provider registry mirroring the text-provider
 * registry (`server/ai/providerRegistry.ts`) CONCEPTUALLY but kept SEPARATE:
 * binary image generation lives on its own `ImageProvider` contract and must not
 * be conflated with text `AiProvider` selection.
 *
 * The registry owns:
 *   - provider id + name + instance resolution,
 *   - configured / enabled / available signals,
 *   - the curated default model (the pin target for server-managed selection)
 *     plus the FULL curated model set per provider,
 *   - per-provider image capabilities (formats, maxBytes) via `ImageProvider`.
 *
 * BYOK-2/BYOK-3 SCOPE:
 *   - Production-registered image providers: `GeminiImageProvider`
 *     (`gemini-image`, proven SDK semantics) and `OpenRouterImageProvider`
 *     (`openrouter-image`, fixed OpenRouter `/images` endpoint). Registry ORDER
 *     is deterministic (Gemini first preserves zero-config behavior; OpenRouter
 *     second is INERT unless an `OPENROUTER_API_KEY` is configured).
 *   - `DeterministicImageProvider` remains an explicit TEST SEAM and is NEVER
 *     registered (it must never resolve through server-managed selection).
 *
 * SECURITY: mirrors the text registry — no secret ever crosses this surface;
 * `configured`/`enabled`/`available` are the only non-provider fields.
 */

import { getServerSecretSync } from "../platform/ServerEnvironmentSecretAdapter.js";
import { GeminiImageProvider, DEFAULT_GEMINI_IMAGE_MODEL } from "./geminiImageProvider.js";
import {
  OpenRouterImageProvider,
  OPENROUTER_IMAGE_MODELS,
  OPENROUTER_IMAGE_DEFAULT_MODEL,
} from "./openRouterImageProvider.js";
import type { ImageProvider } from "./imageProvider.js";

/** A registered image provider with its authoritative configuration truth. */
export interface RegisteredImageProvider {
  provider: ImageProvider;
  /** Curated default model id (the selection pin target / role default). */
  defaultModel: string;
  /**
   * The FULL curated image-model set this provider can execute. An unknown model
   * is NOT in this set and is never selectable. Defaults to `[defaultModel]`.
   */
  models?: readonly string[];
  /** When false, the provider is skipped by selection. Defaults to true. */
  enabled?: boolean;
}

let imageRegistry: RegisteredImageProvider[] | null = null;

/**
 * True when an OpenRouter key is present (server operator env via the allowlisted
 * secret source). Mirror of the text-registry enablement rule.
 */
function openRouterImageConfigured(): boolean {
  return Boolean(getServerSecretSync("openrouter_api_key"));
}

function ensureImageRegistry(): RegisteredImageProvider[] {
  if (!imageRegistry) {
    imageRegistry = [
      {
        provider: new GeminiImageProvider(),
        defaultModel: DEFAULT_GEMINI_IMAGE_MODEL,
        enabled: true,
      },
      {
        provider: new OpenRouterImageProvider(),
        defaultModel: OPENROUTER_IMAGE_DEFAULT_MODEL,
        models: OPENROUTER_IMAGE_MODELS,
        // Same rule as the text registry: OpenRouter image is INERT (disabled)
        // unless its operator key is configured.
        enabled: openRouterImageConfigured(),
      },
    ];
  }
  return imageRegistry;
}

/**
 * The production image-provider registry (Gemini + OpenRouter, lazily built).
 * OpenRouter Image is `enabled` only when `OPENROUTER_API_KEY` is configured.
 */
export function getRegisteredImageProviders(): RegisteredImageProvider[] {
  return ensureImageRegistry();
}

/**
 * The default production image provider pair. Always the real Gemini provider +
 * its proven default model (the deterministic test seam is never a default).
 */
export function getDefaultImageProviderPair(): { provider: ImageProvider; model: string } {
  const registered = ensureImageRegistry()[0];
  return { provider: registered.provider, model: registered.defaultModel };
}

/** Finds a registered image provider by id (unknown ids return undefined safely). */
export function findRegisteredImageProvider(
  id: string | undefined
): RegisteredImageProvider | undefined {
  if (!id) return undefined;
  return ensureImageRegistry().find((r) => r.provider.id === id);
}

/** Resolves a registered image provider by id (not a selection path). */
export function getImageProvider(id: string): ImageProvider | undefined {
  return findRegisteredImageProvider(id)?.provider;
}

/**
 * The curated image-model set a registered provider can execute (used by
 * server-managed image selection validation). Falls back to the default model
 * so legacy single-model providers stay valid.
 */
export function curatedImageModels(registered: RegisteredImageProvider | undefined): Set<string> {
  const set = new Set<string>();
  if (!registered) return set;
  for (const id of registered.models ?? [registered.defaultModel]) set.add(id);
  return set;
}