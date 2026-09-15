# The Kitchen Codex — Advanced Nutrition Architecture

Status: **Phase 0 implemented (schema/contract only)**. No dataset, network
route, ingredient matching, calculation engine, UI, Apply action, or automatic
persistence exists yet. Machine application of advanced nutrition remains
disabled.

This is the canonical architecture document for Advanced Nutrition (target
v0.10.0). It records the trusted-source plan, the schema-v1 contract, the
evidence/authority rules, privacy constraints, and the phased roadmap.

---

## 1. Trusted-source plan

| Role | Source | Why |
| --- | --- | --- |
| **Primary authority** | **USDA FoodData Central** generic data (Foundation Foods + SR Legacy + FNDDS) | Authoritative, public-domain, deterministic `fdcId`, broad micro-nutrient coverage, no key required for the downloadable datasets |
| **Default delivery** | A **local slim dataset** transformed from the FDC downloads and versioned by release date | Local-first, offline, no per-request network, no privacy egress |
| **Optional enrichment** | The **USDA FDC API** for foods absent from the local cache | Server-proxied, key-isolated, bounded, TTL-cached; never required for core operation |
| **Optional secondary** | **Open Food Facts** for branded/barcode/package foods | User-initiated, server-proxied, attributed; not bundled by default (ODbL share-alike) |
| **Offline bootstrap / test fixture** | The existing 14-record `src/data/foodReference.ts` | Tiny offline fallback and test fixture only — never presented as USDA identity or broad authority |

USDA FoodData Central data are **public domain** and published under
**CC0 1.0 Universal**. Attribution is requested (not required):

> U.S. Department of Agriculture, Agricultural Research Service. FoodData
> Central, 2019. fdc.nal.usda.gov.

Official source: <https://fdc.nal.usda.gov/> (API guide, download datasets, and
data-type documentation accessed 2026-09-14).

Recipe-website scraping is **not** a source. Client-side API keys are not used.

---

## 2. Schema v1 (`codex_nutrition`) — totals-only

The advanced block is stored in a **namespaced top-level frontmatter key**
`codex_nutrition`, matching the repository's `codex_*` provenance convention.
The existing simple `nutrition` block and top-level `calories` are unchanged.

**Decision: schema v1 stores ENTIRE-RECIPE TOTALS ONLY (`basis: 'total'`).**
Per-serving values are always derived at display time from the totals and the
serving denominator. Persisting per-serving values is rejected in schema v1
because it invites double scaling and ambiguous legacy inference. This matches
the existing simple-nutrition contract.

### Field meanings

| Field | Meaning |
| --- | --- |
| `schema` | `1` for the recognized contract |
| `basis` | `'total'` only in schema v1 |
| `servings` | Validated serving denominator (finite, `> 0`, `<= 1000`) |
| `serving_size` | Optional bounded human-readable serving description |
| `status` | Recipe-level `complete \| partial \| stale \| unresolved` |
| `computed_at` | ISO timestamp of the calculation |
| `ingredient_digest` | `sha256:<64 hex>` digest of the ingredient set; a change invalidates the result |
| `dv_standard` | Pinned Daily Value standard id (`fda_adult_4plus_2020`) |
| `sources` | Bounded, unique list of authoritative sources (`usda_fdc`, `open_food_facts`, `curated_reference`, `user_manual`) |
| `source_releases` | Release identifier per declared dataset-backed source. `user_manual` declares no release and uses the fixed server-owned marker `user_manual` on any evidence record |
| `nutrient_scope` | **Closed, unique, nonempty** list of registered nutrient ids the calculation attempted to establish (bounded by the registry size) |
| `nutrients` | Map of closed nutrient id → `{ amount, unit, status, coverage, covered_ingredient_count, measurable_ingredient_count }`; every key must be in `nutrient_scope` |
| `ingredients` | Bounded per-ingredient evidence (line reference, source, `source_food_id`, release, match status, resolution/confirmation, optional amount + conversion basis) |
| `unresolved` | Bounded unresolved ingredient references with a reason |
| `manual_override` | Optional user-override metadata (timestamp + bounded note) |
| `extensions` | Bounded, NON-authoritative forward-compatible metadata |

A stored nutrient amount uses the nutrient's canonical unit from the closed
registry (see §3). Form-qualified units (`ug_rae`, `mg_ne`, `ug_dfe`) are their
own canonical units and are **not** converted to plain mass.

