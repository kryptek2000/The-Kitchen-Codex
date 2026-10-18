# SHISO — implementation, acceptance and release status

Evidence reviewed October 18, 2026. Baseline:
`49fbfce80f39437120e57cee02df6c7363531320` (local HEAD/main/origin/main and
GitHub main agree). This is a documentation reconciliation, not a release or a
new execution of application tests. Sid retains sole release authority.

## Source reconciliation

| Source | What it contributes | What is superseded |
| --- | --- | --- |
| A: roadmap tracked on main | One companion, existing application authorities, phased scope | “No Shiso code exists”; current one-shot-only Create inventory; blanket prohibition on labeled AI nutrient estimates |
| B: protected local modified roadmap | C1 ownership boundaries, real recipe/nutrition context, proposal review | “UNCOMMITTED”, five-tool inventory, no recipe editing/Create, and “shipped” language cannot describe current deployment status |
| C: [draft PR #11](https://github.com/kryptek2000/The-Kitchen-Codex/pull/11), `8de8b9c5b465704740cb184a9e9d826b4b2a7966` | AI-first nutrition, free Basic, unified terminology, Explore My Vault and retained Vault Intelligence direction | “Uncommitted” implementation reports and future-only creation/UI consolidation |
| [Merged PR #12](https://github.com/kryptek2000/The-Kitchen-Codex/pull/12) | Implementation and subsequent fixes merged at the baseline above | Its original PR body still says draft/unmerged; live PR metadata and merge commit supersede that text |

PR #11 remains open, draft and unmerged on `docs/shiso-ai-first-nutrition-20261016`.
No merge or cherry-pick is needed for this reconciliation. Preserve its product
intent; after Sid approves these files, prefer a fresh docs-only PR based on
current main and close #11 as superseded with a cross-link. Those GitHub actions
require separate authorization and have not occurred.

## Capability status and code evidence

“Implemented” below means merged on the stated main revision, not production
release, universal provider support, complete phase delivery or user acceptance.

| Capability | Merged evidence | Acceptance boundary |
| --- | --- | --- |
| Chat with Shiso; one companion with contextual entry points | `src/components/ShisoModal.tsx`, `src/application-ui/shisoEntryPoints.tsx`, `src/application/shisoConversation.ts`, `server/shiso/conversationTurn.ts` | Foundation exists; real selected-provider reliability and user acceptance pending |
| Bounded recipe/nutrition tools and proposed corrections | `src/core/shiso/protocol.ts`, `src/application/shisoTools.ts`, `src/core/shiso/proposalActions.ts` | Current vocabulary has eleven tools, including authorized editing/save; not arbitrary file or database access |
| Create with Shiso and draft refinement | `src/components/VaultHeader.tsx`, `src/components/ShisoModal.tsx`, `src/application/createForMe.ts`; `tests/unit/shisoRecipeCreation.test.tsx` | Sid reported live generation, multi-turn refinement, Undo, explicit Save and Reopen acceptance. This covers the tested configuration, not every provider/model or future parity work |
| Recipe edits and authorized Save | `src/core/shiso/recipeEditing.ts`, `src/core/shiso/saveAuthorization.ts`; `tests/security/shisoH2SaveAuthorization.test.ts`, `tests/unit/shisoH2UiEditing.test.tsx` | Unsaved edits are distinct from persistence; save commands must be explicit, current and recipe-bound, or use a trusted Save control |
| Free Basic Nutrition | `src/application/catalogBasicNutrition.ts`, `src/browser/basicNutrition.ts`; `tests/unit/basicNutritionServingsFix.test.tsx` | Local pinned USDA calculation, disclosed quantity assumptions and partial subtotals; no paid provider dependency; incomplete source coverage remains visible |
| Advanced Nutrition / Nutrition with Shiso | `src/components/AdvancedNutritionModal.tsx`, `server/shiso/aiNutrition.ts`, `src/core/shiso/nutritionCorrections.ts`; `tests/unit/shisoEstimatedNutrition.test.ts`, `tests/unit/shisoNutritionAcceptanceRepair.test.ts` | Sid reported Cochinita Pibil AI analysis, Apply, Save and saved-report Reopen acceptance. Broader recipes, provider compatibility and edge-case coverage remain to be accepted |
| Provider selection and boundary protection | `server/ai/*`, `server/shiso/turnRequest.ts`; `tests/unit/shisoUniversalProvider.test.ts`, `tests/security/pr12HttpBoundaries.test.ts` | Tests cover native structured output, malformed JSON, expired credentials, entitlement/auth/rate limits; not proof that every provider/model works live |
| Explore My Vault | Existing legacy retrieval is reusable; no Vault-search tool in the merged SHISO vocabulary | Future grounded read-only integration, including real links and deterministic membership |
| Vault Intelligence through Shiso | Existing deterministic dashboard/scanner/repair owners are retained | Future SHISO integration: actual scan explanation, then previewed single and separately authorized batch repairs |

## Verification and remaining human acceptance

[Post-merge build run 39124844757](https://github.com/kryptek2000/The-Kitchen-Codex/actions/runs/39124844757)
completed successfully for the exact baseline: lockfile check, TypeScript,
**8,639 tests across 443 files**, application build, Advanced Nutrition browser
proof (**76 passed, 0 failed**), plugin build and isolation (**16 passed, 0 failed**).
[Post-merge CodeQL run 39124844437](https://github.com/kryptek2000/The-Kitchen-Codex/actions/runs/39124844437)
also completed successfully. Green scanning does not mean no open alerts.

The browser proof (`scripts/verify_advanced_nutrition_browser_prod.ts`) drives the
built app and production server in headless Chrome with a fixture imported via
the real UI. It checks the pinned local USDA bundle, deterministic review,
Apply/persisted output, entitlement/readiness and runtime behavior. It expressly
checks **zero provider/live-USDA/external requests**. “Production-browser proof”
means a production build under test, not an independently deployed production
service or live AI acceptance. No such deployment is verified by this record.

Protected local repair notes report earlier Basic serving/partial-result browser
checks and automated nutrition round trips. They are historical local reports,
not proof of current real-provider acceptance. They remain unmodified and are
not included in this documentation patch.

Remaining acceptance, under separate authorization:

- Selected-provider chat and tool handoffs; credential replacement/expiry,
  errors and cancellation without silent provider/model fallback.
- Re-run selected-provider reliability, expiry/replacement, cancellation, error
  and tool-handoff checks; one operational model does not establish universal
  provider compatibility.
- Broader nutrition regression across Huevos Rancheros tortillas, Cochinita
  Pibil ingredient identity/volume/wrapper edge cases, separated eggs, unsalted
  butter and Guacamole estimates. Cochinita's reported end-to-end pass does not
  imply every recipe or ingredient is resolved.
- Preserve manual New Recipe and verify parity before retiring legacy surfaces;
  evaluate any additional disposable-Vault repetitions as focused regressions.
- Security-backlog triage and explicit release approval. No task here authorizes
  live provider use, personal Vault mutation or deployment.

## Release security backlog versus fixed PR findings

Latest reviewed read-only GitHub CodeQL alert snapshot, dated October 18, 2026
(the Code Scanning page could not be refreshed in the current session):

- **Preexisting main alert [#40](https://github.com/kryptek2000/The-Kitchen-Codex/security/code-scanning/40)**
  (`js/type-confusion-through-parameter-tampering`, critical,
  `src/core/nutritionV2/aiWholeRecipeInterpretation.ts`) was created October 11
  against the pre-merge main lineage. GitHub now reports **fixed**, with
  `fixed_at` October 18 at 11:52:24 UTC. The prior “unresolved #40” statement is
  superseded; retain it as historical release-triage context, not an open blocker.
- PR-associated rate-limit alerts **#41 and #42** now report **fixed**.
  PR #12 also includes malformed-input/entitlement and rate-limit regression
  coverage, nutrition corrections and save-authorization repairs in `0c87c32`,
  `932d707` and final head `2f30b9c`. These fixes are not a clean bill of health
  for the entire repository.
- **25 alerts were open in that snapshot** below. This is a dated observed count,
  not a claim that the live count has been refreshed at publication time.
  These are scanner findings requiring triage, not independently confirmed
  exploitability. Do not label them fixed by PR #12 or waive them because CI is green.

| Open alerts | Rule / affected area |
| --- | --- |
| #2–6 | High: polynomial ReDoS in endpoint auth, metadata recovery and representative images |
| #7–12 | High: DOM XSS in recipe card/export/detail/grabber/editor surfaces |
| #13 | High: bad tag filter in recipe grabber |
| #14–18 | High: incomplete multi-character sanitization in recipe grabber / Markdown parser |
| #19 | Medium: bad code sanitization in brand-theme browser verification script |
| #20 | High: insecure randomness in `src/App.tsx` |
| #21 | High: resource exhaustion in image content-type verification script |
| #25 | High: tainted format string in `server/errorHandler.ts` |
| #29 | High: insecure Helmet configuration in `server/securityHeaders.ts` |
| #36 | Medium: missing workflow permissions in `.github/workflows/build.yml` |
| #37 | Medium: bad code sanitization in Advanced Nutrition browser verification script |
| #38 | High: incomplete sanitization in the Phase 9B semantic-route security test |

Source: [repository code-scanning alerts](https://github.com/kryptek2000/The-Kitchen-Codex/security/code-scanning).
This inventory covers CodeQL/code-scanning only; dependency and secret-scanning
status were not assessed. Before release, reproduce/triage applicable findings,
record fixes or justified dispositions, rerun relevant checks, and obtain Sid's
explicit release decision. This docs-only task changes no security code.
