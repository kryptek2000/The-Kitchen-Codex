# SINC-4 — Separately Attributed Supplemental Nutrients

Status: IMPLEMENTED in the isolated `tkc-sinc2-85b83dc` worktree. No commit,
push, merge, install, deployment, release, or signing.

## Problem

A verified USDA record can omit nutrients the recipe actually contains. SINC-3's
whole-recipe projection correctly reported those as source-backed gaps (for the
owner fixture: 131 gaps across 22 nutrients), but the per-line
`AiNutrientContribution` model only represents a whole-line contribution for an
UNRESOLVED line. Using it to fill a gap on a resolved USDA line would replace the
verified line or mislabel the AI value as USDA provenance.

SINC-4 adds the smallest separate model that fills only the missing nutrient
while leaving every verified value, explicit zero, weight, source identity, and
source release untouched.

## Model

`src/core/nutritionV2/aiContribution.ts`

```ts
interface AiNutrientSupplement {
  supplement_version: 'ai_nutrient_supplement_v1';
  line_ref: string;
  ingredient: string;
  nutrient_id: NutrientId;
  amount: number;
  unit: CanonicalUnit;                 // must equal the nutrient registry unit
  classification: 'ai_estimate';
  source_kind: 'ai_supplement';        // never 'usda_fdc' / 'usda_branded'
  source_food_id: string;
  source_release: string;
  weight_grams?: number;
  quantity_basis: string;
  assumptions: string[];
  confidence: 'low' | 'medium' | 'high';
  recipe_digest: string;
  review_identity: string;
}
```

`validateAiNutrientSupplements(raw, binding)` rejects:

- unknown line refs, line-text mismatch, invalid nutrient/unit/amount;
- a nutrient the verified source already contributes (including an explicit
  zero), via `source_already_has_nutrient`;
- duplicate `line_ref + nutrient_id`;
- source-food-id / source-release mismatch;
- a weight basis different from the verified resolved grams;
- a stale recipe digest, a stale review identity when the binding supplies one;
- any classification that claims source-backed/USDA authority;
- empty assumptions, invalid confidence, or an invalid supplement version.

`sumNutrientSupplements` sums per nutrient and counts each supplemented line
once. `combineAiContributionsWithPreview(preview, contributions, supplements)`
adds only supplements that bind to a calculated source line and whose nutrient is
absent from that line's `contributing_nutrients`. It never lets a supplement
replace a source total. When a nutrient has no source total at all, the combined
preview derives its measurable denominator from the calculated source lines plus
selected AI lines plus unresolved lines (no double counting).

## Schema v6

`src/core/nutritionV2/schema.ts` / `validate.ts` / `phase5/authorize.ts`

Schema **v6** is the minimal extension of v5:

- `ai_contributions?` — optional, non-empty when present;
- `nutrient_supplements?` — optional, non-empty when present;
- at least one of the two must be present;
- supplements must declare `sources: ['usda_fdc', 'ai_estimate']` (or otherwise
  include `ai_estimate`) so a supplemental block can never present itself as
  pure USDA provenance;
- every supplement must bind to a resolved persisted source-evidence line with
  matching `source_food_id`, `source_release`, and (when present) weight;
- v5 (and v1–v4) blocks remain valid and are never rewritten;
- schema 7+ remains bounded opaque data.

A v6 block is written **only** when supplements exist. An unchanged v5 workflow
continues to produce the identical v5 contract.

## SHISO completion

`src/application/shisoTools.ts`, `src/core/shiso/nutritionCoverage.ts`

`complete_nutrition` now:

1. inspects the whole published nutrient projection (not only unresolved lines);
2. triggers the bounded gap pass when either AI-estimated line gaps or
   source-backed nutrient gaps exist;
3. builds one priority-ordered bounded focus (added sugars, niacin, fiber, fats,
   cholesterol, vitamins/minerals first; at most 160 line/nutrient pairs);
4. sends that focus through the existing `runAiNutrition` operation
   (`apply: false`), with the existing provider authentication, schema, and
   validator unchanged;
5. proposes a supplement per defensible value, bound to the current
   `recipe_digest` and `review_identity`, the verified source line, source
   release, and resolved weight;
6. rejects the whole proposal set if the supplement validator finds a conflict,
   duplicate, stale recipe/review, wrong unit, or wrong weight;
7. merges supplements into the UNSAVED review through
   `acceptNutritionContributions(contributions, supplements)` and recalculates
   through the existing calculator/combiner;
8. reports supplemented values, remaining source gaps, remaining AI gaps, and
   unknown/impossible values separately.

Verified USDA contributions and accepted AI line contributions are passed through
unchanged. No supplement is ever written into `ingredients`, no USDA field is
mutated, and no unknown value is encoded as zero.

## Apply / Save / reopen

- The working review stores supplements separately
  (`Phase4State.aiNutrition.supplements`).
- Apply re-derives authority through the existing Phase 4 session, validates
  every supplement against the genuine source-backed preview, and only then
  builds the v6 block. A conflict, duplicate, stale digest, wrong line, wrong
  weight, or wrong unit fails closed before any write.