Negative zero (`-0`) is **rejected** (via `Object.is(value, -0)`) in every
authoritative numeric position — nutrient amounts, servings, coverage, counts,
conversion inputs, and Daily Value inputs. It is never silently normalized to
positive zero. Positive `0` remains valid where the field semantics allow it
(e.g. an explicitly source-reported zero amount); servings and measurable counts
must remain positive.

---

## 2a. `nutrient_scope` and the complete/partial contract

`nutrient_scope` is the exact, closed set of registered nutrients the
calculation attempted to establish. It is validated as a nonempty, unique,
bounded list of known nutrient ids; unknown ids are rejected. Every key in
`nutrients` must appear in `nutrient_scope`.

**`status: complete`** requires all of the following:

- `nutrient_scope` is nonempty;
- every scoped nutrient has a **present** nutrient result;
- every scoped nutrient result has `status: complete`;
- every scoped nutrient has **exact complete coverage** (`covered === measurable`
  **and** `coverage === 1`, with no epsilon comparison);
- there are **no unresolved entries**;
- an empty nutrient map can never claim complete.

**Provenance is classified before completeness.** For a complete record:

- If any **dataset-backed** source is declared (`usda_fdc`, `open_food_facts`,
  `curated_reference`), **every declared dataset source must have matching
  resolved evidence**. Manual evidence never substitutes for dataset evidence,
  and an unused declared dataset source is rejected.
- If `sources` is exactly `['user_manual']` (manual-only), `manual_override`
  **must always be present**, whether manual evidence is present or absent. Any
  manual evidence uses the fixed `user_manual` release marker, and no dataset
  source, dataset release, or dataset evidence may coexist.
- Mixed dataset/manual records must satisfy the dataset rules and never qualify
  for the manual-only exception. Manual provenance cannot impersonate or
  substitute for dataset provenance.

**`status: partial`** requires:

- `nutrient_scope` remains nonempty;
- at least one scoped nutrient is **absent**, is `partial`, or there is
  unresolved evidence (the record must identify why it is partial);
- absent scoped nutrients remain **absent** and are never synthesized as zero.

**`status: stale` / `status: unresolved`** never authorize as complete and never
invent missing amounts. An `unresolved` status must carry at least one
unresolved reference.

---

## 3. Nutrient registry and canonical units

Closed registry: 34 nutrient ids, each with exactly one canonical unit.

| Nutrient | Unit | Nutrient | Unit |
| --- | --- | --- | --- |
| calories | `kcal` | potassium | `mg` |
| protein | `g` | calcium | `mg` |
| carbohydrates | `g` | iron | `mg` |
| fat | `g` | magnesium | `mg` |
| saturated_fat | `g` | phosphorus | `mg` |
| trans_fat | `g` | zinc | `mg` |
| fiber | `g` | copper | `mg` |
| total_sugars | `g` | manganese | `mg` |
| added_sugars | `g` | selenium | `ug` |
| cholesterol | `mg` | vitamin_a | `ug_rae` |
| sodium | `mg` | vitamin_c | `mg` |
| vitamin_d | `ug` | vitamin_e | `mg` |
| vitamin_k | `ug` | thiamin | `mg` |
| riboflavin | `mg` | niacin | `mg_ne` |
| pantothenic_acid | `mg` | vitamin_b6 | `mg` |
| biotin | `ug` | folate | `ug_dfe` |
| vitamin_b12 | `ug` | choline | `mg` |

- ASCII-safe identifiers are stored (`ug`); the UI may render `µg`.
- Unknown authoritative nutrient ids are **rejected** in schema v1; future
  nutrients belong in bounded `extensions` until a schema revision.
- Numeric amounts are finite, non-negative, `<= 1_000_000_000`, and at most 6
  decimal places. Values are rejected, never silently clipped.

### Unit conversion helpers

Only mathematically identical metric conversions are provided:

- `g ↔ mg ↔ ug` (plain mass only).
- `kcal ↔ kJ` via the explicit, tested equivalence `1 kcal = 4.184 kJ`.

There is **no** volume→mass, count→mass, or density conversion, and **no**
implicit IU conversion. Form-qualified units are never converted.

---

## 4. Daily Values — derived, never persisted

