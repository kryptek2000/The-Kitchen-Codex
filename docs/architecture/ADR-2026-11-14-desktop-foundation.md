# ADR 2026-11-14 — Desktop Foundation / Native Recipe Vault

**Status:** Implemented candidate; independent F1/F2 security verification passed; GitHub CI and owner acceptance pending
**Program:** Desktop Foundation / Shared-Core Platform Architecture
**Scope:** Linux desktop candidate; portable architecture for later Windows/macOS
**Repository:** `kryptek2000/The-Kitchen-Codex` (integration worktree)
**Branch:** `feat/owner-acceptance-repair` (integration candidate)

## Context

The application already ships a full React UI, Node/Express backend, local
Markdown recipe engine, provider-neutral AI layers, SHISO, Heart Voice, Advanced
Nutrition, the Obsidian plugin, and browser File System Access persistence.
Prior work established a VaultAdapter/AssetAdapter boundary, VaultSessionAuthority,
VaultAssetScope, verified persistence, and lossless Markdown preservation.

The desktop reality before this decision was a shell launcher that started the
Node server and opened Chromium in app mode. That is not an installed standalone
runtime and still depends on the browser filesystem picker.

## Decision

Use **Electron** as a thin desktop runtime around the existing application:

- Electron starts the existing `dist/server.cjs` on a stable loopback origin.
- The real React UI is loaded unchanged from that server.
- A narrow preload IPC bridge exposes allowlisted native Vault operations.
- A renderer-side FSA-compatible handle adapts those operations to the existing
  VaultAdapter/AssetAdapter pipeline.
- No recipe, nutrition, SHISO, AI Studio, voice, Markdown, planning, cooking, or
  import logic is reimplemented in the desktop shell.

This was selected over a Chromium app-mode launcher because the owner requires
an installed standalone application with a real local Recipe Vault and no
browser folder picker. It was selected over a rewrite because feature
preservation is mandatory.

## Feasibility evidence

- The real Electron 40.10.2 candidate launched the real UI and backend.
- The existing native voice stack (`onnxruntime-node`/`kokoro-js`) loaded in the
  Electron-spawned backend; `/api/voice/status` reported available, and an
  authenticated renderer request synthesized a 228–427 KB RIFF/WAVE response.
- The existing Obsidian plugin still builds independently.
- The existing production build and all shared-core tests pass.

No existing feature required removal, stubbing, or a separate implementation.

## Shared-core preservation

Shared core continues to own recipes, Markdown, normalization, nutrition, AI
application logic, search, planning, shopping, cooking, and security policy. The
desktop shell owns lifecycle, window creation, native filesystem, settings
location, and controlled backend lifecycle only.

## Native filesystem ownership

- Managed Vault: `<OS Documents>/The Kitchen Codex/My Recipe Vault`.
- OS Documents unavailable => userData/Documents fallback; reported, never a
  personal hardcoded path.
- Existing Vaults can be selected through the native folder picker and are never
  migrated, moved, or starter-seeded without explicit approval.
- Renderer receives no Node/fs/child_process/shell access. IPC paths are
  vault-relative, allowlisted, traversal-checked, and symlink-escape checked.
- The backend binds `127.0.0.1` on a stable app-owned port (default 38471); port
  3040 is never touched. A random desktop session token is delivered as an
  HttpOnly SameSite=Strict cookie; `/api/*` rejects requests without it while
  `/api/health` remains available to the supervisor.

## Vault creation and persistence

- First launch remains the read-only nine-recipe starter cookbook.
- The managed Vault is created on first authoring/save intent, not app launch.
- A durable `.kitchen-codex/initialization.json` marker coordinates exactly-once
  starter installation.
- `beginInitialization` refuses to seed a non-empty Vault; `claimed`/`resume`
  paths seed idempotently. Interrupted initialization resumes without duplicates.
- New recipes and the nine starters become real Markdown files. A new-recipe first
  save produces ten recipes; a built-in-first save produces nine distinct copies.
- Existing Vaults are opened unchanged and receive no starter import.

## AI, SHISO, and Heart Voice compatibility

AI Studio, SHISO, provider configuration, and nutrition remain in the existing
server/apply layers. The desktop candidate renders the actual AI Studio and
SHISO surfaces, and the existing provider/security tests pass. Live provider
calls were not exercised without safe credentials.

Heart Voice is materially verified: native assets/dependencies load, status is
available, and synthesis returns a RIFF/WAVE response through the authenticated
renderer/backend path.

## No-cloud and cross-platform boundaries

No cloud account, sync, or hosted recipe storage is added. Mobile/tablet
implementation is explicitly deferred; the shared contracts remain portable.
Windows/macOS packaging should reuse the same main/preload/native-Vault design.

## Consequences / residual risks

- Linux-first package is an unpacked portable Electron bundle; installers,
  signing, auto-update, and desktop integration require a later release slice.
- Electron sandbox requires a correctly permissioned `chrome-sandbox` or
  `--no-sandbox` in constrained test environments; packaged production should
  install with the standard Electron sandbox permissions.
- The desktop session cookie protects the loopback API from unrelated local
  clients but does not create a multi-user security boundary.
- Browser FSA/Node/Obsidian still lack universal cross-process atomic CAS;
  collision-safe writes use the strongest available primitive and document the
  residual external race.
- Live external AI provider behavior and real Obsidian desktop integration were
  not part of this runtime smoke.
