# SINC-3 — SHISO Autonomous Nutrition Completion

**Status:** implemented in the SINC-2 worktree; self-verified with deterministic
tests. No commit, push, merge, installation, deployment, or release.

## What the owner can say

```
Shiso, resolve the last two ingredients.
Finish the nutrition.
Estimate whatever is missing.
Find nutrition for these unresolved foods.
Complete my recipe's nutrition.
Figure out the missing ingredient amounts.
Okay, use an estimate for the remaining ingredient.
```

These are action requests, not questions. SHISO runs a bounded completion pass
over the **current** Advanced Nutrition review.

## One new capability: `complete_nutrition`

`complete_nutrition` is the only new SHISO tool. It is owner-delegated: it
prepares contributions in the UNSAVED working review through the application
ports. It does not apply a saved block, save the recipe, or write to the Vault.

### Source order

1. **Existing deterministic USDA analysis** — the same adaptation, matcher,
   portion authority, calculator, and preview the Calculate button runs.
2. **USDA Branded manufacturer evidence** — the SINC-2 lookup transport. Only a
   candidate that is:
   - `usable`;
   - `match_quality === 'strong'`;
   - carrying a server-issued `evidence_id`;
   - safely scalable for the authored quantity and unit

   is proposed. A representative product is labelled as representative in its
   assumptions. A weak, possible, unhandleable, or non-server-backed candidate is
   skipped.
3. **Bounded external nutrition research** — the existing AN-WEB-1 operation.
   Only identity-unresolved (`needs_match`) lines that the Advanced Nutrition
   owner marks research-eligible are requested. The server retrieves the actual
   pages, extracts only published values and a usable basis, and the existing
   validator binds the result to the exact recipe lines.
4. **Validated AI estimates** — the existing structured whole-recipe estimator
   for every line that remains. Estimates are labelled `ai_estimate`, retain
   assumptions and unknown nutrients, and never replace deterministic USDA
   matches or branded/researched source evidence.

The final contribution set is accepted in **one** cumulative update so earlier
verified work is preserved. Branded and researched evidence outrank an AI
estimate on the same line. The existing combiner keeps source-resolved lines
source-resolved.

### Nutrient-gap finishing pass

When all ingredient lines are already accounted for but an existing
`ai_estimate` contribution still has unknown nutrients, `complete_nutrition`
runs a bounded finishing pass instead of returning “everything is already
complete”:

1. It identifies only AI-estimated lines with declared unknown nutrients. It
   never edits source-backed USDA contributions.
2. It first attempts the existing bounded external-research operation. A
   source-backed research contribution is used only when it covers every
   nutrient the existing AI estimate already knows; otherwise the AI estimate is
   preserved.
3. It asks the existing structured AI nutrition operation for a focused
   `nutrient_gap_focus` (the exact line refs and missing nutrient IDs). The
   server prompt emphasizes only those gaps; the response uses the same schema
   and validator.
4. Only previously unknown nutrients are merged into the existing AI
   contributions. Known values, weight, quantity basis, and provenance are
   never overwritten. Filled values remain AI estimates, never verified source
   records.
5. The existing Advanced Nutrition applier recalculates the preview. Apply and
   Save remain explicit and separate.

The response distinguishes:

- **ingredient coverage** (lines accounted for, e.g. 18/18);
- **nutrient coverage** (which lines still have unknown nutrients);
- **verified source-backed values** (USDA / branded / research);
- **AI estimates** (including gap-filled values).

Earlier branded/research failure notes are no longer repeated as “ingredient
remains unresolved” after a validated AI estimate resolves that line. The note
instead identifies the source failure and states that the line was completed by
a validated AI estimate.

### Whole-recipe nutrient coverage

`complete_nutrition` does not stop at AI-estimated lines. Advanced Nutrition now
publishes a read-only projection of the EXISTING calculated preview:

- each of the 34 nutrients' existing total, coverage counts, and status;
- source-backed lines that do not contribute the nutrient, derived from the
  preview's `contributing_nutrients`;
- AI-estimated lines that explicitly declare the nutrient unknown;
- the explicit AI contribution amount and a derived source subtotal
  (existing total minus AI amounts; a display subtotal, not a second calculator).

The SHISO response therefore distinguishes:

- ingredient coverage (18/18);
- known source-backed versus AI-estimated nutrient coverage;
- remaining genuinely unknown values, including aggregate **niacin** and
  **added sugars** gaps on USDA-backed lines;
- whether additional completion is possible.

AI gap filling remains limited to existing `ai_estimate` contributions. A
source-backed USDA line is never overwritten with AI values, and the current
per-line provenance model does not permit adding nutrient-level AI estimates to
a verified line without relabeling them. Those source-backed gaps remain
unknown and are reported as requiring verified source data or manual review.

### Bounds

- At most 4 branded lookups per completion pass.
- At most 3 external-research targets per request (the existing server limit).
- One AI-estimate pass per completion call.
- No automatic retry, no provider fallback, no background work.
- The normal per-turn tool and model budgets still apply.

If more lines remain than the bounded branded batch can search, the AI estimate
step covers the remaining gap honestly. A later completion request can search
again because the review now holds the prior contributions.