- Pinned standard: **`fda_adult_4plus_2020`**.
- Source: U.S. Food and Drug Administration, *Daily Value on the Nutrition and
  Supplement Facts Labels*, 21 CFR 101.9(c)(8),
  <https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels>
  (page content current as of 2024-03-05; accessed 2026-09-14).
- `%DV` is computed at display/runtime from the stored amount and the pinned
  standard. It is **never stored** in the schema.
- Nutrients without an established Daily Value (calories, trans fat, total
  sugars) return *unavailable* — never a guessed percentage.
- An explicit source-reported zero yields `0%`.

These are label reference values, **not** medical advice or individualized
dietary targets.

---

## 5. Missing, zero, and partial semantics

- **Missing is absent, never zero.** A nutrient with no defensible amount has no
  entry in `nutrients`.
- **Explicit zero** is a present entry with `amount: 0` and complete coverage.
- **Partial** coverage records how much measurable evidence contributed:
  `status`, `coverage`, `covered_ingredient_count`, `measurable_ingredient_count`.
  A partial amount can never render as a complete recipe total; a complete recipe
  status cannot contain a partial nutrient. The block-level `complete`/`partial`
  rules and the `nutrient_scope` contract are defined in §2a.
- **Coverage arithmetic is exact and unconditional.** For every nutrient record
  the counts are validated *before* any ratio comparison:
  - `covered_ingredient_count` and `measurable_ingredient_count` must be finite
    **safe integers** (rejecting NaN/Infinity, unsafe integers, and `-0`);
  - covered is `>= 0`; measurable is `>= 1`;
  - `covered <= measurable` (impossible counts are rejected first);
  - `coverage` is finite, `>= 0`, `<= 1`, not `-0`;
  - **canonical representation rule:** `coverage` must exactly equal the
    IEEE-754 double result of `covered_ingredient_count / measurable_ingredient_count`.
    There is no epsilon or "close enough" comparison. Values are never silently
    clamped, normalized, or rounded into compliance.
  - `status: complete` additionally requires `covered === measurable` and
    `coverage === 1` exactly.
- Qualitative or deliberately excluded ingredients are not counted as
  measurable without an explicit rule.

Phase 0 defines and validates this contract; it does not calculate values.

---

## 6. Mixed-source evidence

There is no single misleading top-level `source`. A bounded `sources` list plus
per-ingredient evidence keeps every contribution traceable across datasets.
Validation enforces exact source/release relationships:

- every evidence record's `source` must appear in the declared `sources`;
- every declared dataset-backed source (`usda_fdc`, `open_food_facts`,
  `curated_reference`) must have a nonempty, bounded `source_releases` entry;
- an evidence record's `source_release` must **exactly equal**
  `source_releases[source]`;
- missing, extra, contradictory, duplicate, or mismatched release entries fail;
- a release entry for an undeclared source fails;
- source ids and release ids stay closed/bounded;
- `user_manual` declares **no** release and must not impersonate a USDA/OFF
  release. Any `user_manual` evidence uses the fixed server-owned marker
  `user_manual` (`USER_MANUAL_RELEASE_ID`);
- `curated_reference` must not claim USDA identity. The release id is normalized
  deterministically for this policy (lowercase, then remove every non-`[a-z0-9]`
  character) and rejected when the normalized form contains `usda` or `fdc`.
  This is locale-independent and is a **reserved-token policy only** — it is not
  a broad authority detector. Prohibited examples: `usda`, `USDA`, `fdc`,
  `u-s-d-a`, `u_s_d_a`, `u.s.d.a`, `f-d-c`, `f_d_c`, `U-S-D-A_F-D-C_2026`;
- releases are distinct across sources, so a mixed-source record preserves each
  source's own release.

Validation also rejects undeclared sources, duplicate line references, and
inconsistent resolution flags.

---

## 7. Extension and unknown-schema safety

- Recognized schema v1 uses a **strict whitelist**; unknown authoritative fields
  are rejected. Non-authoritative forward-compatible metadata belongs in the
  bounded `extensions` namespace.
- `extensions` and opaque data are validated as plain JSON/YAML-safe values:
  dangerous keys (`__proto__`, `prototype`, `constructor`) are rejected, with
  bounded depth, key count, array length, string length, and total serialized
  size. Extension data never influences calculation, authorization, or trusted
  display.
- The `extensions` namespace and opaque future-schema data are held to the
  **same UTF-8 serialized-byte rule** as the whole block.
