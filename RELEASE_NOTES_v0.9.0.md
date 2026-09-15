# The Kitchen Codex v0.9.0 — Explicit AI Recipe Images & Verified-Free Generation

## Highlights

- **Verified-free recipe generation**: separate structured-text and
  recipe-generation capability verification, so a model must be verified for the
  recipe task itself — not merely for text. Current verified-free OpenRouter
  recipe models can generate editable drafts.
- **Single-attempt, terminal generation**: verified dynamic generation makes one
  attempt and stops — no silent paid/provider fallback, no model fallback, and
  no retries.
- **Fail-closed credentials and capability**: credentials and capability
  authorization fail closed on replacement, revocation, expiry, source
  mismatch, or catalog changes; generated recipes remain unsaved drafts until an
  explicit Save.
- **Nutrition safety repair**: removed fabricated algorithmic nutrition
  authority and disabled automatic application/saving of untrusted machine
  nutrition, while keeping existing manual and legacy nutrition readable,
  editable, scalable, and round-trip safe.
- **Licensed representative recipe images**: explicit Openverse / Wikimedia
  Commons search under a closed reusable-license allowlist, with preserved
  attribution and app-local protected thumbnails.
- **Explicit AI recipe image generation**: deliberate, never automatic, with
  truthful pricing disclosure, one-confirmation-per-generation, and a transient
  preview until `Use This Image` and recipe Save.
- **Live acceptance**: a biscuit image was generated with OpenRouter Image using
  `google/gemini-2.5-flash-image` at a disclosed cost of approximately $0.03,
  accepted explicitly, saved into the vault `Assets/` folder, and reloaded after
  reopening — with no automatic generation.

## Verified-Free Recipe Generation

- **Separate verification**: structured-text capability and recipe-generation
  capability are verified independently. A model that passes text verification
  is not automatically trusted to author recipes.
- **Editable drafts**: current verified-free OpenRouter recipe models can
  generate recipe drafts that remain fully editable before any save.
- **Single attempt, terminal**: verified dynamic generation is one attempt and
  terminal. There is no silent paid fallback, no provider fallback, and no
  model fallback.
- **Fail-closed authorization**: credentials and capability authorization fail
  closed on replacement, revocation, expiry, source mismatch, or catalog
  changes.
- **Explicit save only**: generated recipes are unsaved drafts until the user
  explicitly saves them.

## Nutrition Safety Repair

- **No fabricated authority**: the previous fabricated algorithmic nutrition
  authority has been removed.
- **No automatic untrusted writes**: automatic application and saving of
  untrusted machine nutrition is disabled.
- **Legacy safety preserved**: existing manual and legacy nutrition remains
  readable, editable, scalable, and round-trip safe.
- **Deferred**: Advanced Nutrition and a trusted future nutrition engine remain
  deferred and are not part of v0.9.0.

## Licensed Representative Recipe Images

- **Explicit search**: Openverse / Wikimedia Commons search runs only on an
  explicit action.
- **Closed license allowlist**: only CC0, Public Domain, CC BY, and CC BY-SA
  results are eligible.
- **Attribution and provenance preserved** for every selected image.
- **App-local protected thumbnails**: no browser hotlinking; thumbnails load
  only through the authenticated app-local binary transport.
- **Representative, not exact**: a representative image may resemble the recipe
  but is not guaranteed to depict the exact dish.
- **Deferred Asset creation**: nothing is written to `Assets/` until an
  explicit recipe Save.

## Explicit AI Recipe Image Generation

- **Free default**: Licensed Search remains the free default.
- **Never automatic**: AI generation is deliberate and never runs as a side
  effect of save, scan, render, or resolve.
- **Truthful disclosure**: the exact provider/model and truthful pricing
  classification are shown before generation.
- **Confirmation each time**: paid or variable generation requires confirmation
  for every generation.
- **One call**: one confirmation permits exactly one provider call, with no
  retries and no provider/model fallback.
- **Transient preview**: the preview remains transient until `Use This Image`
  and recipe Save.
- **Safe persistence**: collision-safe Asset creation, transaction-owned
  rollback, provenance separation, capacity reservations, and requester-bound
  previews.
- **Authenticated transport**: browser and Obsidian binary preview transport use
  authenticated app-local requests.

## Live Acceptance

- OpenRouter Image generated a correct biscuit image using
  `google/gemini-2.5-flash-image`.
- The disclosed cost was approximately $0.03.
- The image required explicit acceptance (`Use This Image`) and an explicit
  recipe Save.
- It persisted into the vault `Assets/` folder and loaded after reopening the
  recipe.
- No automatic generation occurred.

## Known Limitations

- **Pricing**: AI image pricing may be paid or variable and depends on the
  selected provider account. AI image generation is **not** claimed to be free.
- **Key required for AI generation**: a configured image-provider API key is
  required for AI generation; licensed search does not require one.
- **Protected deployments**: `AI_ENDPOINT_TOKEN`-protected browser/plugin
  deployments do not yet have a repository-owned secure Unlock/bootstrap token
  source and therefore remain unsupported/fail-closed.
- **Collision scope**: Browser File System Access collision protection covers
  concurrent transactions within the active application realm; it does not claim
  universal cross-tab/process atomicity.
- **Representative images**: licensed matches, not guaranteed exact depictions.
- **Advanced Nutrition** is not included in v0.9.0.

## Verification

- 2791 / 2791 Vitest tests across 171 files.
- 428 / 428 security tests across 29 files.
- Typecheck, production build, and plugin build clean.
- `git diff --check` clean.

## Upgrade Notes

- No manual migration is required. Existing recipes, nutrition, and
  representative-image provenance remain valid and round-trip safe.
- AI image generation requires a configured image provider key; Licensed Search
  stays free and available without one.
- Nothing is written to the vault `Assets/` folder until an explicit recipe
  Save, and no image is ever generated automatically.
