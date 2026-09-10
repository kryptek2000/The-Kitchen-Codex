# The Kitchen Codex v0.7.x — BYOK-5 Architecture Spec

**Status:** Design contract — implementation may begin only from this spec  
**Baseline HEAD/origin-main:** `a59d1072629c8c2a0b8258ba9289c98c4bd55654`  
**BYOK-4:** Complete and committed

---

## 1. Goal

Add the first true user-provided BYOK credential flow for local/self-hosted single-user use.

The user may provide an API key for a supported AI provider.

The key MUST be:
- submitted to the server
- retained ONLY in server process memory
- provider-scoped
- session-scoped
- revocable
- expiring
- never persisted to disk
- never returned to the client
- never logged
- never copied into environment variables
- never silently substituted across providers

This phase does NOT implement hosted multi-user BYOK.

## 2. Storage Scope

Add a new secret storage scope: `session_only`.

Meaning:
- server process memory only
- lost on restart
- no disk persistence
- no browser persistence
- no Obsidian persistence
- no secure-platform claim
- no guarantee of forensic RAM zeroization

Do NOT label this `secure_platform`.
Do NOT implement `local_plaintext` in this phase.

## 3. Supported Deployment Modes

BYOK-5 session-only secrets are allowed ONLY where the server is operating in an explicitly supported single-user/trusted-local deployment mode.

Allowed:
- local development
- local/self-hosted single-user
- Obsidian plugin using the protected local server
- future trusted desktop-shell backend

Blocked:
- public hosted multi-user deployments
- anonymous shared deployments
- environments without a real per-user identity/isolation boundary

A shared `AI_ENDPOINT_TOKEN` is NOT sufficient to claim multi-user isolation.

Hosted multi-user BYOK remains explicitly disabled.

## 4. Separate Policy From Credential Source

Provider/model selection and credential ownership are separate decisions.

Add non-secret credential-source intent:
- `server_environment`
- `session_only`

Do not infer credential source from provider selection.
Do not infer provider selection from presence of a session key.

Uploading a key MUST NOT silently:
- switch provider
- switch model
- switch selection mode
- override operator policy

## 5. Credential Precedence

### 1. Server-managed operator pin

If a valid operator pin exists:
- provider/model are fixed by operator policy
- credential source MUST be `server_environment`
- use operator credential only
- session key MUST NOT override operator credential
- missing operator credential -> fail closed
- invalid operator pin -> fail closed

### 2. User-selected + session_only

If no operator pin exists and user explicitly selects provider/model with `credentialSource=session_only`:
- use ONLY that session key for that exact provider
- missing/expired/revoked/invalid key -> fail closed
- NEVER fall back to `server_environment`
- NEVER fall back to another provider

### 3. User-selected + server_environment

If no operator pin exists and user explicitly selects provider/model with `credentialSource=server_environment`:
- use only that provider’s configured operator/environment key
- if missing -> fail closed
- no session-key fallback

### 4. server_default

If user intentionally chooses `server_default`:
- use existing operator-owned default provider chain
- use operator credentials only
- do NOT consume session keys automatically

Reject `server_default + credentialSource=session_only`.

## 6. Provider Scope

Session secrets MUST be scoped to exact execution-provider IDs.

Examples:
- `gemini`
- `openrouter`
- `deepseek`
- `openrouter-image`
- `gemini-image`

Do not implicitly reuse one secret between text and image provider IDs merely because they currently map to the same vendor credential.

No arbitrary secret names.
No arbitrary environment names.
No arbitrary URLs.

## 7. In-Memory Store

Implement a server-owned in-memory session credential store, preferably `server/ai/sessionSecrets.ts`.

Each entry should contain only what is operationally required:

```ts
{
  providerId,
  secret,
  createdAt,
  lastUsedAt,
  expiresAt,
  version
}
```

Recommended defaults:
- absolute lifetime: 30 minutes
- idle expiry: 15 minutes

The store must:
- support set/rotate
- support get/lease
- support revoke
- enforce expiry
- remove expired entries
- isolate by provider ID
- expose non-secret status only

Do not store:
- key prefix
- masked key
- hash derived from key
- account metadata
- provider response body

## 8. Session Identity

For BYOK-5, session identity must be tied to an explicitly supported single-user server context.

Do NOT pretend public multi-user identity exists.

If the current local server has no user/session identity abstraction, use a single-process local session scope and explicitly guard the feature behind the supported deployment mode.

Future hosted BYOK must replace this with true authenticated per-user isolation.

## 9. Key Lifecycle API

Add minimal routes.

### POST `/api/providers/session-key`

Request:

```json
{
  "providerId": "string",
  "apiKey": "string",
  "expectedVersion": "optional string"
}
```

