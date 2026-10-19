# Shiso — Architecture and Roadmap

**Status — October 18, 2026:** Product direction reconciled against merged PR #12,
`main` at `49fbfce80f39437120e57cee02df6c7363531320`.
SHISO conversation, recipe creation/editing and nutrition implementation exist on
main. Merged and CI-tested does not mean independently production deployed or
accepted by Sid. See [acceptance status and evidence](./Shiso-Acceptance-Status.md).
The local C1 roadmap and draft PR #11 are historical inputs, not current release
inventories. This document reconciles their intent without merging PR #11.

- Decision owner: Sid (sole release authority)
- Document scope: product direction and phased program
- Relationship to Advanced Nutrition: see §10 and
  [`Advanced-Nutrition-Architecture.md`](./Advanced-Nutrition-Architecture.md)

---

## 1. One AI companion: Shiso

The Kitchen Codex will have **ONE** AI companion, named **Shiso**.

Shiso is the conversational AI intelligence surface for the product. Shiso
understands intent, reasons over the user's kitchen, and prepares transparently
attributed estimates and proposed changes. Application code retains validation,
calculation, health scoring and persistence authority.

Retired from the forward roadmap — do not build these as separate products:

- `Ask This Recipe`
- `Ask My Kitchen`
- `Recipe AI Chat`
- `Nutrition Chat`
- any standalone AI recipe generator brand

The shape is **one brain, multiple entry points**:

```
ONE SHISO BRAIN
+
MULTIPLE CONVENIENT ENTRY POINTS
```

`Ask My Kitchen` and `Ask This Recipe` are **retired from the forward product
roadmap**. They are not future Shiso entry points, and no future Shiso surface
will be named after them.

Those features shipped and remain in the codebase. This program does **not**
rename, remove, or rewrite them; if they still exist in production UI at the
time any Shiso phase begins, they are left alone unless separately authorized.
All future Shiso entry points use Shiso terminology (`Chat with Shiso`,
`Create with Shiso`, `Ask Shiso`).

The context supplied to a conversation may differ depending on where Shiso is
opened — that is what makes it one companion with several entry contexts — but
there is only ever **one** Shiso.

---

## 2. Entry points are contexts, not separate assistants

Different surfaces launch the **same** conversation with a different starting
context:

| Entry point | Initial context |
| --- | --- |
| Global Shiso button | general conversation |
| `Create with Shiso` | recipe-creation intent established |
| recipe page → Shiso | that recipe supplied as scoped context |
| meal planner → Shiso (future) | current meal-plan context |
| Explore My Vault (future) | scoped Vault retrieval and grounded recipe results |
| Vault Intelligence through Shiso (future) | actual scanner results and proposed repairs |
| Nutrition with Shiso | recipe analysis and review in Advanced Nutrition |

These are **contexts supplied to one conversation**, never separate assistants
and never separate conversation engines. A user already in a general Shiso chat
who says *"Create me a lasagna recipe"* must reach the **same** recipe-creation
capability that `Create with Shiso` opens. There must not be a Shiso recipe
generator and a separate Create-for-me recipe generator.

Preferred product wording going forward:

- `Shiso`
- `Chat with Shiso`
- `Ask Shiso`
- `Create with Shiso`
- `Explore My Vault`
- `Nutrition with Shiso` (inside Advanced Nutrition)
- `Vault Intelligence` (retained dashboard)
- `Shiso is thinking…`

---

## 3. Shiso leads nutrition interpretation; Kitchen Codex protects state

**Decision update — October 16, 2026:** Shiso leads AI interpretation and estimation in Advanced Nutrition; Basic remains free and offline, with optional future SHISO enhancement. The USDA catalog, local parser, conventional portion data, and deterministic calculator are tools and evidence; missing an exact USDA household portion is not an automatic prohibition on a useful, clearly marked estimate.

Shiso MAY:

