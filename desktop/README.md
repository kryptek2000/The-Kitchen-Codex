# The Kitchen Codex — Desktop Shell

This directory contains the thin Electron desktop runtime for the existing
Kitchen Codex application. It does **not** reimplement recipes, nutrition,
SHISO, AI Studio, Heart Voice, Markdown, or the Vault; it starts the existing
Node/Express production bundle and loads the existing React UI over loopback.

- `main.cjs` — secure BrowserWindow, backend lifecycle, native Vault IPC,
  managed Vault location, durable initialization marker, application menu.
- `preload.cjs` — narrow contextBridge API. Renderer has no Node/fs/child
  process/shell access; exposure requires the top-level document to match the
  main-process-issued application origin.
- `fsSafety.cjs` — Vault root authorization and inode identity only. It owns no
  privileged read/write operations.
- `vaultFs.cjs` + `native/tkc_vault.cc` — descriptor-relative native Vault
  filesystem helper. Every operation is anchored to the accepted root inode and
  walks components with directory descriptors; no path-based fallback follows
  intermediate symlinks.
- `security.cjs` — exact-origin and IPC sender policy.
- `vaultState.cjs` — post-acceptance restart authority.
- `chatgpt/` — optional Sign in with ChatGPT public-client OAuth, owner-only
  credential storage, model discovery, streaming Responses text, and the
  loopback bridge used by the local server's native Default Text AI selection.
  Disabled unless `TKC_CHATGPT_SUBSCRIPTION=1`. See
  `docs/CHATGPT-SUBSCRIPTION.md` and
  `docs/SHISO-C1.5-ChatGPT-Plan-Default-Text-AI.md`.
- Managed Vault: `<Documents>/The Kitchen Codex/My Recipe Vault`
  (overridable only for isolated testing with `TKC_DESKTOP_DOCUMENTS_ROOT`).
- No cloud sync, account, or remote privileged content.

## Build / run

```bash
npm run build
npm run build:desktop:native
npm run desktop       # development candidate; requires Electron dev dependency
npm run desktop:package
```

The packaged application contains the native helper at
`desktop/native/tkc_vault.node`. `desktop:package` rebuilds it from source unless
`TKC_SKIP_NATIVE_BUILD=1` is set with a supplied `TKC_NATIVE_VAULT_BINARY`.

Initialization is intentionally deferred until the user's first save. The
existing nine Signature starter templates remain read-only until then. A first
save creates the managed Vault, seeds the nine starter copies once under
`.kitchen-codex/initialization.json`, and writes the user's recipe through the
existing canonical persistence path.

Existing Vaults can be selected with **Connect Vault → Live Directory Sync**;
the native folder picker is bridged to the same FSA-compatible renderer adapter.
Established Vaults are never automatically seeded or migrated.

The native filesystem bridge is path-allowlisted, context-isolated, and does not
expose provider secrets. The Express server binds only to loopback and remains
the existing application backend.