Response:

```json
{
  "providerId": "string",
  "storageScope": "session_only",
  "configured": true,
  "version": "string"
}
```

Never return apiKey, masked key, key fragment, or key hash.

### DELETE `/api/providers/session-key/:providerId`

Response:

```json
{
  "providerId": "string",
  "configured": false
}
```

Optional GET `/api/providers/session-key/status` may contain only:
- allowlisted providerId
- configured true/false
- storageScope
- expiresAt
- version

No credential-derived values.

## 10. Request Validation

POST must enforce:
- providerId required and string only
- allowlisted provider only
- apiKey required and string only
- reject empty/whitespace-only key
- reject control characters
- reject oversized key
- reject unknown provider
- reject arbitrary secret ids
- reject arbitrary env names

Recommended body ceiling: `8 KiB`.
Recommended individual key max: `4 KiB`.

Do not truncate. Reject outright.
Return generic bounded errors. Never echo malformed key material.

## 11. Auth / Local Request Protection

These mutation routes require stronger protection than ordinary unauthenticated local GETs.

Require existing AI access protection where applicable and enforce deployment-mode gating.

For loopback/local use:
- validate Host
- validate Origin where browser-originated
- apply CSRF-safe mutation handling
- require protected transport token if current local architecture supports it

For non-loopback:
- require TLS
- reject unsupported deployment modes

Do not enable session-key routes merely because the server is reachable.

## 12. Rate Limiting / Concurrency

Add dedicated mutation limiter.

Suggested:
- POST key set/rotate: 10/min per client
- DELETE revoke: 20/min per client

No provider call should occur on simple storage mutation.
Separate any credential test from key upload.

## 13. Acceptance vs Validation

Uploading a key should NOT automatically make a paid provider request.

Acceptance flow:
1. validate request schema
2. validate provider allowlist
3. store key as configured but UNVERIFIED
4. return non-secret status

Connection validation is a separate explicit action.

Do not spend quota automatically.

For providers with quota-free authenticated credential checks, allow explicit Test Connection.

For providers without quota-free checks:
- clearly label the action as potentially billable
- require explicit user action

## 14. Connection Test With Session Key

Extend BYOK-4 connection testing so a user may explicitly test `credentialSource=session_only`.

Rules:
- use only that provider’s session key
- never substitute environment key
- operator pin policy still wins
- session key must match exact provider ID
- missing/expired/revoked key -> fail closed
- connection test returns bounded status only
- secret never returned/logged

Keep existing provider/model allowlists, response byte bounds, timeouts, no retries, and concurrency ceilings.

## 15. Provider Execution Integration

Do NOT mutate `process.env`.
Do NOT globally replace `getServerSecretSync()`.

Preferred design:

```text
Resolve provider/model/policy
→ resolve credentialSource
→ obtain exact credential lease
→ create/request-scope provider client
→ execute request
→ release lease/reference
```

Session-key availability must not depend on whether an operator environment key was present during registry initialization.

Do not place user credentials into long-lived operator-provider singletons.

## 16. Client UI

Provider Settings may gain explicit API-key controls ONLY for providers and deployments where `session_only` is supported.

UI requirements:
- password-type input
- input is ephemeral
- no auto-fill persistence
- clear input immediately after successful submission
- never re-display key
- no masked saved key
- no “show stored key”
- no copy stored key
- no localStorage
- no IndexedDB
- no SettingsAdapter persistence
- no plugin data.json persistence
- no vault persistence

Show only:
- Session key configured
- Session key expires at <time>
- Revoke
- Test Connection

Wording must distinguish configured vs credential validated.

## 17. Non-Secret Preference Changes

Extend current non-secret selection preference to include `credentialSource`.

Allowed:
- `server_environment`
- `session_only`

Persisting `credentialSource` is allowed because it is non-secret metadata.

However:
- if `session_only` is selected but key is missing/expired, request fails closed
- do not auto-change credentialSource
- do not auto-reset to `server_environment`
- do not auto-select `server_default`

## 18. Rotation / Stale Tab Protection

Use versioned key mutations.

Every successful set/rotate returns a non-secret version token.

A subsequent rotation may send `expectedVersion`.

If stale:
- return conflict
- do not overwrite newer key

Never derive the version token from the secret.

## 19. Revoke

Revoke must:
- prevent new credential leases immediately
- delete the store entry
- invalidate version
- clear associated cached request-scoped client references where applicable
- return success if already absent (idempotent preferred)

If an in-flight provider request already sent the credential:
- attempt cancellation where supported
- do not claim cancellation can undo provider charges

## 20. Restart / Expiry

