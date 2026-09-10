/**
 * The Kitchen Codex — role-based AI candidate resolution (v0.7 Phase 1B).
 *
 * The single place that maps an AI operation to its ordered (provider, model)
 * candidates across every configured provider, so consumers no longer manually
 * pair providers to modelConfig roles. Capability filtering stays in the
 * selector (`selectCandidates`/`runWithAiFallback`); this helper only resolves
 * the ordered candidate list.
 *
 * OWNERSHIP:
 *   - `server/ai/roleModels.ts` is the module owning the curated role models
 *     (per provider per operation).
 *   - This module uses `normalizeOperationSelection` / `resolveTextCandidateContext`
 *     from `effectiveSelection.ts` to honor the EFFECTIVE selection (BYOK-4).
 *
 * Deterministic: provider order = registry order; model order = role-model order.
 * Server-side only. No platform enum. No UI config. No raw secrets.
 */

import type { AiOperation } from "./operations.js";
import type { AiCandidate, RegisteredProvider } from "./providerRegistry.js";
import { getRegisteredProviders } from "./providerRegistry.js";
import {
  resolveTextCandidateContext,
  type SelectionInput,
} from "./effectiveSelection.js";

/**
 * Resolves ordered (provider, model) candidates for an operation honoring the
 * EFFECTIVE selection (BYOK-4):
 *
 *   server_managed (valid env pin) > user_selected (valid) > server_default.
 *
 * Capability/availability filtering is the selector's job. The candidate list is
 * RESTRICTED so that neither server_managed nor user_selected mode silently
 * cross-provider falls back: an invalid/incapable selected provider/model yields
 * a NO-CANDIDATE list, so the operation's own deterministic fallback engages —
 * never a DIFFERENT paid provider.
 *
 * `userSelection` is the client's per-request, NON-SECRET selection intent
 * (strict discriminated header parse, or the legacy bounded metadata shape). It
 * is honored ONLY when no valid server-managed pin exists, and always fails
 * closed against the current catalog.
 */
export function resolveRoleCandidates(
  operation: AiOperation,
  regs: RegisteredProvider[] = getRegisteredProviders(),
  userSelection?: SelectionInput
): AiCandidate[] {
  return resolveTextCandidateContext(operation, regs, userSelection).candidates;
}

export { roleModelsForProvider } from "./roleModels.js";