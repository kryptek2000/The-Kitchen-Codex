# SHISO-C1 — Unbroken Conversations

Status: IMPLEMENTED in the isolated `tkc-shiso-c1` worktree; focused tests
passed; owner acceptance pending. No commit, push, merge, install, deployment,
or release.

## 1. Goal

Make SHISO one continuous companion across long conversations, close/reopen,
recipe navigation, provider failures, and application restart, without turning
the transcript into authority.

## 2. Local-first persistence

- `src/application/shisoConversationPersistence.ts` stores conversation state
  through the existing `SettingsAdapter` (`localStorage` in the standalone /
  desktop shell).
- Storage keys are namespaced by conversation: the stable recipe identity
  (`recipe:<identity>`), `global`, or `create`.
- Retained locally: bounded messages, visible transcript entries, verified
  finding summaries, and the next message sequence.
- Explicitly NOT retained: provider credentials, session tokens, save
  authorizations/grants, and proposals. Proposals are cleared on restore so an
  old proposal can never become actionable.
- Retention: 120 messages, 120 transcript entries, 12 finding summaries, and a
  256 KiB serialized bound. Oldest content is dropped first.
- Changing Recipe A → Recipe B → Recipe A saves A, loads B, then restores A.
  Switching global/recipe/nutrition entry points for the same recipe keeps the
  same conversation. No work is performed on open or restore.

## 3. Long-conversation memory

- Visible/local transcript retains up to 120 messages.
- Each model request still carries only the recent 24-message window.
- `buildShisoContinuation` deterministically compacts older material into a
  bounded `continuation` context:
  - earlier user statements (user-authored);
  - earlier assistant notes (model-generated, explicitly not proof);
  - verified application findings (application-produced summaries);
  - an application-produced working-state note (unsaved edits/nutrition).
- Bounds: 6 earlier user messages, 4 earlier assistant notes, 6 verified
  findings, 200 chars per message, 240 chars per finding, 400 chars for the
  working state.
- The server validates and labels the continuation memory as untrusted and
  reminds the model that older findings may not describe the current state.
- The current user message is always preserved when the prompt context is
  truncated.

## 4. Provider failures and retry

- A provider failure keeps the conversation state, the user's message, and any
  verified findings already collected.
- The visible error is the existing redacted failure class.
- A `Retry message` action re-sends the retained user message without adding a
  duplicate transcript entry or duplicate model-history user message.
- A failed turn that produced no successful mutation is retryable. If a
  mutation succeeds before a provider failure, the turn returns a deterministic
  verified-findings report (no retry button), so retry cannot repeat the
  mutation.
- Cancelled tool turns do not offer automatic retry; the user is told to review
  the working recipe first. Save authorization is cleared on close, recipe
  switch, and cancellation boundaries.
- No provider/model switch or paid fallback is introduced.

## 5. Existing capabilities and boundaries

- Recipe creation, ingredient editing, explicit Save, nutrition completion,
  Advanced Nutrition Apply, entitlement, and cancellation own their existing
  paths.
- SHISO conversation restoration never restores save authorization, working
  action capabilities, or proposals.
- Requests to edit Recipe A cannot act on Recipe B after navigation; each turn
  receives the current live context and tools, and restored conversations are
  scoped by stable recipe identity.
- No cloud storage, synchronization, credentials, or recipe-Markdown transcript
  dumping.

## 6. UX

- Header continues to identify the active context and now notes that the
  conversation is kept on the device.
- A small `Restoring this conversation…` state appears while local state loads.
- Provider failures show the existing amber status with a `Retry message`
  action; the transcript and working-recipe banner remain visible.
- Signature Edition visual language and existing modal layout are preserved.

## 7. Verification

Focused SHISO group:

```text
18 files, 300 tests passed
```

Includes:

- >30-turn conversation with bounded 24-message history plus continuation;
- close/reopen and unmount/remount restoration;
- Recipe A → B → A transcript switching;
- provider timeout + explicit retry without duplicate user messages;
- no duplicate mutation when an edit succeeded before provider failure;
- retention limits and no credentials/tokens/save grants/proposals in storage;
- existing cancellation, creation, edit/save, nutrition, audit, H1/H2,
  entitlement, and security regressions.

TypeScript: PASS.
Production build: PASS.
`git diff --check`: PASS.

No full-suite repeat.

## 8. Owner preview

Isolated preview:

`http://127.0.0.1:3055/`

Disposable Vault (not the personal Vault):

`/tmp/opencode/shiso-c1-owner-vault`

Suggested acceptance:

1. Connect the disposable Vault.
2. Open Lemon Chicken and have a natural multi-turn SHISO conversation.
3. Ask for an ingredient edit (e.g. chicken → turkey), then ask a contextual
   follow-up; confirm the working-recipe banner says changes are unsaved.
4. Close and reopen SHISO; confirm the transcript is still present.
5. Open Tomato Soup and converse; return to Lemon Chicken and confirm its
   original conversation is restored.
6. Restart the preview/app and confirm the conversation is restored without
   auto-running any work.
7. Simulate or wait for a provider failure; confirm the message and verified
   findings remain and `Retry message` is offered.
8. Confirm no recipe was silently saved unless the explicit Save control was
   used.

No live provider request was made by this implementation run. The preview is
configured with the installed local provider settings for owner testing.

## 9. Limitations

- Generated Create-with-SHISO draft fields are not persisted; the conversation
  transcript is. A restored create conversation may reference a draft that must
  be regenerated or re-described.
- Local persistence is device-scoped by the existing SettingsAdapter; no
  cross-device sync is provided or claimed.
- Older continuation material is a deterministic compact summary, not a
  semantic model-generated summary; it intentionally favors bounded, auditable
  memory over extra provider calls.
