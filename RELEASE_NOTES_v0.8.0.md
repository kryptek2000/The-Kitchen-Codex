# The Kitchen Codex v0.8.0 — BYOK & Dynamic OpenRouter Catalog

## Highlights

- **Session-only BYOK for Text AI and Image AI**: enter a provider API key that
  lives only in server process memory, expires automatically, is revocable, and
  is never written to the browser, vault, or settings.
- **Exact credential isolation**: `openrouter` ≠ `openrouter-image` and
  `gemini` ≠ `gemini-image`. A key is never aliased, migrated, or silently
  substituted across providers.
- **Simplified two-card AI Settings**: Text AI and Image AI each get a compact
  card (provider, model, credential source, session key, stable footer), with
  Advanced / Server Diagnostics collapsed by default.
- **Dynamic OpenRouter model discovery** with **Free / Budget / Paid /
  Variable** pricing awareness and a searchable, free-first model picker.
- **Cost-aware FREE → PAID protection** and **stale-pricing fail-closed**
  safeguards that prevent silent spend.
- **Ask My Kitchen generic ingredient matching** improvements.
- **OpenRouter image generation** live-smoke verified (image preview remains
  explicit-save only).

## Session-Only BYOK

- **Text AI** and **Image AI** both support a session-only API key.
- The key is stored **only in server process memory**: it is lost on restart,
  expires automatically (absolute + idle TTL), and can be revoked at any time.
- The key is **never** persisted to `localStorage`, IndexedDB, the settings
  store, plugin `data.json`, the Obsidian vault, or Markdown; it is **never**
  re-displayed (no masked key, prefix, or hash).
- Saving a key performs **no provider call**. Connection validation is a
  separate, explicit **Test Connection** action.
- Session keys are scoped to **exact execution-provider IDs**. The same literal
  key may be entered for `openrouter` and `openrouter-image`, but the backend
  keeps those session identities separate.

## Simplified AI Settings UX

- Two compact cards replace the previous technical wall:
  - **Text AI** — provider, model, credential source, session key.
  - **Image AI** — provider, model, credential source, session key.
- Friendly, non-secret display names for providers and models; truthful
  credential-source labels ("Using server API key" / "Using your temporary API
  key").
- **Advanced / Server Diagnostics** remains available and is collapsed by
  default.
- The card footer (notice + "Reset to server default") is stable and always
  visible.

## Dynamic OpenRouter Catalog

- **Server-owned discovery**: the OpenRouter catalog is fetched server-side
  from the fixed public endpoint (no API key required, no browser fetch), with
  a bounded timeout, bounded response size, no redirects, and schema
  validation.
- **Cached**: a short-lived in-memory cache (no vault/disk persistence); the
  app stays usable if discovery temporarily fails (last-known data, or a safe
  curated fallback).
- **Cost classification**: **Free / Budget / Paid / Variable**, derived from
  normalized per-token pricing. Free is proven by zero cost across every
  applicable pricing component — never inferred from a model name.
- **Searchable picker**: filter by display name or model id, with Free / Budget
  / All-compatible grouping, free-first ordering, and compact capability
  badges.
- **Broader model visibility**: discovered models are listed with truthful
  pricing; only server-verified models are executable.

## Cost-Aware Spend Protection

- **FREE → PAID protection**: if a model you acknowledged as FREE is reported
  by the current trusted catalog as non-free, execution is blocked with a
  bounded `MODEL_PRICING_CHANGED` error. Kitchen Codex prevents the possible
  charge and asks you to review and re-select. There is **no** automatic model
  or provider switch, and **no** silent charge.
- **Stale-pricing fail-closed**: if FREE pricing can no longer be verified
  (stale cache or a failed refresh), execution is blocked with
  `MODEL_PRICING_UNVERIFIED` until the catalog refreshes and you re-select.
- **Conservative pricing**: any non-zero, negative, malformed, `NaN`/`Infinity`,
  object/override, or unknown price-bearing field prevents a FREE
  classification.
- **Zero spend on block**: pricing-blocked text requests make **zero** provider
  calls and surface the reason on every text AI route.

## Safe Server-Owned Validation

- Only **server-verified strict-structured** text models and
  **transport-allowlisted** image models are executable.
- **Arbitrary client-supplied model IDs fail closed** — the browser never
  supplies authoritative pricing or capability metadata.
- External catalog metadata is **bounded** (model count, id/name length,
  parameter and modality list caps); duplicate/conflicting model ids are
  rejected deterministically.
- Provider precedence (server-managed pin > valid user selection >
  server-default) is unchanged, and credentials never fall back across
  providers.

## Ask My Kitchen

- **Generic ingredient matching**: a generic query such as "chicken" now matches
  its normalized variants ("chicken breast", "rotisserie chicken") while
  remaining whole-token safe ("chickpea" does not match).
- Exact canonical ingredient identity is unchanged for every other consumer;
  the relaxation is query-side and Ask My Kitchen only.

## Image Generation

- **OpenRouter image generation** is live-smoke verified through the explicit,
  session-key-aware image path.
- **Image preview remains explicit-save only**: no automatic image generation
  on any save, scan, render, or resolve surface.
- Image Test Connection is credential validation only (it never generates an
  image).

## Known Limitations

- **Dynamic OpenRouter models that are discovered but not yet verified for the
  Kitchen Codex strict structured-output runtime are shown informationally but
  are not executable.** Not every discovered free model is currently usable.
- **Dynamic image-output models are discovery-only** unless explicitly verified
  for the current image transport.
- **No free image-generation model is advertised.** Free image-provider support
  is planned separately.
- The live catalog is point-in-time; availability, pricing, and the free/paid
  classification can change upstream at any time.

## Verification

- 2220 / 2220 Vitest tests across 135 files.
- 269 / 269 security tests across 18 files.
- Typecheck, production build, and plugin build clean.
- `git diff --check` clean.

## Upgrade Notes

- No manual migration is required. Existing saved provider/model selections
  remain valid when still present in the current catalog; a selection that has
  disappeared or become invalid fails closed (never a silent switch to another
  provider/model).
- To use a session key, open AI Settings, choose **Use my API key**, save the
  key, then optionally run **Test Connection**.
