/**
 * The Kitchen Codex — AI operation capability requirements (v0.7 Phase 1A).
 *
 * Maps each server-side AI operation to the provider capabilities it REQUIRES.
 * This is the minimal operation-requirement model needed for selection. It does
 * NOT add Create-for-Me or generalized Search-the-Web roles yet; those arrive in
 * later phases by extending this map (plus their own operations).
 */

import type { AiCapabilityKey } from "./providerRegistry.js";

/** The server-side AI operations that exist today. */
export type AiOperation =
  | "kitchenInterpret"
  | "kitchenRank"
  | "kitchenDiscover"
  | "nutrition"
  | "metadataRecovery"
  | "recipeGrabber";

/**
 * Required capabilities per operation. `structuredOutput` operations retain their
 * existing deterministic fallback; `kitchenDiscover` ONLY runs a webSearch-capable
 * provider (never an ordinary text generator).
 */
export const OPERATION_REQUIRED_CAPABILITIES: Record<AiOperation, AiCapabilityKey[]> = {
  kitchenInterpret: ["structuredOutput"],
  kitchenRank: ["structuredOutput"],
  kitchenDiscover: ["webSearch"],
  nutrition: ["structuredOutput"],
  metadataRecovery: ["structuredOutput"],
  recipeGrabber: ["structuredOutput"],
};

/** Returns the required capabilities for an operation (empty for unknown ops). */
export function operationRequiredCapabilities(operation: AiOperation): AiCapabilityKey[] {
  return OPERATION_REQUIRED_CAPABILITIES[operation] ?? [];
}