- SINC-2R4 ECDSA branded authentication, the build-time trust anchor, per-Apply
  authorization, review/recipe binding, entitlement, and Apply/Save separation
  are unchanged. Supplements never participate in branded authentication.
- Save remains the existing explicit Vault write. Reopen validates and restores
  v6 supplements through `hydrateWorkingReview`.
- The saved report shows a separate **Supplemental AI estimates** section with
  the nutrient, amount/unit, ingredient, confidence, source FDC id, quantity
  basis, and assumptions. The Advanced Nutrition table marks affected nutrients
  **incl. AI supplement**; partial/unknown nutrients retain their existing
  labels.

## Tests

- `tests/unit/aiNutrientSupplements.test.ts` — model validation (source
  conflict, explicit zero, duplicate, stale recipe/review, wrong line, weight,
  unit, amount, source identity, misclassification), summation, merge, and no
  double counting.
- `tests/unit/shisoNutrientSupplements.test.ts` — SHISO source-gap completion,
  binding, verified preservation, provider failure, weight rejection, stale
  recipe, existing-supplement preservation, Basic rejection, no Apply/Save.
- `tests/unit/advancedNutritionSchemaV6.test.ts` — v6 codec/validation,
  supplement-only blocks, both-evidence blocks, provenance source, source
  binding, old v5 compatibility, future-schema opacity.
- `tests/unit/advancedNutritionPhase5Apply.test.ts` — Apply/Save/reopen v6
  provenance, verified USDA preservation, per-serving scaling, v5 output
  compatibility, and fail-closed conflict/stale/weight/duplicate cases.
- `tests/unit/shisoNutritionCompletion.test.ts` and
  `tests/unit/shisoNutrientCoverage.test.ts` — updated coverage/report
  expectations.

## SINC-4R1 — persistence integrity repair

Schema-v6 blocks now persist the authoritative per-line source nutrient
coverage (`ingredients[].source_nutrients`) and the authoritative source-only
subtotal per nutrient (`source_amounts`), both copied from the genuine
Apply-time source preview.

Decode and hydration rebuild the supplement source binding from
`source_nutrients`, so the same `source_already_has_nutrient` rule that Apply
enforces also rejects a saved block that claims both verified USDA calories and
an AI calorie supplement for the same line. A supplement whose source line has
no persisted coverage is unverifiable and fails closed; the ambiguous block is
not presented as a valid result.

Additional consistency checks reject a source-coverage list that:
- is missing for a resolved source line;
- contains a nutrient outside the declared scope;
- has no matching `source_amounts` entry, or has a source amount without
  per-line coverage;
- disagrees with the block's nutrient coverage counts, measurable-line count,
  or source-plus-AI-plus-supplement amount.

The source metadata is produced only from the Apply-time preview, not from
client input. No new schema version was introduced; v5 and older blocks are
unchanged. A v6 block with supplements but without trustworthy coverage is
treated as ambiguous and rejected rather than repaired with invented data.

## SINC-4R2 — saved supplement reverification

Persisted `source_nutrients` / `source_amounts` and serialized totals are
recovery metadata, not authoritative proof. Pure schema decoding validates the
shape and internal consistency of a saved v6 block; it does not activate its
supplemental claims.

Trusted activation happens on hydration/reopen through the genuine pinned USDA
session:

- the source-backed preview is re-derived with the session calculator;
- every persisted supplement is checked against that preview's
  `contributing_nutrients`, source identity, bundle release, and resolved
  weight;
- conflicts, mismatches, duplicates, and unavailable evidence are quarantined;
- only verified supplements enter `aiNutrition`, so they cannot contribute to
  the active calculation.

If trusted source evidence is unavailable (no session/catalog, or calculation
failure), all supplements remain preserved in the saved block but are
quarantined and shown as verification-needed. Pure presentation withholds
supplement-inclusive compact totals from authoritative nutrition surfaces and
displays a verification-needed banner; the saved report remains available for
review and recovery.

A coordinated rewrite of coverage metadata, source amounts, and aggregate
totals can still make a structurally coherent saved block, but it cannot make
the supplement active without genuine source evidence. No cryptographic
immutability of user-editable Markdown is claimed.

## Verification note

The final full-suite run completed with **9882/9886 tests passing**. The four
failures were default-5 s test timeouts under full-suite load (three in
`shisoH1fRepairs`, one in `advancedNutritionRealWorldIngredients`); all four pass
standalone, and `shisoH1fRepairs` passes under load with an explicit 20 s test
timeout. TypeScript, the production build, the focused SINC-4 group, the UI
sweep, and the USDA/Phase isolation tests are clean.

## Non-goals

- No parallel calculator or second nutrient projection.
- No automatic Apply or Save.
- No weakening of SSRF, WAF, rate limiting, AI key containment, canonical schema,
  zero-fabrication, SINC-2R4 authentication, or the Apply/Save boundary.
- Unsupported nutrients stay unknown; they are never fabricated or zero-filled.