- interpret recipes holistically, including food preparation, ingredient function, edible yield and whether an ingredient is consumed;
- use the existing pinned USDA catalog and application calculation services;
- consult reputable external ingredient/weight/nutrition references **when an authorized, safe web-retrieval capability is built and available**;
- propose reasonable AI-estimated quantities, substitute reference foods, nutrient approximations and uncertainty bounds when authoritative records are incomplete;
- combine known contributions into useful partial totals and label remaining unknown values;
- execute scoped recipe edits through the existing authorized application action owner.

A nutrient line must always distinguish **source-backed**, **source-informed estimated amount**, **AI-supported estimate**, or **unknown**. Neither a generated value nor a web page becomes a fabricated USDA measurement; save provenance, assumptions and source pointers where applicable. AI estimation is a permitted approximate method, not a claim of laboratory precision.

Kitchen Codex application owners retain authority over **input validation, arithmetic and serving conversions, stale-state checks, provenance representation, user entitlement/provider security, and explicit Apply/Save persistence**. Shiso cannot directly write Vault files, invent USDA record identifiers, silently treat incompatible units as equivalent, or bypass a user's save authorization. Lack of a precise source should not blank out available, correctly labeled contributions.

For recipes with insufficient evidence for a credible ingredient value, the result stays unknown; do not invent numbers just to report complete coverage. This is a safety and honesty standard, not an instruction to return an unusable page for an otherwise calculable recipe.

## 4. Recipe creation as a Shiso capability

The product decision: the standalone AI recipe-generation capability keeps its
capability but takes the product identity, **`Create with Shiso`**.

Conceptually these coexist:

- `+ New Recipe` — manual recipe creation
- `Create with Shiso` — a Shiso conversation focused on creating a recipe
- `Chat with Shiso` — general Shiso conversation

Intended conversational experience:

```
User: "Make me a chicken pasta dinner."
Shiso: creates/proposes a structured recipe.
User: "Make it dairy free."
Shiso: updates the proposal.
User: "Serve six."
Shiso: uses Kitchen Codex scaling.
User: "Make it spicier."
Shiso: updates the recipe.
User: "Looks good. Save it."
      -> Kitchen Codex recipe persistence performs the save.
```

The conversation continues naturally; it does not terminate after one generated
response. **One conversation model** (§6) applies — no separate conversation
engines per feature.

### 4.1 Historical Create-for-me inventory (pre-PR #12)

The following inventory records the earlier one-shot implementation and original
migration plan, including historical line numbers. It is retained as design
context, not a description of today's entry point. PR #12 implements **Create
with Shiso** in `ShisoModal.tsx`, including prior-draft refinement, and retains
the validated generator and application-owned saver. The historical assertions
below about one-shot requests, UI labels and future migration do not describe
that merged SHISO path. Current status and tests are in the acceptance record.

**Surface**

- Trigger: `src/components/VaultHeader.tsx:141-150`, button
  `id="create-for-me-header-btn"`, label `"Create for Me"`.
- Modal: `src/components/CreateForMeModal.tsx:108`, mounted at
  `src/App.tsx:2178-2183`.

**Call chain**

```
VaultHeader button -> App.tsx:1857 (isCreateForMeOpen)
  -> CreateForMeModal.generate() (CreateForMeModal.tsx:151)
  -> createForMeSession.runGuarded (createForMeSession.ts:61)
  -> requestGeneratedRecipe (src/utils/createForMe.ts:129)
  -> POST /api/recipes/generate
  -> server/app.ts:1811 route
  -> generateRecipeDraftOnServer (server/createRecipe.ts:269)
  -> resolveRoleCandidates('createRecipe') -> runWithAiFallback
  -> provider.generateStructured(buildCreateRecipePrompt(...), buildGeneratedRecipeSchema())
  -> normalizeGeneratedRecipeDraft (server) -> draft + provenance JSON
  -> normalizeGeneratedRecipeDraft again (client) -> GENERATION_SUCCESS
  -> draft preview; explicit "Save to Vault"
  -> generatedDraftToObsidianRecipe (src/application/createForMe.ts:59)
  -> serializeRecipeToObsidianMarkdown -> vault.writeText
```

