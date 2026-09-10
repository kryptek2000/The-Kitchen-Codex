# The Kitchen Codex v0.7.0 — Create for Me & Vault Intelligence Image Recovery

## Highlights

- **Create for Me**: a guided recipe-creation assistant that keeps Obsidian
  Markdown canonical — save-lock keys are normalized, recipe content changes
  and vault-session changes are detected as conflicts, and the guarded Save can
  never silently commit behind a stale session or closed window.
- **Vault Intelligence Image Recovery**: recipes with missing or broken images
  are detected locally (syntax-only, read-only — no remote probing), and you
  can explicitly generate an image, preview it before it touches the vault,
  then Save, Regenerate, or Cancel.
- **Canonical vault-integrity hardening**: collision-safe local `Assets/`
  writes, generated-image provenance metadata, and no silent replacement of
  valid images.
- **Provider/error resilience groundwork**: a real `ImageProvider` abstraction
  (Gemini first) with an exact, user-facing failure taxonomy.

## Image Recovery

- Missing/broken-image detection surfaced through Vault Intelligence.
- **Explicit Generate Image** — generation only ever starts from a user action.
- **AI preview before save** — you see the generated image before anything is
  written to the vault.
- **Save / Regenerate / Cancel** controls in the recovery UI.
- Collision-safe vault writes: `Assets/Title.png`, then `Assets/Title (n).png`.
- Generated-image provenance recorded in the frontmatter.
- Recipe-change / vault-change conflict protection before committing.
- **No silent replacement of valid images**; broken images are only replaced by
  an explicit Save.
- **No automatic image generation** on save, scan, render, or resolve paths.

## Provider Behavior

- Gemini image generation with a bounded, distinct outcome per case: quota,
  rate-limit, timeout, unavailable, blocked prompt/safety, no-image, or auth —
  each with its own HTTP code and message (no generic collapse).
- **Image generation availability depends on the provider/model quota.**
  Generation is best-effort; a quota/rate-limit response reflects the provider
  account, not an application bug.

## Security & Integrity

- Pre-decode base64 memory guard: oversized/oversized-encoded payloads are
  rejected before any allocation.
- Transient preview tokens for generated-image previews.
- Server-side keys only — no prompt, key, or base64 content leaks to logs or
  clients.
- SSRF guard and security/trust behavior preserved; canonical Markdown remains
  the source of truth.
- New security wiring tests cover the image generate/preview routes and their
  rate limiters.

## Testing

- **1583 automated tests** across 103 files at v0.7.0 completion.
- **98 security tests** across 8 files.
- Browser build, plugin build, typecheck, and `git diff --check` all clean.
- 0 blocking / 0 important findings at release.

## Known Limitations

- Browser `AI_ENDPOINT_TOKEN` compatibility remains a documented app-wide
  limitation (public-host-deployed browser previews rely on the same gap).
- Gemini image generation can be quota/rate limited by the provider
  account/project; availability is provider-dependent and not guaranteed.