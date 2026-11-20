# Sign in with ChatGPT — Experimental Subscription Integration

Status: **experimental, local-only, disabled by default.**

The Kitchen Codex can optionally connect an eligible ChatGPT Plus/Pro account
through the documented Sign in with ChatGPT open-source flow. This is separate
from an OpenAI API key and never silently substitutes API-key billing.

## Permission and licensing gate

- The Kitchen Codex remains MIT-licensed.
- The official documentation provides a public-client, dynamic-registration
  OAuth flow for open-source and locally hosted apps. No client secret or
  partner API key is required for this flow.
- The [Sign in with ChatGPT DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit)
  is under a **noncommercial** license. Its source, components, styles, and
  assets are **not copied, vendored, bundled, or adapted** here. This module is
  independently written from the public protocol documentation.
- ChatGPT plan usage is currently documented as available to open-source
  partners and selected private clients. A paid, remotely hosted, or otherwise
  commercial offering requires OpenAI commercial-partner approval through the
  official interest/request process before usage, distribution, or deployment.
- The integration is not available in the website/public server. It is native
  Electron only.

## Architecture

```text
React AI Studio
   │  narrow IPC (no tokens)
   ▼
Electron preload (exact-origin bridge)
   ▼
Electron main process
   ├─ OAuth public client + loopback callback (127.0.0.1)
   ├─ PKCE S256, state, nonce
   ├─ ID-token signature/issuer/audience/nonce/expiry validation
   ├─ session-only in-memory token authority
   ├─ refresh rotation / account selection / revocation
   └─ POST https://api.openai.com/v1/responses
          store:false, stream:true
```

There is no `backend-api`, Codex credential, or unofficial ChatGPT endpoint in
this path. Inference is native-side, and access/refresh/ID tokens never enter
the renderer, logs, diagnostics, or the Recipe Vault.

### Dynamic registration and host identity

- First connection uses `client_id=dynamic_agent_client` with
  `agent_name_hint=The Kitchen Codex`.
- The issued `oaiapp_…` client ID is persisted as non-secret registration
  metadata and reused on later sign-ins.
- A host identity is generated once as `urn:uuid:<UUIDv4>` and persisted
  owner-only for the host lifecycle.
- Reconnect within the same application session reuses the issued client ID,
  host ID, and retained ID-token hint. After restart, a fresh interactive
  authorization is required.

### Session-only credential authority

- Directory: Electron `userData/chatgpt-subscription` (not a Vault).
- Directory mode `0700`; host and registration files `0600`.
- Access, refresh, and ID tokens exist only in Electron main-process memory.
  They are never written to `userData`, localStorage, logs, diagnostics, or the
  Vault.
- The only persistent records are the host identity and the non-secret issued
  OAuth client registration.
- Legacy `credentials.bin` and `revocations.json` records from earlier builds
  are never read. They are deleted best-effort; if deletion fails, they remain
  physically present but inert and cannot authorize any request.
- On Linux, the experimental feature still requests the `gnome-libsecret`
  password store and fails closed when only `basic_text` obfuscation or no
  keyring is available. No secret is persisted even when secure storage is
  available.

### Token and scope validation

- ID token signature is verified against OpenAI JWKS; issuer must be
  `https://auth.openai.com`, audience must be the issued client ID, nonce must
  match the attempt, and expiry/issued-at/not-before are checked. Multi-audience
  tokens must also carry `azp` equal to the issued client ID.
- ChatGPT plan usage is enabled only from the **token endpoint's top-level
  `scope`** response. Access-token payloads are never decoded for admission.
- The complete grant set is required: `offline_access`, `resource.invoke`, and
  `chatgpt.tokens.use.direct`.
- A valid identity without the plan scope remains a connected account with
  plan usage disabled. Inference is refused.
- An explicit refresh `scope` must exactly preserve the prior grant. Added,
  reduced, or malformed refresh scopes durably invalidate the session and
  require explicit browser reauthorization; an omitted scope retains only the
  previously trusted grant.

### Credential lifecycle

- Each in-memory account carries a monotonic `generation`.
- Refresh captures the account key, generation, client ID, subject, and
  refresh-token value before any await.
- Refresh commits only when the current account still matches all captured
  identity/lifecycle values and is not signed out.
- Disconnect synchronously increments the generation, clears credentials, and
  aborts outstanding refresh/inference work before remote revocation.
- Authentication failures and changed refresh grants use the same synchronous
  in-memory invalidation path. There is no persisted token generation to
  restore, so a failed disk write or deletion cannot revive the account.
- Obsolete refresh completions are discarded and cannot recreate an account or
  update the active account.
- Application restart always begins disconnected. Sign-out is effective for the
  remainder of the process and requires fresh browser authorization after a
  restart.

### Cancellation

- Inference registers its request record and AbortController before the first
  await, so cancellation during model discovery or refresh prevents native
  Responses dispatch.
- OAuth sign-in has a separate operation-owned controller covering callback
  waiting, token exchange, ID-token/JWKS work, and pre-save checks. The AI
  Studio panel exposes **Cancel sign-in**.
- Account switching aborts pending inference; disconnect aborts pending
  inference and refresh for that account.
- Refresh invalidation also aborts that account's work. Every completed stream
  rechecks account generation and entitlement before returning text.
- Aborted operations are reported as `CANCELLED`, never as successful
  connections or completed responses.

### Model admission

- Only account model rows with exact `visibility: "list"` are admitted.
- Missing, hidden, unknown, malformed, path-like, or duplicate entries are
  rejected. The complete eligible response is checked for duplicates before the
  100-model display cap is applied.
- Inference re-reads the account catalog immediately before dispatch.
- No model substitution occurs; the exact selected model must remain eligible.

### Responses API contract

- Endpoint fixed to `https://api.openai.com/v1/responses`.
- Model must be returned by `GET https://api.openai.com/v1/models` for the
  signed-in account.
- Request body is limited to `model`, complete `input` history, optional
  `instructions`, `store:false`, and `stream:true`.
- Unsupported fields and tools are never sent.
- Success requires `response.completed`; `failed`, `incomplete`, aborted, or
  interrupted streams are rejected and partial text is discarded.
- No automatic retry of inference. Refresh-token rotation is serialized and
  applies only before a request.

### Package verification

`scripts/verify-desktop-package.mjs` checks the packaged desktop source and
native-helper parity. The ChatGPT modules are part of the packaged desktop
tree and are included in the integration packaging check.

Signed release provenance remains a separate owner process. A newly built
package requires its own owner-authorized signing and verification; the
previous R7-F2 signature must not be reused for a changed payload.

## Enabling locally

The integration is hidden unless the Electron process starts with:

```bash
TKC_CHATGPT_SUBSCRIPTION=1
```

A disposable candidate should use an isolated HOME/XDG profile and test Vault.
The owner must personally complete browser authorization and plan consent.

## Current scope and limitations

- AI Studio exposes **ChatGPT plan** with Continue/Connect, session status,
  plan status, available models, Reconnect, Add account, Disconnect, Manage
  usage, and a basic text test. It states that sign-in is required after
  application restart.
- Only basic Responses text is exposed. Structured recipe generation, SHISO
  tools, recipe interpretation, and Advanced Nutrition are **not** claimed as
  supported; their output contracts still need separate validation.
- Image generation is excluded by the documented flow.
- No live ChatGPT authorization or subscription usage was performed by the
  implementation/audit environment.