**Provider ownership** — already shared, not bespoke

- Operation role `createRecipe`: `server/ai/operations.ts:20`, requiring
  capabilities `["structuredOutput", "recipeGeneration"]` — the only operation
  with two.
- Selection through the shared effective-selection layer
  (`server/ai/roleCandidates.ts:45` -> `server/ai/effectiveSelection.ts:246`) and
  the shared registry (`server/ai/providerRegistry.ts:312`), the same trio used
  by Advanced Nutrition.
- Per-role model map: `server/ai/roleModels.ts:38,51,72`.
- Capability verification: `recipe_generation_v1` with dispatch-time
  re-authorization (`server/createRecipe.ts:203`).
- Shared guards: `textPricingGuard` (`server/app.ts:1811`),
  `createRecipeRateLimiter` (`server/rateLimiter.ts:601`),
  `requireAiAccessToken`.

**Generated-recipe data contract** — `src/schema/generatedRecipe.ts`
(platform-neutral, shared by server and client)

- `GeneratedRecipeDraft` `:64-78`, explicitly NOT a `CanonicalRecipe`.
- `validateGeneratedRecipeDraft` `:210-271` — includes an **allowlist that
  rejects unknown top-level fields** (`:216-221`).
- `normalizeGeneratedRecipeDraft` `:165-199`.
- `buildGeneratedRecipeSchema()` `:280-323`.

**Save authority** — fully deterministic application code, never AI

- `generatedDraftToObsidianRecipe` (`src/application/createForMe.ts:59-126`)
  runs `normalizeCanonicalRecipe` -> `canonicalToObsidianRecipe`, assigns a
  collision-safe vault path (`resolveNewRecipeVaultPath`), writes
  `codex_generated*` provenance frontmatter, then serializes.
- `saveGeneratedRecipeToVault` `:224-237` refuses a path collision before any
  write.
- The server **never** saves; an explicit user `Save to Vault` press is
  required, and the draft is badged `Not saved yet`.

**One-shot, not conversational** — confirmed

`CreateRecipeRequest` is `{ prompt, constraints? }` only. There is no
conversation id, turn index, or prior-draft parameter. `CreateForMeStatus` is
`prompt | generating | draft | error` with a single draft slot. "Use thighs
instead" is only achievable by starting a brand-new generation that never sees
the previous draft.

**Nutrition on generated recipes** — none, by design

`GeneratedRecipeDraft` has no nutrition, calorie, macro, or mass field, and the
provider JSON schema exposes none, so the model *cannot* emit one. Nutrition is
produced afterwards by the separate Advanced Nutrition workflow; current
AI-supported estimates must retain the provenance rules in §3 and §5.

**Migration strategy — extract, do not rewrite**

Retain unchanged: `src/schema/generatedRecipe.ts` in full (contract, validator,
normalizer, schema); the deterministic persistence path in
`src/application/createForMe.ts`; request validation and capability-gated dispatch
in `server/createRecipe.ts`; the entire shared `server/ai/*` chain; the client
re-validation and wikilink-stripping ingredient parser.

Rework later, during Shiso-4: `CreateForMeModal.tsx` (DOM-id state, fixed
three-phase layout), `createForMeState.ts` (single-draft, single-status model),
`createForMeSession.ts` (one-shot epoch lifecycle that resets on discard), the
fixed six-field constraint form, and the user-facing wording.

Do not put Shiso's name on working systems. Preserve good generation logic.

---

## 5. Basic and Advanced Nutrition as Shiso capabilities