- **Untrusted programmatic values are materialized in a single descriptor-based
  pass.** The walk inspects own properties through guarded reflection and builds
  a brand-new inert plain value; the original object is never revisited. It
  rejects getters/setters **without invoking them**, symbol keys,
  non-enumerable/unusual own properties (array `length` excepted), non-plain
  prototypes (Date/Map/Set/typed arrays/class instances), functions, bigints,
  undefined, cycles, dangerous keys, sparse arrays, and `ownKeys`/
  `getOwnPropertyDescriptor`/`getPrototypeOf`/`has` proxy failures. It never uses
  `in`, property reads, spread, `Object.assign`, `.map`, `toJSON`, `valueOf`, or
  coercion on the original. Validation, cloning, encoding, and serialization
  operate only on the inert copy.
- **Unknown or unrepresentable own properties are rejected, never sanitized
  away.** An own property whose value is `undefined` is rejected; unknown
  top-level fields and unknown nested fields (nutrient, evidence, evidence
  amount, unresolved, `manual_override`, release-container) are rejected. Only
  explicitly permitted arbitrary keys inside the bounded `extensions` namespace
  are preserved. Unknown-field rejection is independent of negative-zero
  validation.
- **Public boundaries fail closed with fixed, bounded, input-redacted
  diagnostics.** `validateCodexNutritionV1`, `decodeCodexNutrition`,
  `encodeCodexNutrition`, `isPlainSafeValue`, `cloneSafeValue`, the
  materialization/serialized-byte helpers, and recipe Markdown serialization
  never propagate an attacker's exception message, never echo unknown field
  names/values, and return at most `MAX_VALIDATION_ERRORS` (64) errors of at most
  `MAX_VALIDATION_ERROR_LENGTH` (120) characters totaling at most
  `MAX_VALIDATION_DIAGNOSTIC_BYTES` (4096). Oversized blocks are rejected during
  materialization, before large field diagnostics can accumulate.
- An **unknown future `schema`** value is preserved only as bounded opaque safe
  data: never interpreted, calculated, displayed as trusted, or authorized.
  Oversized/unsafe future blocks fail closed.
- An intact safe future block is **never silently dropped**.

### The 64 KiB limit is UTF-8 serialized bytes

