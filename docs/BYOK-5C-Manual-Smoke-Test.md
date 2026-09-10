# BYOK-5C — Manual Smoke Test (local text runtime)

This is a **local / single-user** smoke test for the BYOK-5C session-credential
text runtime. It exercises the in-memory session key store + the
`credentialSource=session_only` execution path for **text** AI operations only.

> Scope: TEXT runtime only. There is **no image BYOK** yet, and session-key
> connection-test support is out of scope for 5C.

> Security: the session key itself must **never** appear in logs, screenshots,
> shell history, or anything committed to the repo. Use a placeholder like
> `$OPENROUTER_KEY` and unset it when done.

## Prerequisites

- A local server bound to loopback (`127.0.0.1`). Session-only BYOK is allowed
  **only** for a trusted local/single-user deployment; a non-loopback `HOST`
  (e.g. `0.0.0.0`, `::`, a LAN IP) is rejected with
  `BYOK_SESSION_UNAVAILABLE`.
- If `AI_ENDPOINT_TOKEN` is configured, every request below must also send
  `Authorization: Bearer <token>`.

Start the server (pick one):

```bash
bun run dev                      # dev server on http://127.0.0.1:3000
# or
bun run build && node dist/server.cjs
```

## Curated models (server-owned truth)

Use a model that is currently curated in the repo:

- OpenRouter text: `openai/gpt-4o-mini` (curated structured model)
- Gemini text: `gemini-3.7-flash` (curated Gemini role model)

The examples below use OpenRouter, so **no operator `OPENROUTER_API_KEY` is
required** — the session key is the only credential.

## Steps

### 1. Store a session key (exact provider id)

```bash
curl -s -X POST http://127.0.0.1:3000/api/providers/session-key \
  -H 'Content-Type: application/json' \
  -d '{"providerId":"openrouter","apiKey":"'"$OPENROUTER_KEY"'"}'
```

Expected: `200` with a non-secret status only:

```json
{
  "providerId": "openrouter",
  "storageScope": "session_only",
  "configured": true,
  "expiresAt": "…",
  "version": "…"
}
```

No key value, fragment, or hash is returned.

### 2. Issue a text AI request with `credentialSource=session_only`

```bash
curl -s -X POST http://127.0.0.1:3000/api/kitchen/interpret \
  -H 'Content-Type: application/json' \
  -H 'x-kitchen-ai-text-selection: {"mode":"user_selected","providerId":"openrouter","modelId":"openai/gpt-4o-mini","credentialSource":"session_only"}' \
  -d '{"question":"what can I make with chicken"}'
```

Expected: the interpretation runs with the **session key** and returns
`"source":"ai"` (no operator `OPENROUTER_API_KEY` needed). The key is never
echoed in the response.

> Gemini alternative: set `providerId` to `gemini` and `modelId` to
> `gemini-3.7-flash`. This requires a stored Gemini session key and no
> `GEMINI_API_KEY`.

### 3. Revoke the key

```bash
curl -s -X DELETE http://127.0.0.1:3000/api/providers/session-key/openrouter
```

Expected: `200` with `{ "providerId": "openrouter", "configured": false }`.
Revoke is idempotent.

### 4. Repeat step 2 -> verify fail-closed

Re-run the exact request from step 2. Expected: the request **fails closed** —
no session credential resolves, so the operation uses its deterministic
fallback (or a bounded failure). It must **never** silently fall back to an
environment credential or another provider, and no provider network call is
made.

## What this proves

- A session key can authorize text execution with **no operator env key**.
- Credential source is separate from provider/model selection.
- Revoke immediately prevents future credential leases.
- A missing/expired/revoked session key fails closed (no env fallback).

## Non-goals (not tested here)

- Image generation/recovery with session keys (no image BYOK yet).
- Session-key connection tests.
- Hosted multi-user BYOK.
- API-key UI (BYOK-5E).