Required behavior:
- process restart clears all session keys
- absolute TTL clears expired key
- idle TTL clears inactive key
- access updates lastUsedAt
- expired key is removed before use
- expired key is never silently replaced with `server_environment`

No disk serialization.

## 21. Logging / Error Safety

API keys must never appear in:
- console.log
- structured logs
- request logging
- thrown error messages
- provider errors
- diagnostics
- test snapshots
- telemetry
- crash reports
- tracing
- returned JSON

Add explicit redaction/guard tests using sentinel keys.

Avoid logging full request bodies for session-key routes.

## 22. Public Host Block

Implement an explicit fail-closed guard.

If deployment is not approved for session-only single-user BYOK, POST/DELETE/GET session-key routes return:

`BYOK_SESSION_UNAVAILABLE`

Do not merely hide the UI. Server must enforce the restriction.

## 23. Provider Catalog

Catalog may expose only non-secret fields:
- `storageScope: "session_only"`
- `sessionKeySupported: boolean`
- `sessionKeyConfigured: boolean`
- `credentialSourceOptions: [...]`

No key fragment, env var name, masked secret, hash, or provider account metadata.

## 24. Required Tests

### Security
- sentinel key never appears in any response
- sentinel key never appears in logs/errors
- sentinel key never lands in localStorage
- sentinel key never lands in IndexedDB
- sentinel key never lands in SettingsAdapter
- sentinel key never lands in plugin data.json
- sentinel key never lands in Markdown
- process.env unchanged
- unsupported hosted mode rejects session-key routes
- wrong provider rejects
- arbitrary secret ID rejects
- oversized key rejects
- control chars reject

### Lifecycle
- set key
- get non-secret status
- rotate key
- stale expectedVersion conflicts
- revoke key
- double revoke safe
- TTL expiry
- idle expiry
- process restart/new store has no key

### Isolation
- Gemini session key never used for OpenRouter
- OpenRouter text key never implicitly used for openrouter-image
- session key works without operator key
- server_environment selection works without session key
- server_default never silently consumes session key

### Precedence
- operator pin ignores user session-key override
- operator pin missing env credential fails closed
- explicit session_only missing key fails closed
- expired session_only fails closed
- revoked session_only fails closed
- no silent fallback to env key
- no cross-provider fallback

### Connection Test
- session key credential test uses session key only
- operator pin still enforced
- missing session key -> fail closed
- secret never appears in result
- existing body bounds/timeouts/concurrency preserved

### UI
- key input never prepopulated
- input clears after success
- revoke clears configured status
- no masked-key display
- no persistence through SettingsAdapter

## 25. Implementation Phasing

### BYOK-5A
- `session_only` storage scope
- in-memory secret store
- deployment-mode guard
- lifecycle tests

### BYOK-5B
- session-key API
- rate limits
- request validation
- non-secret status

### BYOK-5C
- credentialSource intent
- runtime credential resolution
- provider execution integration
- precedence tests

### BYOK-5D
- connection-test session credential support
- explicit validation UX

### BYOK-5E
- Provider Settings key-entry/revoke UI
- no persistence proofs
- stale-tab version handling

Do NOT implement everything in one giant patch.

## 26. Non-Goals

NOT in BYOK-5:
- hosted multi-user BYOK
- encrypted persistent server storage
- OS keychain
- Obsidian plaintext key storage
- `secure_platform` implementation
- `local_plaintext` implementation
- arbitrary custom provider URLs
- arbitrary model entry
- automatic provider fallback
- automatic key validation on save
- key synchronization across devices
- cloud account management

## 27. Acceptance Gate

BYOK-5 is not complete until:
- session secrets are server-memory only
- lifecycle/revoke/TTL verified
- no persistence paths contain sentinel key
- exact provider isolation verified
- operator precedence verified
- explicit `session_only` never silently falls back
- public hosted mode blocked
- connection test supports session credential safely
- UI never redisplays saved key
- all security tests pass
- lint/test/build/build:plugin/diff clean

## 28. Implementation Rules

Use Bun.

Do not manually edit `bun.lock`.

Preserve all BYOK-4 fail-closed semantics.

Do not weaken:
- provider allowlists
- model allowlists
- server-managed pin precedence
- SSRF protections
- auth protections
- rate limits
- response bounds
- no-retry behavior

Do not commit/push/tag/deploy unless explicitly instructed.

## 29. Final Architecture Principle

**SELECTION answers:** “What provider/model should execute?”

**CREDENTIAL SOURCE answers:** “Whose credential is allowed to authorize that execution?”

Those decisions must remain separate.

No secret source may silently substitute for another.

Fail closed whenever user intent, policy, or credential ownership is ambiguous.
