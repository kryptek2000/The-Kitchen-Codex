# SHISO-C1.5 — ChatGPT Plan as Default Text AI

**Status:** IMPLEMENTED / DETERMINISTIC TESTS PASSING / LIVE OWNER CONNECTION PENDING
**Base:** `main` after PR #63 (`bc711e58fec875aab4986f95f1f42263f3c80c85`)
**Scope:** native desktop Text AI selection and SHISO provider routing

---

## Product decision

A connected, eligible ChatGPT Plus/Pro plan can be selected as the local native
desktop's **Default Text AI**. The preference is separate from the backend's
server-managed `KITCHEN_CODEX_TEXT_PROVIDER` configuration. A valid server pin
remains authoritative; the desktop preference cannot override it.

## Architecture

```text
React renderer
  │  x-kitchen-ai-text-selection:
  │    providerId=chatgpt-plan,
  │    modelId=<live account model>,
  │    credentialSource=native_plan,
  │    accountKey=<non-secret acct_…>
  ▼
Express server
  │  validates the exact account/model against the native bridge catalog
  │  selects ChatGptPlanProvider (plain text only)
  ▼
Loopback bridge (127.0.0.1, ephemeral port, 32-byte bearer token)
  ▼
Electron main process
  ├─ existing ChatGPT OAuth session (tokens never leave this process)
  ├─ account/model admission
  └─ POST https://api.openai.com/v1/responses
```

### Security boundaries

- The provider is registered **only** when the Electron main process injects
  `TKC_CHATGPT_PLAN_BRIDGE_URL` and `TKC_CHATGPT_PLAN_BRIDGE_TOKEN` **and** the
  server is running with `TKC_DESKTOP_RUNTIME=1`. A web deployment never sees it,
  even if bridge-shaped env names are present.
- The bridge URL must be loopback HTTP on a port ≥ 1024. No caller-controlled
  host, port, or path is accepted.
- The bridge token is generated per process and passed only to the server child
  environment. It never reaches the renderer, settings, logs, or Vault.
- The server sends only `{ accountKey, model, input }` to the bridge. It never
  sees an OAuth token.
- `accountKey` is the non-secret `acct_<32 hex>` identity. It is stored with the
  preference so the exact account can be reconnected.
- The saved preference contains no access token, refresh token, ID token, API
  key, save grant, or proposal.
- A server-managed operator pin wins. The native plan is never a server env pin.
- A failure is terminal for the native candidate: `singleAttempt` and
  `terminalOnFailure` prevent retry and cross-provider fallback.

## Capability truth

| Capability | ChatGPT plan |
|---|---|
| Plain Responses text | **Supported** |
| SHISO conversation (validated JSON-over-text decision) | **Supported** |
| Structured output / `generateStructured` | **Not claimed** |
| Recipe generation | **Not claimed** |
| Web search | **Not claimed** |
| Image generation | **Separate; not routed here** |

The SHISO loop uses its existing validated JSON-text adapter when
`structuredOutput` is false. Nutrition, metadata recovery, recipe grab and
Create for Me require structured/recipe/web capabilities, so an explicit
ChatGPT plan selection yields zero candidates for those operations rather than
silently substituting Gemini or a paid API provider. The UI states this
limitation.

The official Responses contract used here remains the existing native contract:
fixed endpoint, `store:false`, `stream:true`, bounded `input`, optional
`instructions`. No unsupported fields or tools are sent. Structured output is
not enabled because it has not been demonstrated compatible by tests.

## Persistence and restart

- Preference key: the existing `kitchen.codex.aiSelections.v1` SettingsAdapter
  value.
- Saved fields: `mode`, `providerId`, `modelId`, `credentialSource`,
  `accountKey`, and the acknowledged cost class when applicable.
- OAuth credentials remain session-only in Electron main memory. Application
  restart always begins disconnected.
- The saved preference remains visible after restart as **Saved, but ChatGPT
  plan is not connected**. It performs no automatic work and does not fall back.
- Reconnecting the same account makes the saved model eligible again. Selecting
  a different account shows a mismatch until the saved account is selected or
  the default is re-saved.

## UI

AI Studio → ChatGPT plan now includes:

- connected account / plan entitlement status;
- the live account model list;
- **Use as Default Text AI**;
- **Use configured server provider**;
- a truthful **Default Text AI: ChatGPT plan / [model]** status;
- explicit reconnect/account-mismatch/model-unavailable states;
- disabled selection when Text AI is server-managed or catalog truth cannot be
  read.

The generic Providers card shows a read-only ChatGPT plan summary with a
reset-to-server action; it does not expose the native account source through
the generic API-key picker.

## Verification

Deterministic tests cover:

- bridge bearer-token rejection, sanitized model rows, disconnected state,
  bounded inference, malformed bodies, and unknown paths;
- server provider catalog/status rows and secret-free metadata;
- native account/model selection parsing and invalid-account rejection;
- SHISO conversation routing through the native plan text adapter;
- structured nutrition routing yielding zero ChatGPT candidates;
- server-managed pin precedence;
- UI save/reset, header contents, no credentials in persistence, reconnect
  state, and server-managed disablement;
- existing ChatGPT OAuth/session and SHISO regressions.

A live owner-authorized connection test was completed on 2026-11-23: the owner
connected an eligible account in the isolated native preview, 10 live models
were listed, `gpt-6.2-sol` was saved as the default, and a real SHISO turn
returned through the bridge. After restart the saved preference remained but the
session was disconnected; a new SHISO message failed closed with a reconnect
instruction and no bridge inference.

A staged desktop candidate was packaged and verified, but not installed.

## Known limitations

- SHISO conversation is supported; full structured SHISO/nutrition/recipe
  contracts are not.
- The bridge/model catalog is refreshed by the provider catalog route. A
  transient local catalog failure fails closed.
- A saved preference for a different account or model is preserved and shown as
  inactive until corrected.
- No automatic paid API fallback exists.
