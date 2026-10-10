# Shiso — Architecture and Roadmap

**Status:** FORWARD-LOOKING PRODUCT / ARCHITECTURE DOCUMENT.
**Not an implementation record.** No Shiso code exists. This document records a
product decision and the planned program so that future work lands in one
architecture instead of several competing ones.

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

## 3. Shiso is an orchestrator; Kitchen Codex owns authority

```
User
  |
  v
Shiso conversation
  |
  +--> recipe creation
  +--> recipe search
  +--> recipe editing
  +--> Advanced Nutrition
  +--> substitutions
  +--> collections
  +--> meal planning
  +--> shopping lists
  +--> cooking assistance
  +--> timer chains
  +--> future Kitchen Codex capabilities
```

**Shiso interprets intent. Existing and future Kitchen Codex systems perform
authoritative operations.**

Shiso MAY:

- propose a recipe title, ingredients, amounts, and instructions
- reason conversationally about desired changes
- revise its own prior proposal
- explain and summarize deterministic results
- ask a clarifying question

Shiso MUST NOT:

- write to the Vault or filesystem directly
- assert nutrition values, grams, or nutrient figures as fact
- select an FDC id or any database identity
- bypass existing validation, entitlement, or Apply authority

Mutation path:

```
Shiso reasoning
  -> structured recipe proposal
  -> recipe validation
  -> user confirmation where appropriate
  -> existing recipe persistence authority
```

---

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

## 5. Advanced Nutrition as a Shiso capability

A Shiso-created recipe does **not** receive invented nutrition values.

```
User: "Make it serve six and tell me the calories."
Shiso    : understands the request.
Scaling  : Kitchen Codex serving logic performs the scaling.
Nutrition: Advanced Nutrition performs deterministic calculation.
Shiso    : presents and explains the result.
```

Advanced Nutrition remains a **reusable authoritative capability** that Shiso
may invoke. AI semantic reasoning never replaces USDA identity, mass
authority, nutrient calculation, or Apply authorization. Shiso may ask
explanatory and what-if questions over Advanced Nutrition results; the
deterministic system recomputes and remains authoritative.

---

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

## 7. Entailment and safety invariants carried forward

These must hold for every Shiso capability:

- Product entitlement is required for AI features, and entitlement alone never
  creates fake capability: **entitled AND operationally ready**, never OR. A
  BYOK key by itself grants no product entitlement.
- AI output is never database, nutrition, mass, or persistence authority.
- AI may not select an FDC id, grams, density, or nutrient values.
- AI confidence never overrides deterministic ambiguity; genuine ambiguity
  stays a user review.
- Zero-fabrication, canonical schema, and Apply revalidation invariants are
  unchanged.
- Recipe text and instructions are untrusted **data**. A model may reason about
  cooking instructions but must never obey instructions embedded in recipe
  content.

---

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
| Advanced Nutrition (v0.9.0) | Authoritative capability; Shiso explains and requests |
| USDA pinned bundle + matcher | Sole food-identity authority |
| Mass / portion / calculation authority | Deterministic; never AI |
| Ask My Kitchen / Ask This Recipe | Shipped capabilities, **retired from the forward roadmap**. Left in code unchanged; not future Shiso entry points |
| Create for Me (one-shot) | Capability retained; becomes `Create with Shiso` at SHISO-4 |
| `server/ai/*` provider abstraction | Reused; Shiso adds no second credential or selection path |
| BYOK session keys | Reused where relevant; no new storage model |