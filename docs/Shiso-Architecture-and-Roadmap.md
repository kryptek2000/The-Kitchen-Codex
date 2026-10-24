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

## 12. ASAP — AI Settings Studio redesign, complete OpenRouter models, and native OpenCode Go BYOK (October 19, 2026)

**Owner's revised direction (supersedes the earlier §12 implementation-eligibility wording):**

- **Build OpenCode Go as a native, first-class BYOK provider in The Kitchen Codex.** This is an implementation goal, not a speculative feasibility-only feature. The owner cites a working OpenCode Go integration in an Obsidian Copilot plugin as a precedent worth studying; determine the actual transport and authentication contract, rather than merely concluding "Go is for coding."
- **Redesign the entire AI Settings interface.** Current UI typography is too small and the presentation is too generic. Deliver a distinct, approachable Kitchen Codex experience with readable fonts, strong hierarchy, useful controls, and polished responsive behavior.
- **Fix incomplete OpenRouter model discovery, especially image-generation models.** Discover what is available separately from what the current adapter can safely execute, then expand proven execution support.
- **ASAP means ahead of broader SHISO feature expansion** (Explore My Vault, Vault Intelligence tool expansion, animated mascot). Keep Beam's already-active SHISO H-1 recipe/nutrition repair isolated; do not clobber its workspace or combine unrelated commits.

The implementation streams below can be parallelized safely: UI design and provider research may start immediately in separate branches; integration and source repairs must preserve the current validated main baseline.

### P0-A — Native OpenCode Go integration (required product capability)

**User story:** In TKC AI Settings, I can select **OpenCode Go** alongside existing providers, supply *my own* Go API key or another explicitly supported credential, browse models available to my account, test the connection and deliberately use an eligible model for SHISO chat, recipe creation, nutrition interpretation and supported image capabilities. Unsupported capabilities are clearly marked, not simulated.

**Implementation direction:**

1. Add `opencode-go` to the existing server-owned AI provider registry, catalog, settings selection and credential lifecycle. Use the established provider abstraction; do not build a second SHISO brain. Keep provider endpoints fixed/allowlisted and credentials server-only; never persist a user's secret in Vault Markdown, settings preferences or browser storage.
2. Verify OpenCode Go's current model listing (`GET https://opencode.ai/inference/go/v1/models`) and actual supported credential and protocol paths (potentially Chat Completions, Responses, Messages, and Gemini-style APIs). Implement per-model protocol dispatch where supported, not a universal OpenAI-compatibility guess. Existing Obsidian Copilot behavior is a reference to inspect, not proof that all model operations share one API.
3. Expose honest model selection and readiness: display name/ID, model availability, input/output modalities, verified structured output/tools, per-operation compatibility, costs/credits/limits and credential state. A model that only supports ordinary chat must not claim to support structured nutrition or image generation.
4. End-to-end SHISO operation selection must honor the exact chosen provider/model without silent fallback; keep conversation/session continuity, required identifying headers and session ID where documented, cancellation, typed error reporting, request budgets, rate limits, entitlements, cost consent and explicit Apply/Save boundaries.
5. Give the user an understandable connection test and service-error state. Do not imply that merely connecting an API key authorizes or verifies every model. Maintain free/offline Basic Nutrition independently of Go.
6. Add fixture-driven adapter tests plus focused integration for model discovery, authentication, capability gates, malformed responses, quotas, provider switching, cancellation, no-secret leakage, and successful permitted SHISO operations. An owner-approved live smoke comes later, with a disposable Vault.
7. **Service compatibility is an engineering dependency, not permission to abandon this owner-requested feature.** Read provider documentation, confirm the allowed credential and traffic for this product and document any restriction precisely. BYOK does not itself override upstream service terms. If direct Go subscription traffic is not permitted for a general-purpose recipe app, implement the reusable provider adapter/configuration where technically appropriate, do not secretly circumvent access restrictions or generate unauthorized traffic, and present a specific compliant activation path or unresolved blocker to the owner. Do not silently swap Go for another paid provider.

**Definition of done:** A real OpenCode Go choice appears in AI Settings and can be configured and used for verified, allowed TKC operations; any blocked service entitlement is explicit and truthful. A mocked "connected" message or an empty provider dropdown is not done.

Vendor docs: https://dev.opencode.ai/v2/docs/console/go/

