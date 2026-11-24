# SHISO-C1.6 — ChatGPT-Powered Create for Me

**Status:** IMPLEMENTED / FOCUSED TESTS PASSING / UNCOMMITTED  
**F1 presentation & latency:** [`SHISO-C1.6-F1-Draft-Presentation-and-Latency.md`](./SHISO-C1.6-F1-Draft-Presentation-and-Latency.md)  
**Base:** `8b07a4e8705f17a6a726dad6777ea1f4d678db5f` (SHISO-C1.5 / PR #64)

## Scope

Create for Me can now generate an editable recipe draft through the native
ChatGPT plan selected as Default Text AI. This is a dedicated plain-text
adapter, not a claim that ChatGPT plan supports general structured output.

## Security and capability boundary

- `ChatGptPlanProvider.capabilities.structuredOutput` and
  `recipeGeneration` remain **false**. General provider capability checks are
  unchanged.
- The route recognizes an explicit `chatgpt-plan` / `native_plan` Text AI
  selection only when no server-managed pin is present.
- The exact non-secret account key and model from the selection are revalidated
  against the live bridge catalog.
- The request asks for exactly one JSON object and includes the existing
  `GeneratedRecipeDraft` schema.
- The response is bounded at 200,000 characters, must begin/end with `{`/`}`,
  is parsed as strict JSON with no prose or code-fence extraction, and is then
  normalized/validated by the existing generated-recipe schema. Unknown fields,
  missing required fields, oversize data, and malformed JSON are rejected.
- A native-plan failure is terminal. There is no Gemini, API-key, or other paid
  fallback.
- Cancellation is propagated before and after the bridge call.
- The result remains a normal **Generated Draft / Not saved yet**. Only the
  existing explicit Save path can write to the Vault.
- No OAuth token enters the renderer, server, settings, logs, or Vault.

## Error behavior

| Condition | Result |
|---|---|
| ChatGPT disconnected / not entitled / model unavailable | HTTP 503 `CHATGPT_PLAN_UNAVAILABLE` |
| Invalid/oversized/prose-wrapped/schema-invalid response | HTTP 502 `CHATGPT_PLAN_INVALID_RESPONSE` |
| Server-managed pin present | Native selection is inert; existing server policy applies |
| Cancellation | Existing cancellation response; no bridge inference |
| Existing Gemini/OpenRouter selection | Existing structured-generation path unchanged |

No provider output is persisted by generation. The draft is returned to the
existing Create for Me modal for review/edit before explicit Save.

## Verification evidence

- Focused C1.6/create/chat/Create-for-Me/SHISO group: **40 files / 558
  tests passed**.
- Existing recipe-generation route/credential/terminal/pricing/wiring group:
  **5 files / 73 tests passed**.
- Native adapter unit tests: valid draft, exact account/model forwarding, strict
  prompt/schema, prose/malformed/oversized/schema-invalid rejection, disconnected
  account, server-pin precedence, cancellation, cold-catalog refresh.
- Real `/api/recipes/generate` route with deterministic bridge: **200** valid
  draft/provenance; **502** invalid-response code; **503** disconnect code; zero
  external provider calls.
- Final built `dist/server.cjs` probe: valid recipe draft through the native
  bridge, exactly one bridge inference, exact account/model, no API keys, no token
  leak.
- TypeScript: PASS.
- Production build: PASS.
- `git diff --check`: PASS.

No live ChatGPT plan Create for Me inference was performed; owner/account access
was not authorized for this implementation pass. The deterministic bridge fixture
covers the complete request/parse/validate path. No commit, push, merge,
installation, or deployment was performed.
