# The Kitchen Codex v0.5.1 — Kitchen AI Reliability Hotfix

## Fixed

Ask My Kitchen no longer hard-fails when the primary Gemini model is unavailable:

- **Interpreter** falls back to another model, then to deterministic parsing, so a
  provider failure no longer surfaces as "AI interpreter unavailable" for questions
  the deterministic parser can safely handle.
- **Ranking** falls back safely to deterministic candidate ranking when every AI
  ranking attempt fails — the local request is never failed.
- **Web discovery** tries a fallback grounded model before reporting unavailable,
  and only ever accepts provider-grounded URLs (no ungrounded/parsed-from-prose
  URLs).
- Provider failures now produce concise, redacted **server-side diagnostics** so
  operators can tell why a model attempt failed.

## Trust & Security

- No ungrounded web URLs accepted (grounding-only guarantee preserved).
- No AI-defined vault membership; deterministic code stays authoritative.
- No auth weakening; no secrets exposed to the client (verified in the built bundle).
- Existing Grab Recipe importer and SSRF/private-IP/redirect/content-type
  protections are unchanged.

## Known Deployment Note

- **AI_ENDPOINT_TOKEN browser compatibility remains unresolved** and is a separate
  deployment/config item. Web discovery also still requires at least one deployed
  model with Google Search grounding support.

## Verification

- 877/877 tests across 41 files
- TypeScript typecheck (`tsc --noEmit`) clean
- Production build clean; `bun install --frozen-lockfile` clean; `git diff --check`
  clean
- No client secret exposure (AI_ENDPOINT_TOKEN / GEMINI_API_KEY not present in the
  browser bundle)