### P0-B — The Kitchen Codex AI Studio: a MAGNIFICENT flagship interface (required)

**Owner's explicit design bar, October 19:** *Magnificent. Not generic. Not tiny.*
This is a major, differentiated product surface, not a font-size patch or a new
coat of paint on `ProviderSettings.tsx`.

**Source-derived implementation inventory:** The current AI Settings lives mainly
in `src/application-ui/ProviderSettings.tsx` (roughly 1,735 lines),
`ModelPicker.tsx`, `SessionKeyPanel.tsx`, `modelPicker.ts`,
`providerCatalog.ts` and the shared application theme tokens. Existing controls
use 10–12px labels and a narrow searchable picker with only
`discoveredModels.slice(0, 100)` informational text entries. Those are real
limitations to address, not a design preference to retain.

#### Art direction and product character

**Working name:** **THE KITCHEN CODEX — AI STUDIO**.
Signature concept: **A beautifully engineered culinary intelligence atelier**.
Combine editorial cookbook typography, the familiar vault/index-card motif,
warm ink/charcoal/paper surfaces, finely crafted herb/SHISO accents and
precision AI-tooling interaction. It should feel like opening the control room
of the user's personal culinary library, **not** a generic SaaS admin panel,
basic form, dashboard-template collage, or cyberpunk neon display.

Three cohesive design territories to explore **before implementation**:

1. **The Codex Atelier (preferred):** high-end editorial and artisan kitchen
   aesthetic, split-pane canvas, elegant titles and typographic contrast, tactile
   paper/ink depth, meticulously spaced provider/model cards and a restrained,
   living SHISO accent.
2. **The Intelligence Workbench:** confident, calm, high-density pro-tool
   organization with scannable cards, strong focus, and contextual model details.
3. **The Living Library:** browse-first model archive with tasteful category
   dividers, favorites and card/list views; lightweight recipe-card visual cues.

Blend the strongest parts into ONE final consistent design after owner review.
Protect visual continuity with current approved TKC UI and all supported themes.
Do not make a separate design language that looks imported from another product.

**Research references, for principles rather than imitation:**

- Linear UI design hierarchy and calm navigation:
  https://linear.app/now/how-we-redesigned-the-linear-ui and
  https://linear.app/now/behind-the-latest-design-refresh
- OpenRouter's searchable, modality-aware, priced catalog:
  https://openrouter.ai/models
- Vercel AI Gateway's capability/price comparison and filterable browsing:
  https://vercel.com/ai-gateway/models
- Vercel's design-token/component fidelity practices:
  https://vercel.com/blog/ai-powered-prototyping-with-design-systems

Borrow **functional patterns**, not branded layouts or artwork.

#### Required information architecture and hero experience

- **Overview / My AI:** a hero treatment with SHISO's current status and selected
  model(s), concise connection/limit summaries, visible "Use for" paths, recent
  model choices and a clean launch into configuration. A functional cockpit,
  not an illustration-only splash.
- **Providers & Credentials:** handsome, spacious connected/disconnected
  provider cards for OpenRouter, OpenCode Go, Gemini, DeepSeek and real providers.
  Enter an approved key once, validate honestly, then refresh that provider's
  actual model catalog. Clearly show server key versus session-only key,
  expiry/revoke capability, and supported operation types.
- **Model Library:** first-class, full-width or roomy split-pane search and browse
  of **the real full list the provider makes available**, including text,
  reasoning, vision, image generation and any discoverable other modalities.
  Let the user search all, filter rapidly, compare, favorite and deliberately
  select a model for a supported task.
- **Image Studio:** beautiful image-model discovery, clear generated-image task
  capabilities (generation vs editing vs vision input), reference-image and
  resolution support, output previews only when truly implemented, and pricing
  by image/megapixel/token as applicable.
- **Advanced / Diagnostics:** collapsed by default, but easily available
  operational information: model/runtime verification, exact safe error class,
  refresh timestamp, missing entitlement, unknown price, policy limits and
  selection/cancellation state.

Desktop: deliberate left navigation rail, substantial content canvas and optional
right-side model detail/comparison inspector. Mobile: responsive stacked layout
with no cropped names or horizontal overflow; preserve fast model search.

#### Typography, accessibility and visual quality