**Basic Nutrition (free):** One-click, fast nutrition essentials using the pinned USDA catalog and existing calculation tools without requiring a paid provider. Show sourced or clearly labeled estimated results, known partial subtotals, and the unknown-nutrient distinction. An optional future SHISO enhancement should not make free Basic wholly dependent on Gemini or paid APIs.

**Advanced Nutrition (premium):** Shiso may infer portions, food identities, preparation and nutrient estimates from the whole recipe, existing data and—when implemented—safe external research. USDA evidence is preferred when applicable, but an incompatible or missing source portion is not a reason to withhold a defensible, labeled estimate. Recorded assumptions and provenance travel through review, Apply, Markdown, and reopening.

Both use application-owned deterministic math and storage contracts to avoid inaccurate multiplication, incorrect raw/cooked equivalence or silent overwrite. AI may generate approximate nutrient figures, but not masquerade as an authoritative USDA value. The user chooses what to review, apply and save.

## 6. Scoped retrieval, context, and mutation model

**Retrieval is scoped.** Shiso receives the minimum context needed for the
question. Derived context is server-owned where an existing derivation owner
exists; a caller cannot inject fake line references, fake food semantics, or
fake neighbouring-ingredient relationships. Model-visible context is bound to
the exact authored recipe it was derived from, so any change to that context
makes the prior interpretation unusable — whole-recipe, fail closed, never a
weaker per-row freshness rule.

**Mutations are user-authorized.** Every mutation goes through an existing
application authority with the user's confirmation where the system already
requires it. Shiso proposes; Kitchen Codex disposes. No free-form direct
Vault/database mutation. No background calls, no calls on modal open or
render — the user always explicitly initiates.

**Provider-neutral.** Shiso targets the existing provider abstraction
(`server/ai/*`) rather than any single vendor, and reuses the existing
credential, model-selection, capability-verification, pricing-guard, and
rate-limiting infrastructure. No second AI brain, no second credential path.

---

## 7. Safety, product truth, and transparency invariants

- Protect existing entitlement, provider readiness, API-key security, pricing consent, bounded calls and appropriate rate limits. A BYOK key alone does not invent product entitlement.
- Shiso **may** suggest and calculate estimated masses and nutrients; each non-source estimate must be labeled and justified rather than authenticated as USDA.
- Reject invented identifiers, false citations and internally inconsistent or incompatible units; avoid false precision. Whole-recipe semantic context and edible-yield assumptions matter.
- Separate supported partial subtotals from complete recipe totals; represent unknown nutrient values as unknown, preserving genuine known zero.
- Re-check freshness before Apply/Save. Maintain the corrected whole-recipe serving denominator and avoid double scaling.
- All Vault writes and nutrition Apply paths stay with trusted application owners and explicit user authorization.
- Recipe text, imported pages and web snippets are untrusted data, not instructions. Safe web research remains a separate capability with bounded fetches and SSRF protections.
- Retain Basic Nutrition's free offline value. Advanced implementation is merged; Sid reported the Cochinita Pibil Analyze/Apply/Save/Reopen flow accepted, while broader recipe coverage and provider compatibility remain unaccepted. Safe web research remains future.

## 8. Phased program

Phase numbers describe capability scope, not release completion. Statuses below
mean implementation on main; the scoped human acceptance Sid has reported, and
remaining acceptance, are recorded in §11 and the linked acceptance record.

**SHISO-0 — Architecture + Capability Inventory** — Inventory exists; this reconciliation updates its status.
Inventory existing AI surfaces; inventory application authorities; identify
duplicate AI flows; define read/propose/mutate boundaries; define reusable
capability contracts. *(This document and the Create-for-me inventory in §4.1
are SHISO-0 seeds.)*

**SHISO-1 — Chat Foundation** — Foundation merged; reliability acceptance pending.
A single Shiso conversation surface; conversation/session model; provider
abstraction; streaming if justified. No broad mutations yet.

