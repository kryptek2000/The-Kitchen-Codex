# SHISO-C1.6-F1 — Draft Presentation & Generation Latency

**Status:** IMPLEMENTED / FOCUSED + LAYOUT VERIFICATION PASSING / UNCOMMITTED  
**Base:** SHISO-C1.6-R1 worktree  
**Scope:** Create for Me generated-draft presentation and bounded latency diagnostics

## Part A — Signature Edition draft editor

`CreateForMeDraftView` now renders a controlled, structured draft instead of raw
text areas:

- Fraunces serif title with auto-sizing/wrapping
- Plus Jakarta Sans body and controls
- Warm-gold accents and theme CSS variables
- Editable description, servings, prep time, cook time, total time, and notes
  only when those fields exist
- Individually editable ingredient rows:
  - amount, unit, name, preparation, optional flag
- Numbered preparation steps with editable instruction and timer minutes
- No monospaced body text, no nested scrollboxes, one modal scroll container
- Modal width `3xl`, max-height `90vh`
- 40px minimum input height; 44px minimum action targets
- Focus-visible rings on title, ingredients, steps, and timer controls
- `Generated Draft` / `Not saved yet` status preserved
- Discard and explicit Save to Vault preserved
- The general Recipe Editor and stored Vault recipes are untouched

Save now reads the controlled `editedDraft`, validates it through the existing
authoritative `normalizeGeneratedRecipeDraft`, and only then adapts/writes. Empty
title, ingredient names, or steps are rejected with a bounded message.

Legitimate fields survive save:

- preparation is retained in the ingredient text/note
- optional is retained as `(optional)` in the generated ingredient Markdown
- step `timerMinutes` is retained in the saved instruction prose when absent
  from the text, since the shared serializer has no separate timer field
- description, servings, prep/cook/total time, cuisine, course, tags, difficulty,
  and notes are preserved

## Part B — bounded latency diagnostics

Server `generateRecipeDraftOnServer` records a `CreateRecipeTiming` event when the
route supplies an `onTiming` sink:

```json
{
  "validationMs": 0,
  "catalogMs": 26,
  "catalogRefreshed": true,
  "selectionMs": 0,
  "providerMs": 7,
  "parseMs": 1,
  "outcome": "draft",
  "nativePlan": true,
  "providerId": "chatgpt-plan",
  "model": "gpt-plan-test",
  "totalMs": 35
}
```

- The actual deterministic built-server probe used a fake loopback bridge; those
  millisecond values demonstrate instrumentation only, not ChatGPT latency.
- The route logs only `[create-for-me] timing <JSON>` with durations, outcome,
  provider/model, and booleans. It never logs prompts, recipe content, raw model
  responses, tokens, or bridge secrets.
- Outcomes include `draft`, `invalid_response`, `unavailable`, `cancelled`,
  `unsupported`, and `provider_error`.
- The client displays elapsed seconds while generation is in progress and
  `Validated draft ready in X.Xs` only after a validated draft exists.
- The client does not claim completion before `GENERATION_SUCCESS`.

### Duplicate/redundant call investigation

- The Create for Me native branch previously refreshed the bridge catalog on
  every request. A server-side freshness guard now reuses a catalog refreshed
  within the last 15 seconds (typically by AI Studio).
- The native execution path still performs its own forced account/model
  revalidation immediately before inference. That is a security boundary and was
  intentionally retained; it is not a redundant UI catalog refresh.
- A cold catalog still performs one explicit server refresh plus the execution
  revalidation. A warm catalog avoids the duplicate server refresh.
- The timing fields separate validation, catalog refresh, selection, provider
  inference (including the native execution check), strict parse/validation, and
  total server time. Client total/display time is measured in the modal.

## Verification

- Focused F1/Save/UI tests: passed.
  - structured display, metadata, optional, timer, no invented fields
  - controlled edits preserve all legitimate fields
  - edited draft save retains preparation/optional/timer/metadata
  - in-progress feedback appears before the validated draft
- Existing C1.6-R1 validation tests: passed; unexpected nested ingredient/step
  fields remain rejected.
- Built `dist/server.cjs` probe: valid draft, one bridge inference, exact
  account/model, no API key, no token leak, timing event present.
- TypeScript/build/diff checks: passing (see implementation report).
- Layout evidence at 1440, 834, and 390 CSS px:
  - no draft/modal horizontal overflow
  - descriptor/card width remains inside viewport
  - Fraunces title and Plus Jakarta body fonts active
  - title/ingredient/step inputs min 40px height
  - explicit focus ring on title
  - four ingredient rows and three numbered steps render
  - optional flag and timer value visible

### Real latency limitation

No live provider latency measurement was performed in this repair pass. The
owner's previous GPT-6.2-Sol Create for Me succeeded, but timing instrumentation
did not exist at that moment. The next owner-initiated preview request will
produce the bounded `[create-for-me] timing` event for real phase durations.
Model speed comparisons require separate owner-initiated tests; no automatic
model switching or fallback was added.

### Boundaries

No commit, push, merge, installation, deployment, paid inference, owner account
access, or personal Vault change was performed by the implementor. The installed
application remains SHISO-C1.5; the preview is the isolated workspace-5 build.
