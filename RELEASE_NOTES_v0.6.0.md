# The Kitchen Codex v0.6.0 — AI Provider Abstraction

## AI Provider Abstraction

v0.6.0 introduces a provider-neutral AI layer across every live AI consumer. The
server now talks to AI through a small, capability-oriented abstraction
(`server/ai/*`) instead of calling the Gemini SDK directly from feature code.

- **Provider abstraction**: a minimal `AiProvider` contract (id, name,
  capabilities, availability, `generate`, `generateStructured`, and optional
  `searchWeb`) backed by a tiny registry (`getDefaultAiProvider()`).
- **All live AI consumers migrated**: kitchen intent interpretation, candidate
  ranking, web discovery, metadata recovery, nutrition estimation, and Grab
  Recipe all route through the provider abstraction with explicit models.
- **Gemini SDK isolated to infrastructure**: `server/geminiClient.ts` (shared key
  client) and `server/ai/geminiProvider.ts` (the Gemini adapter) are the only
  places that touch the Gemini SDK. No application-level direct-Gemini consumer
  remains.
- **Capability-oriented foundation**: the abstraction declares capabilities
  (structured output, web search, reasoning, recipe generation) so a future
  non-Gemini provider can be added without reworking feature code.
- **Schema fidelity**: the adapter maps a provider-neutral JSON-schema-lite to the
  Gemini schema, including `description` hints and an `integer` type, preserving
  structured-output fidelity (e.g. Grab Recipe `servings`/`stepNumber` integers).

## Ask My Kitchen

The existing "MY VAULT" trust model is preserved exactly.

- **Interpretation** is provider-backed (`kitchenInterpret`) but always wrapped by
  the deterministic KitchenIntent sanitizer; AI only understands intent.
- **Ranking** re-ranks only the trusted, deterministic candidate evidence
  (`kitchenRank`); AI failure degrades to deterministic ranking.
- **Web discovery** remains explicit and provider-grounded (`kitchenDiscover`);
  discovered URLs come only from real search grounding and stay separate from the
  vault, flowing into the existing Grab Recipe import path.
- **Deterministic code stays authoritative** for vault membership, recipe
  existence, trusted IDs, navigation, and writes.

## Grab Recipe

- Migrated through the provider abstraction while preserving the extraction
  authority order: JSON-LD → AI → fallback JSON-LD → heuristic.
- **INTEGER schema fidelity** preserved (`servings`, `stepNumber`) via the new
  `integer` node in the provider schema.
- **SSRF / DNS / redirect protections unchanged**; one importer, no new fetch
  path, and the preview → explicit-save boundary is intact.

## Vault Intelligence / Metadata Recovery

- Provider-based enhancement while preserving the deterministic recovery rules,
  the zero-fabrication/merge allowlist, and the algorithmic fallback chain
  (primary → fallback → algorithmic).

## Nutrition

- Provider-based AI fallback with deterministic-first behavior preserved.
- **Non-finite numeric hardening**: AI-estimated values are now coerced through a
  finite-safe helper so `Infinity`/`"Infinity"`/`NaN` become `0` rather than
  propagating, while all finite values round and clamp exactly as before.
- **Provenance remains application-assigned** (`database` / `ai_estimate` /
  `offline_heuristic` and confidence are set by application logic, never the model).

## Security & Trust

- **No direct Gemini application consumers** — SDK coupling is infrastructure-only.
- **Provider diagnostics are redacted**: every AI consumer now logs failed model
  attempts through the shared `logModelAttempt`/`extractProviderError` helper
  (bounded, secret-redacted) rather than raw `err.message`.
- **No raw provider errors reach clients** — endpoint handlers return fixed,
  non-technical messages; server logging was cleaned without changing API output.
- **No SSRF / security weakening**; source-policy, trusted-recipe-ID, candidate
  allowlist, vault-membership, and web/local separation invariants are unchanged.
- **Preview / save boundaries preserved**; no auto-writes, no auto-import.

## Legacy Cleanup

- **Removed the dead legacy answer path**: `server/kitchenAnswer.ts` (the old
  server adapter), the orphaned `POST /api/kitchen/answer` route, its rate
  limiter, and its dedicated security tests were deleted.
- Removed the dead `buildAnswerRequest` / `isAnswerResponse` UI helpers and their
  isolated tests.
- Retained the shared deterministic `src/utils/kitchenAnswer.ts` types/utilities;
  `buildGroundedKitchenAnswer` remains the live client-side answer builder.

## Testing & Verification

- 926/926 Vitest tests across 41 files
- 84/84 security tests across 8 files
- TypeScript typecheck (`tsc --noEmit`) clean
- Production build clean; `bun install --frozen-lockfile` clean; `git diff --check`
  clean
- No client secret exposure; no application-level direct-Gemini consumer remains