**SHISO-2 — Read-Only Kitchen Context** — Partial: current recipe/nutrition reads merged; broader retrieval future.
Current recipe and nutrition review context exist. Explore My Vault grounded
search, collections, meal-plan and shopping-list inspection remain future.
Existing legacy retrieval is reusable evidence, not completed SHISO integration.

**SHISO-3 — Structured Capability Invocation** — Partial: bounded tools and authorized recipe/nutrition actions merged.
Intent maps to a structured application capability. Existing systems remain
authority. No free-form direct file/database mutation.

**SHISO-4 — Create with Shiso** — Creation and refinement merged; Sid reported
live generation, multi-turn refinement, Undo, explicit Save and Reopen accepted
for the tested configuration. Preserve manual New Recipe and explicit Save;
provider/model-wide compatibility is not implied.

**SHISO-5 — User-Authorized Actions** — Partial: recipe editing/save merged; broader kitchen mutations future.
Recipe edits, collections, meal planner, shopping list, and other controlled
mutations, each explicitly user-authorized.

**SHISO-6 — Advanced Nutrition Integration** — Analysis/review integration
merged; Sid reported Cochinita Pibil analysis, Apply, Save and saved-report
Reopen accepted. Source-backed and AI-estimated contributions remain distinct.
Broader recipe coverage and provider/model compatibility still need acceptance.

**SHISO-7 — Broader Kitchen Intelligence** — Future.
Substitutions, leftovers, cooking assistance, timer chains, and future
capabilities.

**SHISO-8 — Vault Intelligence Integration** — Future.
Retain the deterministic dashboard and Vault Health %. Add read-only explanation
before previewable, explicitly authorized single-recipe and then batch repairs.

---

## 9. Reusable intelligence, not a premature platform

Whole-recipe semantic understanding (the Phase 9B work) should live behind a
**clean capability boundary** rather than being inseparable from one Advanced
Nutrition modal button, so Shiso can reuse it across contexts.

What this means in practice: **reusable intelligence yes, premature assistant
platform no.** Reuse the merged conversation, capability and persistence boundaries across
surfaces. Do not build a second assistant engine, credential path or generic
agent platform as part of the remaining integrations.

---

## 10. Relationship to existing Kitchen Codex systems

| System | Relationship to Shiso |
| --- | --- |
| Canonical recipe schema (v1) | Unchanged authority; Shiso proposes into it |
| `markdownParser` / `vaultRecipe` | Deterministic persistence authority; Shiso never writes directly |
| Advanced Nutrition (merged; scoped Cochinita Pibil acceptance reported) | AI-led estimates and user review on top of provenance, calculation and explicit persistence controls; broader coverage acceptance remains |
| USDA pinned bundle + matcher | Preferred source-backed identities and nutrient data; not a prohibition on labeled AI/source-informed estimates |
| Mass / portion / calculation layer | Uses source-backed and openly estimated weights; application validates totals, assumptions and saved state |
| Ask My Kitchen / Ask This Recipe | Keep working legacy pathways until parity; migrate real Vault search and recipe context into Shiso rather than maintaining separate AI assistants |
| Create for Me (one-shot) | Retain validated generator and draft save; conversational Create with Shiso is merged; confirm parity before legacy removal |
| `server/ai/*` provider abstraction | Reused; Shiso adds no second credential or selection path |
| BYOK session keys | Reused where relevant; no new storage model |

---

## 11. Reconciled delivery plan and acceptance gates

1. **Common SHISO reliability acceptance first.** Verify the
   effective AI Settings provider/model across chat, Create with Shiso and
   Nutrition with Shiso; credential expiry/replacement, cancellation, errors and
   tool handoffs must be honest. No separate SHISO key, silent paid fallback or
   hidden model switch. Reuse merged code; do not restart completed implementation.
