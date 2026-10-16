# Shiso — Architecture and Roadmap

**Status:** Historical forward-looking architecture with an **October 16, 2026 AI-first nutrition decision** below. This is not a live-release specification.
**Implementation note:** The original SHISO-0 inventory is historical. Local uncommitted SHISO H-2 and nutrition implementation work exists; the published v0.9.0 release does not include those changes. This draft documentation change does not touch, merge, or validate Luna's in-progress implementation.

- Decision owner: Sid (sole release authority)
- Document scope: product direction and phased program
- Relationship to Advanced Nutrition: see §10 and
  [`Advanced-Nutrition-Architecture.md`](./Advanced-Nutrition-Architecture.md)

---

## 1. One AI companion: Shiso

The Kitchen Codex will have **ONE** AI companion, named **Shiso**.

Shiso is the conversational AI intelligence surface for the product. Shiso
understands intent, reasons over the user's kitchen, explains results, and
proposes changes. It is an **orchestrator**, not an authority.

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
| meal planner → Shiso | current meal-plan context |
| Ask My Kitchen | vault retrieval context |

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
- `Shiso is thinking…`

---

## 3. Shiso leads nutrition interpretation; Kitchen Codex protects state

**Decision update — October 16, 2026:** Shiso is the AI-led interpretation and estimation capability across Basic and Advanced Nutrition. The USDA catalog, local parser, conventional portion data, and deterministic calculator are tools and evidence; missing an exact USDA household portion is not an automatic prohibition on a useful, clearly marked estimate.

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
capability but takes a new future product identity, **`Create with Shiso`**.

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

### 4.1 Current Create-for-me implementation inventory (recon only)

No behavior change was made. This records what exists today so the migration
preserves what is sound.

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
only ever produced afterwards by deterministic Advanced Nutrition.

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
- Retain Basic Nutrition's free offline value. Paid Advanced and web-research capabilities may be described as planned until actually shipped and browser-verified.

## 8. Phased program

Numbering may be refined later; the architecture direction is what matters.

**SHISO-0 — Architecture + Capability Inventory**
Inventory existing AI surfaces; inventory application authorities; identify
duplicate AI flows; define read/propose/mutate boundaries; define reusable
capability contracts. *(This document and the Create-for-me inventory in §4.1
are SHISO-0 seeds.)*

**SHISO-1 — Chat Foundation**
A single Shiso conversation surface; conversation/session model; provider
abstraction; streaming if justified. No broad mutations yet.

**SHISO-2 — Read-Only Kitchen Context**
Recipe context, Vault search, collections lookup, nutrition report lookup,
meal-plan inspection, shopping-list inspection. Read-only.

**SHISO-3 — Structured Capability Invocation**
Intent maps to a structured application capability. Existing systems remain
authority. No free-form direct file/database mutation.

**SHISO-4 — Create with Shiso**
Migrate the current AI recipe generation into Shiso; conversational recipe
refinement; reuse current generation capability where sound; validated save
through the existing recipe persistence authority.

**SHISO-5 — User-Authorized Actions**
Recipe edits, collections, meal planner, shopping list, and other controlled
mutations, each explicitly user-authorized.

**SHISO-6 — Advanced Nutrition Integration**
Shiso invokes completed Advanced Nutrition; explanations and what-if requests;
deterministic recalculation remains authoritative.

**SHISO-7 — Broader Kitchen Intelligence**
Substitutions, leftovers, cooking assistance, timer chains, and future
capabilities.

---

## 9. Reusable intelligence, not a premature platform

Whole-recipe semantic understanding (the Phase 9B work) should live behind a
**clean capability boundary** rather than being inseparable from one Advanced
Nutrition modal button, so a future Shiso can reuse it.

What this means in practice: **reusable intelligence yes, premature assistant
platform no.** Build the capability so it can be invoked from more than one
surface later — but do not build a generic agent framework, a Shiso UI, a
conversation engine, a tool registry, or a persistence layer before the program
above authorizes it.

---

## 10. Relationship to existing Kitchen Codex systems

| System | Relationship to Shiso |
| --- | --- |
| Canonical recipe schema (v1) | Unchanged authority; Shiso proposes into it |
| `markdownParser` / `vaultRecipe` | Deterministic persistence authority; Shiso never writes directly |
| Advanced Nutrition (unreleased development direction) | AI-led estimates and user review on top of provenance, calculation and explicit persistence controls |
| USDA pinned bundle + matcher | Preferred source-backed identities and nutrient data; not a prohibition on labeled AI/source-informed estimates |
| Mass / portion / calculation layer | Uses source-backed and openly estimated weights; application validates totals, assumptions and saved state |
| Ask My Kitchen / Ask This Recipe | Shipped capabilities, **retired from the forward roadmap**. Left in code unchanged; not future Shiso entry points |
| Create for Me (one-shot) | Capability retained; becomes `Create with Shiso` at SHISO-4 |
| `server/ai/*` provider abstraction | Reused; Shiso adds no second credential or selection path |
| BYOK session keys | Reused where relevant; no new storage model |

---

## October 16, 2026 — AI-first nutrition decision and integration guard

Sid approved a pivot: **Shiso should return useful nutrition when a defensible estimate is possible**, rather than refusing entire calculations when exact USDA portions or records are missing. Existing USDA, deterministic arithmetic, matching, local Basic, and schema-4 estimated-quantity work should be reused—not thrown away. Trustworthy web research is an intended future tool, **not an existing verified feature**.

Concrete browser-test cases driving this decision: Huevos Rancheros tortillas with missing count portions; Cochinita Pibil volume-vs-fruit-yield and pork-form identity; banana-leaf wrappers; separated eggs; unsalted butter; guacamole's unknown energy on the chosen Roma tomato record; Basic's partial totals and explicit save. The local consolidated repair reported labeled partial totals, explicit partial saving with acknowledgement and sample coverage improvements, but this is **not proof of a production release**. Final acceptance is Sid's real browser testing, including explicit Save/Apply and reopening in a disposable Vault.

**Merge warning:** This doc-only branch starts at GitHub `main`. Luna's local app changes and protected Phase 9A work are not included. Do not merge/cherry-pick this branch into the active worktree until its updated local roadmap and uncommitted changes have been reviewed for conflicts. No app runtime or deployment changes are authorized by this decision record.
