/**
 * The Kitchen Codex — Image-generation pricing truth (Phase 2).
 *
 * A SERVER-OWNED, deterministic classification of whether an image generation
 * requires an explicit per-generation confirmation. The client NEVER decides
 * this: the server resolves the effective provider/model and reads the CURRENT
 * trusted catalog.
 *
 * TRUTH RULES:
 *   - `zero` requires VERIFIED, FRESH, COMPLETE all-zero OpenRouter pricing
 *     (every required component present — including the image-output
 *     component — verified, current, and exactly zero). Anything else is never
 *     labelled zero.
 *   - `paid` requires affirmative trusted non-zero pricing evidence: VERIFIED,
 *     FRESH, COMPLETE pricing with at least one non-zero component.
 *   - `variable` covers Gemini image (pricing is determined by the user's Google
 *     account), any OpenRouter model whose pricing cannot be verified, and any
 *     VERIFIED model with a MISSING/stale/malformed/incomplete component (e.g.
 *     zero prompt/completion values but no image-output price). Incomplete data
 *     is unknown — never free and never paid.
 *   - Account credits, promotional quota, and free allowances are NEVER treated
 *     as verified zero price. Free status is never inferred from model names,
 *     promotions, credits, or client claims.
 *
 * No network I/O, no provider call, no secret. Reads only the in-memory catalog.
 */

import { createHash } from "node:crypto";
import {
  findOpenRouterCatalogModel,
  getOpenRouterCatalogSnapshot,
  type OpenRouterPricing,
} from "./openRouterCatalog.js";

/** The three truthful image cost classes surfaced to the UI. */
export type ImageCostClass = "zero" | "paid" | "variable";

export interface ImagePricingTruth {
  costClass: ImageCostClass;
  /** True for paid/variable models; false ONLY for a verified zero-price model. */
  requiresConfirmation: boolean;
  /** Bounded, user-facing classification wording. */
  label: string;
  /**
   * A deterministic fingerprint of the pricing truth, present only when the
   * OpenRouter catalog supplied verified pricing. Bound into the authorization so
   * a price change between quote and generate invalidates the confirmation.
   */
  pricingFingerprint?: string;
}

/** Bounded, truthful labels (never a per-image price unless authoritative). */
export const IMAGE_PRICING_LABELS = {
  zero: "Verified zero price",
  paidOpenRouter: "Paid — OpenRouter pricing applies",
  variableGoogle: "Variable pricing — determined by your Google account",
  variableUnknown: "Variable pricing — determined by your provider account",
} as const;

/** Deterministic pricing fingerprint over the normalized components + snapshot time. */
export function imagePricingFingerprint(
  providerId: string,
  modelId: string,
  pricing: OpenRouterPricing,
  fetchedAt: number
): string {
  return createHash("sha256")
    .update(
      [
        providerId,
        modelId,
        String(pricing.promptPerToken),
        String(pricing.completionPerToken),
        String(pricing.imageOutputPerToken),
        pricing.variable ? "variable" : "fixed",
        String(fetchedAt),
      ].join("|")
    )
    .digest("hex");
}

/**
 * Resolves the trusted pricing truth for an effective (provider, model). This is
 * the ONLY authority that decides whether a per-generation confirmation is
 * required.
 */
export function imagePricingTruth(providerId: string, modelId: string): ImagePricingTruth {
  if (providerId === "openrouter-image") {
    const snapshot = getOpenRouterCatalogSnapshot();
    const model = modelId ? findOpenRouterCatalogModel(modelId) : undefined;
    if (model && snapshot.pricingFresh && model.pricingVerified) {
      const pricingFingerprint = imagePricingFingerprint(
        providerId,
        modelId,
        model.pricing,
        snapshot.fetchedAt
      );
      const components = model.pricing;
      // COMPLETE means every required price component is present and verified:
      // prompt, completion, AND image-output. A missing/stale/malformed/unknown
      // component is variable — never zero, and never paid without affirmative
      // non-zero evidence.
      const complete =
        !components.variable &&
        components.promptPerToken !== null &&
        components.completionPerToken !== null &&
        components.imageOutputPerToken !== null;
      // Verified zero price requires the catalog's conservative all-zero verdict
      // over COMPLETE pricing.
      if (complete && model.isFree && model.costClass === "free") {
        return {
          costClass: "zero",
          requiresConfirmation: false,
          label: IMAGE_PRICING_LABELS.zero,
          pricingFingerprint,
        };
      }
      // Paid requires affirmative trusted non-zero pricing evidence.
      if (
        complete &&
        (components.promptPerToken !== 0 ||
          components.completionPerToken !== 0 ||
          components.imageOutputPerToken !== 0)
      ) {
        return {
          costClass: "paid",
          requiresConfirmation: true,
          label: IMAGE_PRICING_LABELS.paidOpenRouter,
          pricingFingerprint,
        };
      }
      return {
        costClass: "variable",
        requiresConfirmation: true,
        label: IMAGE_PRICING_LABELS.variableUnknown,
        pricingFingerprint,
      };
    }
    // No fresh verified pricing: never claim zero, never claim an exact price.
    return {
      costClass: "variable",
      requiresConfirmation: true,
      label: IMAGE_PRICING_LABELS.variableUnknown,
    };
  }

  if (providerId === "gemini-image") {
    return {
      costClass: "variable",
      requiresConfirmation: true,
      label: IMAGE_PRICING_LABELS.variableGoogle,
    };
  }

  // EXPLICIT allowlist of trusted non-billable providers. The deterministic
  // provider is a TEST SEAM that is never registered in production (reachable
  // only through the createApp test option). It is the ONLY non-catalogued
  // provider that may be classified zero-price.
  if (providerId === "deterministic-image") {
    return {
      costClass: "zero",
      requiresConfirmation: false,
      label: IMAGE_PRICING_LABELS.zero,
    };
  }

  // UNKNOWN / future provider: FAIL CLOSED. Never a permissive zero-price
  // default — treat it as variable pricing and require an explicit confirmation.
  return {
    costClass: "variable",
    requiresConfirmation: true,
    label: IMAGE_PRICING_LABELS.variableUnknown,
  };
}