2. **Broaden nutrition acceptance beyond the reported Cochinita pass.** Keep
   Basic free and offline with the pinned USDA catalog. Advanced Nutrition
   contains Nutrition with Shiso, with **Analyze Recipe** and **Calculate
   Without AI**. Verify representative identity, quantity, wrapper exclusion,
   serving-basis and partial/unknown cases. Preserve provenance and stale-state
   rejection; do not imply all recipes are covered because one end-to-end flow
   passed.
3. **Explore My Vault — future, grounded and read-only.** Scope deterministic
   ingredient/tag/name search with real recipe names, links and counts; scoped
   evidence supports conversational reasoning. Simple search need not call a
   model. Preserve legacy Ask My Kitchen until parity and human acceptance;
   do not claim existing legacy retrieval is already SHISO integration.
4. **Vault Intelligence with Shiso — future integration.** Retain the existing
   dashboard, deterministic scanner, Vault Health %, formatting checks and
   metadata recovery. Explain actual scans first; never invent health scores,
   counts or completed scans. Show unavailable/not scanned honestly. Then add
   exact repair previews, explicit single-recipe authorization and separately
   confirmed batch repairs, with stale-content checks and recovery where
   supported. Rescan after repair and report measured remaining issues.
5. **Cross-feature workflows later.** Grounded search → recipe edits → nutrition;
   health scan → repair preview → confirmation → verified rescan. Broader kitchen
   actions, safe external nutrition research and mascot animation remain future.

Keep one SHISO companion across all contexts. External research is not a verified
capability; do not fabricate citations or imply a web lookup occurred. No roadmap
item authorizes a provider call, Vault write, feature change or deployment.

**Release gates:** Green CI, separate security-backlog triage, remaining scoped
human acceptance and Sid's explicit release approval. The
[acceptance record](./Shiso-Acceptance-Status.md) separates reported passes from
pending coverage and fixed PR findings from the dated open-alert snapshot.
This roadmap reconciliation is proposed in PR #13 and remains subject to review
and merge approval. It does not authorize feature implementation or deployment.

---

## 12. Urgent priority — complete AI Settings model discovery and assess OpenCode Go (October 19, 2026)

**Owner decision:** These are ASAP provider-platform roadmap priorities, requested during the
SHISO H-1 live nutrition acceptance repair. Keep Beam's active H-1 diagnosis isolated:
do not interrupt or silently combine the repair with model-catalog changes. Begin
this work in a separate verified branch/worktree after suitable preflight, and
prioritize it before expanding SHISO with Explore My Vault or mascot animation.

### P0 — OpenRouter: show the complete usable model landscape, especially image models

**Observed user issue:** OpenRouter models are missing from TKC AI Settings,
particularly image-generation options. This is a reported acceptance defect,
not yet a proven single root cause.

**Existing implementation to inspect:**