`MAX_SERIALIZED_BYTES` (`64 * 1024`) is enforced against the **actual UTF-8
byte length** of the serialized block, not the UTF-16 code-unit `.length`. The
byte length is accounted **incrementally during materialization**, so an
oversized structure is rejected without a second traversal or a large duplicate
representation. JSON-string accounting handles opening/closing quotes, ordinary
ASCII, `"`/`\` escaping, `\b`/`\f`/`\n`/`\r`/`\t`, other `U+0000`–`U+001F`
characters as `\u00XX`, 1/2/3-byte UTF-8 characters, valid surrogate pairs
(4-byte), lone surrogates (escaped exactly as `JSON.stringify` does), object
keys, and array/object punctuation/commas/colons. `JSON.stringify` is **never**
called on an entire untrusted string. `utf8ByteLength` uses `TextEncoder` where
available (browser, Node, Obsidian/Electron) with a pure fallback. For bounded
inert values, `serializedBlockBytes(value)` equals
`utf8ByteLength(JSON.stringify(value))`; an exact-limit value passes and a
one-byte-over value fails closed. Values are never silently truncated.

---

## 8. Markdown / frontmatter round-trip

`src/utils/markdownParser.ts` encodes and decodes the `codex_nutrition` block:

- A validated typed block (or a valid recognized v1 raw block) is re-serialized
  from whitelisted canonical data only.
- A safe unknown future schema is preserved opaquely.
- A **malformed** raw block that is safely representable is preserved as
  **inert structural data** (never dropped, never interpreted) so a user file is
  never corrupted; the rest of the recipe serializes normally.
- **This is structural preservation, not byte-for-byte preservation.** YAML
  formatting, comments, quoting, and key order may change during an explicit
  Save. The tests prove the *semantic* structure is preserved and that
  malformed/unsafe/oversized data never attaches as interpreted
  `codexNutrition`, never authorizes, calculates, displays as trusted, or
  applies.
- An **unrepresentable programmatic value** (accessor/proxy/function/cycle/…)
  is **rejected, not preserved**. `serializeRecipeToObsidianMarkdown` throws a
  fixed, bounded error **before producing Markdown**, so a rejected hostile value
  is never handed to the YAML dumper, no hostile getter is invoked, and no
  partial vault write can silently overwrite the user's original file. Ordinary
  recipe data is preserved on every successful Save.
- `serving_size` and other recognized fields are never silently dropped.
- No advanced block is ever created automatically.
- Existing recipes are not rewritten until an explicit normal Save; the visual
  editor and raw `.md` editor both preserve the block (the block travels in
  `frontmatter`, which both paths carry through).

The parser exposes the decoded block as `ObsidianRecipe.codexNutrition`
(`CodexNutritionV1 | OpaqueCodexNutrition`). The raw block always remains in
`frontmatter`.

---

## 9. Privacy and no-medical-accuracy claims

- Only sanitized ingredient search terms (and, for optional branded lookup, a
  barcode) leave the device. Never full recipes, vault paths, notes, tags,
  credentials, or personal data.
- All external lookups are server-proxied and same-origin; API keys are
  server-env-only and never reach the browser, recipe files, logs, or
  provenance.
- The local cache is bounded, versioned, and user-clearable; offline and
  unconfigured states fail closed (never fabricate).
- Copy uses bounded wording ("nutritional estimates", "source records", "user
  review"). No medical-accuracy claims; no fear-based health scoring.

---

## 10. Phase 0 non-goals (current state)

Phase 0 does **not** implement: a nutrition dataset or download, any network
route, ingredient parsing/matching, a calculation engine, `%DV` persistence, any
UI (card or Advanced page), an Apply action, Vault Intelligence integration,
automatic persistence, or any change to the application version. It does not
enable machine-generated nutrition application.

### Existing findings deliberately contained (later-phase requirements)

- The metadata-recovery AI nutrition numeric-validation gap (F2).
- The legacy serializer's known-field behavior (F3) — now extended with the
  namespaced block but the simple block behavior is unchanged.
- Basis wording inconsistencies in the UI (F9).
- Existing estimator routes and caches (unchanged in Phase 0; TTL/versioning is
  a Phase 1 requirement).

---

## 11. Phased roadmap

- **Phase 0 — schema, evidence contract, threat model.** DONE: canonical units,
  nutrient registry, pinned Daily Values, schema-v1 contract, evidence
  validation, codec, fail-closed round-trip. Audit gate: schema review.
- **Phase 1 — trusted source adapter + bounded cache.** Local slim FDC dataset
  loader, optional server-proxied FDC enrichment, bounded TTL cache. Audit gate:
  source license + privacy review.
- **Phase 2 — deterministic ingredient parsing/matching review.** Reuse the
  existing measurement normalization; deterministic ranking; explicit user
  confirmation for ambiguous matches. Audit gate: matching precision review.
- **Phase 3 — calculation engine and serving math.** Totals → per-serving →
  `%DV`, reusing `src/utils/nutrition.ts`. Audit gate: numeric regression review.
- **Phase 4 — simple card + Advanced Nutrition page.** Full-screen modal,
  basis toggle, nutrient groups, evidence review. Audit gate: UX/a11y review.
- **Phase 5 — explicit Apply/persistence and legacy compatibility.** All-or-
  nothing Apply, provenance bound to applied values, stale invalidation. Audit
  gate: persistence + migration review.
- **Phase 6 — Vault Intelligence integration (separate explicit approval).**
  Single-recipe review first; bulk remains disabled.

MVP: Phases 0–4 plus a minimal Phase 5 for a single recipe, without claiming
completeness.

---

## 12. Phase 0 implementation map

| Concern | Module |
| --- | --- |
| Canonical units + bounds | `src/core/nutritionV2/units.ts` |
| Closed nutrient registry + FDA DV | `src/core/nutritionV2/nutrients.ts` |
| Pinned `%DV` helper | `src/core/nutritionV2/dailyValues.ts` |
| Schema-v1 types + bounds + safe values | `src/core/nutritionV2/schema.ts` |
| Evidence validation + codec + advisory eligibility | `src/core/nutritionV2/validate.ts` |
| Frontmatter round-trip | `src/utils/markdownParser.ts` (`applyAdvancedNutritionRoundTrip`) |
| Typed view on the recipe | `src/types.ts` (`ObsidianRecipe.codexNutrition`) |

Machine application remains disabled by the centralized
`canApplyNutritionEstimate` hard-disable (`src/core/nutritionSanity.ts`).
