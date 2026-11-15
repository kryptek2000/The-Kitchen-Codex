# Desktop Foundation — Feature Preservation Matrix (2026-11-14)

Baseline: R0–R6 worktree state at `6dd7b6e`, all grouped suites green before
desktop changes (R6: 492 files / 9,245 tests; security 1,948; image 237; plugin
build). Desktop candidate: Electron 40.10.2, packaged portable Linux bundle.

Status meanings: **PASS-RUNTIME** = exercised in the packaged app; **PASS-TESTS**
= automated suite evidence; **UI-ONLY** = surface rendered but full behavior not
live-verified; **NOT TESTED** = no safe live fixture/credential in this slice.

| Feature group | Baseline | Desktop candidate | Evidence / limitation |
|---|---|---|---|
| Single My Recipe Vault navigation | Implemented | PASS-RUNTIME | Packaged gallery/detail navigation walked |
| Signature Nine starter recipes | Implemented | PASS-RUNTIME | First save seeded 9 real files; starter-first save produced 9 distinct copies |
| Recipe CRUD / Markdown parse+serialize | Implemented | PASS-TESTS + PASS-RUNTIME first save | Packaged first save wrote real Markdown; lossless suite passed |
| Custom Markdown/frontmatter preservation | Implemented (R6) | PASS-TESTS | 7 preservation tests; browser replay earlier |
| Search/filter/sort/favorites | Implemented | PASS-RUNTIME UI + PASS-TESTS | Favorites/navigation suites pass |
| Dataview Table | Implemented | PASS-RUNTIME | Packaged table rendered |
| Recipe ratings / serving scaling | Implemented | PASS-TESTS | Existing suites pass |
| Recipe images / asset writes | Implemented | PASS-TESTS | Desktop asset adapter binary test; image matrix 237/237 |
| Vault scanning/refresh/session authority | Implemented | PASS-TESTS | Session/race/asset suites pass |
| Existing Vault compatibility | Required | PASS-RUNTIME | Disposable existing Vault auto-opened with 1 recipe, 0 starter files |
| Managed first-save Vault | New | PASS-RUNTIME | Real 10-file Vault; second recipe 11; restart 11 |
| Recipe Grabber / URL/HTML/JSON-LD import | Implemented | PASS-TESTS | Import/Grabber suites; live network not exercised on desktop |
| Create for Me / generated provenance | Implemented | PASS-TESTS | Create/save/collision/provenance suites |
| Vault Intelligence / metadata+image recovery | Implemented | PASS-TESTS | Recovery/scope/race suites; UI present |
| **AI Studio — The Codex Atelier** | Implemented | PASS-RUNTIME surface + PASS-TESTS | Workspace, Living Library, provider-config surfaces opened packaged; no live provider call |
| AI Studio provider/BYOK/session keys | Implemented | PASS-TESTS | Provider/session/secret suites pass; live BYOK not tested |
| **SHISO** | Implemented | PASS-RUNTIME surface + PASS-TESTS | Recipe SHISO modal opened with composer; cancellation/tool/error suites pass; live provider call not tested |
| **Heart Voice / audio** | Implemented | PASS-RUNTIME | Packaged backend status enabled/available; authenticated renderer synthesis returned 427,244-byte RIFF/WAVE; voice suites pass |
| **Advanced Nutrition** | Implemented | PASS-TESTS + UI-RUNTIME | Deterministic/USDA/security suites pass; Advanced Nutrition panel present; packaged Basic computation on the chosen starter did not produce a review in the smoke window (NOT verified live) |
| Cooking Mode / timers / wake lock | Implemented | PASS-RUNTIME + PASS-TESTS | Packaged Cooking Mode opened for starter recipe with steps/voice surface |
| Meal Planner | Implemented | PASS-RUNTIME | Packaged planner view rendered |
| Shopping List | Implemented | PASS-RUNTIME | Packaged list view and add-item input rendered |
| Themes / Signature styling / accessibility | Implemented | PASS-RUNTIME + PASS-TESTS | Themes view rendered; visual/accessibility suites pass |
| Printing / recipe-card export | Implemented | UI-RUNTIME + PASS-TESTS | Export surface present; native print dialog not automated |
| Settings | Implemented | PASS-TESTS + PASS-RUNTIME path | Settings/provider/theme suites; desktop profile persisted across restart |
| Obsidian plugin | Implemented | PASS-BUILD + PASS-TESTS | `npm run build:plugin` passes; plugin persistence/asset tests pass |
| Existing Chromium launcher | Implemented | Preserved | `run-kitchen-codex.sh` untouched |
| Cloud sync / accounts | Not implemented by decision | NOT ADDED | No cloud/account surface added |
| Mobile/tablet native | Deferred | NOT ADDED | Portable contracts preserved only |

## Desktop-specific evidence

- Packaged first launch: nine starters, AI Studio/SHISO/Vault Intelligence nav,
  no folder picker, no Vault files created.
- Packaged first save: `Desktop First Recipe.md` + 9 Signature Collection files.
- Second save: 11 recipes. Restart: 11 recipes, 9 starters only.
- Existing disposable Vault: 1 recipe, 1 file, zero starter imports.
- API protection: unauthenticated `/api/voice/status` -> 403; authenticated app
  calls work.
- Flows not live-verified: external AI provider completion, actual Obsidian
  desktop mount, native print dialog, native file-picker GUI interaction.