- \`server/ai/openRouterCatalog.ts\` fetches \`GET /api/v1/models\`, enforces
  a 1,500-model normalization bound, and currently discovers image output from
  that response. OpenRouter's documented model API defaults to **text** output
  unless \`output_modalities\` is specified. Verify actual server responses,
  request parameters, catalog freshness, truncation and UI filtering.
- OpenRouter separately documents **\`GET /api/v1/images/models\`** as its
  authoritative image-generation catalog, with per-model endpoint records at
  \`/api/v1/images/models/{author}/{slug}/endpoints\`.
- TKC already has \`OpenRouterImageProvider\` for fixed \`/api/v1/images\`
  execution; \`imageProviderRegistry.ts\` only treats its small curated model
  set as executable. **Catalog discovery is not proof of compatibility.**
  Never make unknown image models runnable merely because they were listed.

**Required design and acceptance:**

1. Correct and test complete model discovery using the provider's current
   text/multimodal and dedicated image catalogs. Don't silently truncate or
   confuse a filtered subset with "all models"; show truthful totals and any
   documented retrieval limits. Preserve fixed-host, bounded fetch, cache
   freshness and safe-fallback protections.
2. In AI Settings, make **Text/Chat**, **Vision (image input)** and
   **Image Generation (image output)** independently discoverable and searchable,
   with real model IDs, capability labels, availability, pricing/billing basis
   and last-refresh state. Display missing/unverified/unsupported models
   transparently, not as false executable choices.
3. Separate **discovered**, **selected**, **runtime-verified** and
   **executable for this operation**. Only enable actual image generation after
   verifying that model's API endpoint, required parameters, response shape,
   formats, size limits, cancellation, entitlement and user cost consent.
   Inspect per-endpoint resolution, aspect-ratio and reference-input support;
   do not assume identical parameters across models.
4. Keep API credentials server-only. Preserve existing model pinning,
   no-silent-fallback behavior, pricing and rate-limit guards, verified
   provenance, error diagnostics and generated-image byte validation.
5. Cover dynamic model additions/removals, stale catalogs, no-key states,
   large responses, model classification, image-only and mixed-modality output,
   unsupported selections, paid-model confirmation and successful compatible
   image-model execution with focused fixtures/integration tests.

Primary vendor references:
- https://openrouter.ai/docs/api/api-reference/models/get-models
- https://openrouter.ai/docs/api/api-reference/images/list-image-models
- https://openrouter.ai/docs/api/api-reference/images/list-image-model-endpoints

### P1 — OpenCode Go: provider integration feasibility and gated implementation

**Product intent:** Make OpenCode Go a provider option in TKC AI Settings if
its actual API capabilities, provider terms and permitted traffic support TKC.

OpenCode documents a Go API key, \`GET https://opencode.ai/inference/go/v1/models\`
and model-dependent API paths, including \`/chat/completions\`, \`/responses\`,
\`/messages\` and Google-format routes. The available model roster, pricing,
usage limits and endpoint compatibility can change.

**Blocking eligibility check:** The Go documentation explicitly describes Go
as designed for OpenCode and **other coding agents sending typical coding-agent
traffic**, and requests a stable session ID and identifying user agent.
Do **not** assume a Go subscription permits a general-purpose cooking,
recipe-creation or nutrition assistant merely because HTTP endpoints exist.
Confirm permitted non-coding application use with OpenCode before any TKC
SHISO traffic is routed via a Go subscription. If not permitted, document the
alternative (e.g., a separately eligible pay-as-you-go/OpenCode offering),
rather than building an incompatible or policy-evading integration.

If permitted:

1. Register a distinct \`opencode-go\` provider behind the existing
   provider/credential/selection contracts; fixed, server-owned endpoints only.
   No key in the browser, Vault files or logs.
2. Discover genuine accessible models; dispatch through each model's
   documented protocol rather than assuming all are OpenAI chat-completions.
   Verify text, structured-output, tools and any image capability at runtime
   before making a role selectable. Never infer capabilities from model names.
3. Preserve SHISO conversation identity and required session headers, explicit
   user-selected model, cancellation, no silent fallback, bounded outputs,
   provider error classification, pricing safeguards and Go usage/quota feedback.
4. Keep free Basic Nutrition independent of paid/limited AI providers. Preserve
   recipe/USDA validation, authorization, provenance and explicit Apply/Save.
5. Add mocked and authorized live-smoke checks for model discovery, authentication,
   unsupported operations, quota limits, model switching, cancellation,
   no-secret leakage and actual supported SHISO tool/structured workflows.
   No live paid calls before project-owner approval.

Vendor reference: https://dev.opencode.ai/v2/docs/console/go/

**Delivery order:** Finish the isolated H-1 safety/integrity repair; take P0
OpenRouter catalog/image coverage next and P1 OpenCode Go eligibility in parallel,
then build Go only if permitted. Muse Spark 1.3 audits implementation;
the project owner retains sole commit/merge/deployment authority. This
planning entry alone authorizes no provider calls, Vault writes or release.