## Authority and safety

- The tool runs only through application ports owned by the live review:
  `runAnalysis`, `searchBrandedFoods`, `researchNutrition`,
  `acceptNutritionContributions`, and `runAiNutrition`.
- `nutritionMatchesActiveRecipe` is checked before any work. The recipe identity,
  line refs, and authored text are snapshotted; any change during a lookup or
  provider request produces `stale_recipe` before acceptance.
- No generic USDA match is overwritten.
- Branded proposals are **not** trusted at this stage. They carry no server
  verification. The SINC-2 Apply boundary still recomputes the source snapshot,
  signs the exact contribution, and verifies the recipe/review/target context.
  A forged proposal cannot become authenticated `usda_branded` provenance.
- No Apply or Save capability is called. Apply remains explicit; Save remains a
  separate explicit action.
- Basic users have no Advanced review and no paid completion path. The existing
  server entitlement, authentication, rate-limit, and pricing gates remain in
  force.
- The model can request `complete_nutrition` only inside a bounded conversation
  turn. Opening the app, changing workspace, or deterministic Generate never
  starts it.

## Owner fixture results

The controlled fixture is **Gochujang Chicken Rice Bowls**, 4 servings, 18 lines,
16 generic USDA-backed and 2 unresolved:

- `2 tbsp gochujang (Korean chili paste)`
- `1 tbsp rice vinegar`

Deterministic tests prove:

| Scenario | Result |
|---|---|
| Strong branded evidence for both | 16 generic USDA + 2 USDA Branded; 18/18 lines accounted; AI not called |
| Branded unavailable, one research source + one AI estimate | 16 generic + 1 external research + 1 AI; 18/18 accounted |
| Branded and research unavailable | 16 generic + 2 AI estimates; 18/18 accounted |
| Provider failure after one branded line | 1 branded line preserved, 1 remaining; continuation with an estimate resolves it |
| Non-strong or missing-evidence branded candidate | Not auto-selected; research/AI fallback |
| Basic/no Advanced review | `no_nutrition_review`; zero source/provider calls |
| Recipe changes during lookup | `stale_recipe`; zero contributions accepted |

`partial_known` remains visible. In the synthetic branded fixture both branded
products lack some scoped nutrients, so the review is **18/18 lines accounted**
but **partial nutrient truth**, not a false "complete nutrition" claim.

All source evidence in these tests is synthetic and clearly labelled. No live
USDA or provider success is claimed.

## Conversational and provider behaviour

- Explicit completion phrases route deterministically to `complete_nutrition`
  with zero chat-provider calls.
- The model can also request `complete_nutrition`; the same application tool
  executes.
- A branded or researched contribution is retained even when the AI provider
  later fails.
- Cancellation and stale-recipe checks are enforced after each awaited step.
- Conversation history and findings are not erased by a provider failure.
- A continuation such as "Okay, use an estimate for the remaining ingredient."
  runs the same pipeline over the still-unresolved lines.

## Tests

Focused SINC-3 group:

- `tests/unit/shisoNutritionCompletion.test.ts` — owner fixture, all four source
  stages, branded selection rules, provenance, partial coverage, provider
  failure/continuation, Basic rejection, stale recipe, model tool path,
  deterministic phrase recognition, zero Apply/Save authority, repeated
  “Resolve the last two ingredients” → “Complete nutrition” nutrient-gap filling,
  whole-recipe source-gap reporting (including niacin and added sugars),
  no-new-value behavior, and source-backed research upgrade preservation.
- `tests/unit/shisoNutrientCoverage.test.ts` — read-only projection of the
  existing preview's 34-nutrient coverage, source/AI gaps, and unknown totals.
- `tests/unit/shisoEstimatedNutrition.test.ts` — existing estimate routing and
  coverage semantics, updated for the completion route.
- `tests/unit/shisoBrandedEvidence.test.ts`, `tests/security/shiso*` — SHISO
  vocabulary, conversation, prompt, cancellation, and boundaries.

The SINC-2R2 branded/auth/Phase-5 regression suite is re-run separately so the
two implementations remain distinguishable.

## Safe preview

```
KITCHEN_CODEX_NUTRITION_PRODUCT_TIER=ai_advanced PORT=3050 HOST=127.0.0.1 \
  node dist/server.cjs
```

With no provider or USDA key, the page loads normally and no completion request
runs automatically. A completion request reports what is unavailable rather than
inventing evidence.

## Remaining limitations

- No live USDA Branded or live AI/web-research acceptance was performed in this
  environment (no `USDA_FDC_API_KEY`, no provider key).
- Branded auto-selection is intentionally limited to strong, usable,
  server-handled candidates. A possible candidate is left for explicit review or
  the research/AI fallback.
- External research depends on a web-search-capable selected provider. If none is
  available, the AI estimate fallback remains.
- Branded source evidence still expires after one hour / server restart. Apply
  then requires a fresh lookup.
- AI estimates remain estimates with assumptions and unknown nutrients; they are
  never authenticated source records.
- Advanced Nutrition must be open for the recipe so SHISO can use the live
  review. SHISO does not silently open or initialize it.
