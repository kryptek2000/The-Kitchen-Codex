/**
 * The Kitchen Codex — Provider Status / Config Query Surface (v0.7 Phase 1D).
 *
 * A small, provider-neutral, READ-ONLY status surface that future provider
 * settings UI (Phase 1E) can consume. It reports capability metadata and
 * boolean availability signals ONLY — it NEVER exposes a key, token, secret,
 * masked-secret substring, last-4 chars, raw env value, or Authorization header.
 *
 * SEMANTICS (correct == useful distinction, never conflated):
 *   - `configured`: a server operator secret exists for this provider.
 *   - `enabled`:    the registry descriptor permits selection (authoritative).
 *   - `available`:  the provider's cheap, LOCAL availability check (no network
 *                   probe). For Gemini this is the shared client availability;
 *                   for OpenRouter/DeepSeek it is operator-secret presence.
 *   - `capabilities`: registry-owned truth — the UNION of the provider's
 *                   baseline capability descriptor and every curated per-model
 *                   capability override. A capability is true when the provider
 *                   baseline OR at least one curated model supports it (the
 *                   "capabilities supported by this provider's current curated
 *                   model set"). This is NEVER user-editable; the registry
 *                   remains authoritative.
 *
 * No request executes here and no remote connection is made.
 */

import type { AiCapabilities, AiCapability } from "./types.js";
import type { RegisteredProvider } from "./providerRegistry.js";
import { getRegisteredProviders } from "./providerRegistry.js";
import {
  getServerSecretSync,
  providerSecretIdForProvider,
} from "../platform/ServerEnvironmentSecretAdapter.js";
import type { SecretStorageScope } from "../../src/application/adapters/SecretAdapter.js";

/** The fixed capability keys surfaced by the provider status. */
const CAPABILITY_KEYS: AiCapability[] = [
  "reasoning",
  "structuredOutput",
  "recipeGeneration",
  "webSearch",
];

/**
 * Derives a provider's TRUTHFUL capability summary as the union of its baseline
 * descriptor and every curated per-model capability override. This avoids
 * understating a provider (e.g. DeepSeek's curated reasoning, or GPT-4o-mini's
 * curated structured output) while never inventing support for an uncurated,
 * out-of-set model. The registry stays authoritative.
 */
function providerCapabilityUnion(registered: RegisteredProvider): AiCapabilities {
  const union: AiCapabilities = { ...registered.defaultCapabilities };
  const modelCapabilities = registered.modelCapabilities;
  if (modelCapabilities) {
    for (const override of Object.values(modelCapabilities)) {
      if (override && typeof override === "object") {
        for (const key of CAPABILITY_KEYS) {
          if (override[key] === true) union[key] = true;
        }
      }
    }
  }
  return union;
}

/** The provider-neutral status shape exposed to the UI/consumers (never secrets). */
export interface ProviderStatus {
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
  /** Registry-owned capability truth (never user-editable). */
  capabilities: AiCapabilities;
}

/**
 * Resolves the current provider status list from the authoritative registry, in
 * registry order (Gemini -> OpenRouter -> DeepSeek). Deterministic and network-free.
 */
export function getAiProviderStatus(): ProviderStatus[] {
  return getRegisteredProviders().map((registered) => {
    const secretId = providerSecretIdForProvider(registered.provider.id);
    const configured = secretId ? Boolean(getServerSecretSync(secretId)) : false;
    return {
      providerId: registered.provider.id,
      name: registered.provider.name,
      configured,
      enabled: registered.enabled !== false,
      available: registered.provider.isAvailable(),
      storageScope: "server_environment",
      supportsSecretWrites: false,
      capabilities: providerCapabilityUnion(registered),
    };
  });
}