- Default body/control font size **16px**, necessary secondary/meta labels **at
  least 14px**, section headings generally **20–24px**, prominent page titles
  **28–32px** where space allows. Do NOT use 10–12px type for controls,
  model IDs, prices, status, key messages or diagnostics.
- Distinctive type pairing: tasteful editorial display typography for
  hero/headings, highly legible application sans for dense catalogs, monospace
  only for technical identifiers when helpful. Preserve theme/font availability.
- Intentional whitespace, hierarchy, balanced panels, restrained depth,
  excellent dark/light/theme contrast, prominent selected state, 44px+ hit
  targets, keyboard search/navigation, high-visibility focus, useful hover/focus
  details, screen reader announcements, reduced-motion support and robust
  200% zoom behavior.
- Data richness without visual noise: details in the inspector, not 15 tiny badges
  crammed into every row. Costs and critical warnings must remain easy to see.
- Thoughtful loading, empty, stale, key-expired, no-compatible-model and
  provider-error states. Do not show a ghost list of supposedly selectable models.

#### Design delivery gate: owner must SEE it

1. Inspect current live AI Settings, actual component hierarchy, design tokens
   and representative mobile/desktop layouts.
2. Produce **three visually distinct high-fidelity concepts/mockups** based on
   the art directions above (not three recolored generic dashboards).
3. Present clear concept comparisons to the owner; get selection/feedback.
4. Produce a **polished interactive UI prototype** of the chosen concept with
   real-feeling provider lists, model browsing, settings cards, detail inspector,
   key state and mobile behavior, using synthetic example data.
5. **Do not replace the production UI until the owner approves the visual
   direction and prototype.** Then integrate using existing state, adapters,
   catalog contracts and secure credential flows, without unrelated rewrite.
6. Verify visually at 360, 390, 768, 1024 and 1440px, normal and 200% zoom,
   all app themes, keyboard, screen readers and reduced-motion modes.
7. Add behavior regression tests, visual/screenshot reviews and owner hands-on
   acceptance. A passing automated suite alone is not sufficient.

**Definition of done:** The interface looks unmistakably like **The Kitchen
Codex**, feels genuinely premium, is comfortably readable, and makes configuring
hundreds of AI models genuinely easier than competing provider settings UIs.

### P0-C — OpenRouter and OpenCode Go: the FULL LIVE MODEL LIBRARY experience

**Owner's acceptance standard, October 19:** *When I add my OpenRouter or
OpenCode Go key in Hermes or Obsidian Copilot, I see a huge list of models.
I want the same kind of list inside The Kitchen Codex.*

**Non-negotiable UX outcome:** Connect a key → discover the currently available
provider model catalog → browse/search **all available returned models** with
modality and capability filters → choose an eligible model for the desired
SHISO/image operation. No artificial "only a few curated models" browsing
experience and **no silently clipped list**. Never claim to list *every* model
if the provider API supplied an incomplete or truncated result.

#### Provider discovery contracts

- **OpenRouter:** Investigate why TKC's current
  `server/ai/openRouterCatalog.ts` fetches `GET /api/v1/models` without
  `output_modalities=all` even though the documented default is text output.
  Use the dedicated `GET /api/v1/images/models` and real model/endpoint metadata
  for image generators. Audit the existing 1,500-entry normalization cap,
  filtering/deduplication, catalog cache, and display-only `slice(0, 100)`.
  A static model allowlist must no longer determine which models users can
  **see**. Investigate current availability/price before allowing paid usage.
- **OpenCode Go:** On connect, fetch the full account-accessible inventory from
  the documented `https://opencode.ai/inference/go/v1/models`. Do not
  hard-code the current published lineup as the UI's only options. Refresh
  when requested and on credential changes. Supported model API protocols
  differ: OpenAI Responses, Chat Completions, Anthropic Messages, and
  Google-style paths; map each model's actual supported operations.
  Don't promise hundreds of Go models if the Go account actually offers fewer.
- **Other providers:** Keep the model-library components reusable rather than
  special-casing a two-model Gemini or DeepSeek dropdown as the design ceiling.

#### Product-level model browser requirements

1. **All Models view selected by default**, with visible total counts,
   filtering by provider, text/chat, reasoning, image input/vision, image
   generation, video/audio where available, model family, available/free/paid,
   verified/unknown, price, context and supported tool/structured operation.
   Sorting: name, newest, context length, estimated cost and favorites.
