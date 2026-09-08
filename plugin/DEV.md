# The Kitchen Codex — Obsidian plugin (development notes, Phase 4D3B)

Minimal desktop Obsidian plugin proving "one core, multiple shells". It hosts a
small React surface (`src/application-ui/RecipeWorkspace.tsx`) over the
platform-neutral application pipeline, backed by Obsidian adapter implementations.

## Build

```bash
bun run build:plugin
```

Output: `plugin/main.js` (bundled by esbuild, `obsidian` externalized, React + the
platform-neutral application/core code bundled in).

## Install locally

Copy the plugin folder into a vault's plugin directory:

```bash
mkdir -p <vault>/.obsidian/plugins/the-kitchen-codex
cp plugin/main.js plugin/manifest.json plugin/styles.css <vault>/.obsidian/plugins/the-kitchen-codex/
```

Then in Obsidian: **Settings → Community plugins → Turn on community plugins →
enable "The Kitchen Codex"**. (You may need to restart Obsidian or toggle the plugin off/on.)

Required manifest files: `manifest.json` (id, name, version, `isDesktopOnly: true`),
`main.js` (bundled entry), `styles.css` (optional styling).

## Open the Kitchen Codex view

- Use the command palette: **Open Kitchen Codex**.
- Or click the chef-hat ribbon icon.

The view lists the vault's recipes, opens a detail/editor for a selected recipe,
and saves edits back through `ObsidianVaultAdapter` (canonical parse → serializer →
vault write). It is read-first: defaults, nested paths, prose, aliases, and
frontmatter are preserved.

## Backend URL configuration

The plugin can call the Kitchen Codex app backend for AI/JSON endpoints. Set a
backend origin (a NON-secret setting, e.g. `http://127.0.0.1:3000` or a hosted
Kitchen Codex URL) via the plugin `backendUrl` setting in the plugin's `data.json`.
The `ObsidianNetworkAdapter` prepends this origin to `/api/...` calls. This is NOT
a provider API key; BYOK/provider keys are intentionally deferred (v0.7).

## Scope / non-goals (this phase)

- No browser FSA, no `vaultFileSystem`/`vaultAssets`, no `AssetAdapter`, no binary
  image download.
- No BYOK, no auth/session, no cloud sync, no mobile/PWA.
- Images are intentionally deferred; Obsidian renders attachments natively.
