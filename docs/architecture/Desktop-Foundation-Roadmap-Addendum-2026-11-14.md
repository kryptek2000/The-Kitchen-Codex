# Desktop Foundation — Roadmap Addendum (2026-11-14)

This is an additive status/decision note. It does not overwrite the historical
3.0 Game Plan or Projected Release Timeline.

## Implemented in this slice

- Thin Electron Linux desktop candidate around the existing React/Node app.
- Stable loopback backend origin and desktop session-cookie boundary.
- Native Vault IPC bridge with allowlisted roots and traversal/symlink checks.
- Renderer FSA-compatible native handle; existing VaultAdapter/AssetAdapter code
  runs unchanged.
- Managed Vault at `<Documents>/The Kitchen Codex/My Recipe Vault`.
- First-launch starter cookbook; first-save managed Vault initialization.
- Durable exactly-once starter marker with resume-safe seeding.
- First new recipe -> ten real Markdown recipes (original + nine starters).
- Built-in-first save -> nine distinct starter copies, no duplicate.
- Existing Vault selection/auto-open with no migration or unsolicited seeding.
- Desktop `Open Vault Folder` action in Vault settings and the application menu.
- Portable package build (`npm run desktop:package`) producing a runnable
  Electron bundle; no cloud, account, or mobile work.

## Independently verified in this slice

- Production build, plugin build, TypeScript, and the full grouped test suite
  (unit + security) on the desktop-integrated source.
- Actual packaged first save, second save, restart, existing disposable Vault,
  AI Studio/SHISO/Cooking/Planner/Shopping/Dataview/Themes surfaces, and Heart
  Voice synthesis through the authenticated desktop backend.

## Awaiting independent audit / owner acceptance

- Cross-platform installer/signing/auto-update work (Windows/macOS/Linux).
- Real provider-backed AI Studio/SHISO live calls with safe test credentials.
- Real Obsidian desktop plugin integration smoke.
- Full image upload/recovery UI replay inside the packaged app.
- Owner acceptance on the actual Linux desktop candidate.

## Blocked / environment-limited

- Automated installer creation is not part of this slice; the package is an
  unpacked portable Electron bundle.
- Browser/packager network/loopback restrictions vary by sandbox.
- No cloud/mobile implementation in this program slice.

## Planned later (not dropped)

- Windows/macOS packaged installers and update channel.
- Mobile/tablet local Vault adapters using the same application contracts.
- Optional future sync/collaboration under a separate approved program.