2. **Search by display name AND exact model ID**, with rapid local filtering,
   keyboard navigation and optional favorites/recent choices saved as
   non-secret preferences. Include a persistent selected model and operation
   indication. Easily compare 2–3 models side by side when their comparable
   metadata exists.
3. **Every returned catalog model is discoverable**; when provider metadata
   cannot establish operability, the row remains visible with a specific
   reason and a contextual "Verify for Kitchen Codex" action when supported.
   Don't default the entire library to a tiny *verified-free* selection.
   Verification may safely expand usable models, but not fabricate
   structured output, tool calling, image support, price or free status.
4. **No arbitrary UI truncation:** avoid fixed first-100 selectors, hard cap
   presentation and disconnected "catalog results not shown" states. Implement
   virtual scrolling/windowing, bounded query processing and incremental
   hydration or provider-supported pagination as applicable. Keep genuine
   memory/network safety limits, but surface truncation/errors explicitly and
   allow complete retrieval through bounded pages or a well-defined alternate
   API strategy; no unchecked unbounded memory allocation.
5. **Selection must mean something:** "Use for SHISO Chat", "Use for Recipe
   Creation", "Use for Nutrition", and "Use for Images" actions as appropriate.
   Validate each operation's capabilities and any needed runtime profiles;
   preserve entitlements, signed/validated semantic authority and safe
   persistence. If unsupported, explain what is missing, rather than silently
   routing to another model or falsely reporting success.
6. **Cost and privacy truth:** clear free/paid classification only with current
   trusted pricing; token/image/megapixel billing basis; safe estimated cost
   when derivable, warnings before paid test/generation, stale-price notices,
   and no surprises from hidden fallback. Never send secrets to the browser
   or persist keys in Vault content.
7. **Smart empty/offline/credentials/expiry states** and a manual Refresh
   button with timestamps and honest source ("live", "cached" or "unavailable").
   Model list reflects provider additions and removals without shipping a new
   TKC release whenever the catalog changes.
8. **Images are first-class:** a text-output multimodal model and an
   image-output generative model are different operations. Don't hide image
   generators by applying a text-only filter or claim the current
   `/images` adapter supports every discovered generator. Add verified
   endpoint profiles/resolution/reference inputs as actual models become
   executable. Keep image size/MIME validation and bounded transport.
9. **Performance and test plan:** fixtures with 10, 100, 1,500 and >1,500
   models, mixed modalities, duplicate/changed IDs, stale price, different
   Go API protocol families, no key, invalid key, timeout, cancellation,
   provider outage, invalid output and unsupported generation calls. Test
   fast search, accessible scrolling, explicit selection and no duplicate
   auto-requests when a panel opens.

**Definition of done:** OpenRouter and OpenCode Go feel like a true model
marketplace inside TKC. The owner sees the large, fresh model selection expected
from Hermes/Obsidian Copilot, can actually select and use compatible models
across supported TKC tasks, and gets truthful reasons for incompatible ones.
This is NOT fulfilled by merely exposing 500 non-clickable names.

Provider references:
- https://openrouter.ai/docs/api/api-reference/models/get-models
- https://openrouter.ai/docs/api/api-reference/images/list-image-models
- https://openrouter.ai/models
- https://dev.opencode.ai/v2/docs/console/go/

### Sequencing, authorization and completion

- **Immediately:** Complete Beam's isolated SHISO H-1 nutrition safety/integrity repair; AI Settings visual discovery/design and provider transport assessment may proceed in parallel without touching Beam's branch.
- **ASAP next:** Deliver the OpenRouter catalog repair, approved AI Settings Studio redesign and native OpenCode Go provider through appropriately scoped implementation changes. Owners may choose split release branches if that keeps testing and rollback simple.
- **Independent audit:** Muse Spark 1.3. GPT-6 coordinates architecture. Owner alone authorizes commit/push, merges, paid live calls, Vault mutations and deployment in the established TKC protocol.
- **Acceptance:** Focused regressions, security/provider tests, TypeScript, application and plugin builds, relevant browser checks, green GitHub CI and owner hands-on review. Do not change the app's working nutrition calculation or selection authority as collateral damage.

This is a roadmap commitment and design/implementation brief, not a completed integration, authorization for provider usage, or deployment.
