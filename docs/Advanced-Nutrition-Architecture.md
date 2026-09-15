# The Kitchen Codex — Advanced Nutrition Architecture

Status: **Phase 0, Phase 1, and Phase 2 implemented (offline contracts + isolated
review layer only)**. No USDA dataset is bundled, no network route or live API is
used, and there is no calculation engine, UI, Apply action, or automatic
persistence. Machine application of advanced nutrition remains disabled.

Phase 1 adds a trusted, offline, key-free USDA FoodData Central contract: a
strict release manifest, a defensive adapter for the **actual pinned download
records**, an exact stable nutrient-ID map, strict fail-closed canonical
serialization, an immutable exact-ID store, and a bounded in-memory cache — plus
real official-record fixtures and separate synthetic adversarial fixtures.

Phase 2 adds an **isolated, review-only** matching layer (§14): defensive
ingredient parsing, conservative query normalization, a manifest-bound review
catalog, deterministic ranking, a closed outcome union, and an explicit
confirmation/rejection boundary. It reuses the Phase 0/1 primitives and the
existing measurement normalizer; it does **not** calculate recipe nutrition,
persist, apply, or touch any production surface. Phase 3–6 remain unimplemented.

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

**Phase 1 scope.** Only the three generic FDC data types are in scope:
`foundation`, `sr_legacy`, and `fndds`. Verified September 2026 baseline:
Foundation Foods **April 2026**, SR Legacy **final April 2018**, FNDDS
**2021-2023 (October 2024)**. Downloads are available in JSON and CSV. The live
FDC API requires a data.gov key and is **not** used in Phase 1: no key, no live
API, no query-string construction, and no network client. Branded Foods and
Open Food Facts are deliberately excluded (product-specific matching belongs to
a later, separately approved phase).

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
- **Phase 1 — trusted USDA adapter + bounded cache.** DONE (offline/contract):
  release-manifest + bundle-identity contract, a defensive adapter that consumes
  the **complete pinned Foundation/SR Legacy/FNDDS download records**, an exact
  stable nutrient-ID map (v2), strict fail-closed canonical serialization, an
  immutable exact-ID local store, and a bounded in-memory cache, with real
  official-record fixtures, synthetic adversarial fixtures, focused security
  tests, and a full-archive compatibility census. No dataset is downloaded or
  bundled in the repository. **Still future:** a separately audited, explicit
  local dataset *acquisition/generation* step that turns an official FDC download
  into a manifest-bound canonical bundle. Audit gate: source license + privacy
  review.
- **Phase 2 — deterministic ingredient parsing/matching review.** DONE (offline,
  isolated): defensive ingredient parsing, conservative query normalization, a
  manifest-bound review catalog, deterministic ranking, a closed outcome union
  (matched_exact / review_required / unmatched / invalid), and an explicit,
  cryptographically bound confirmation/rejection boundary. It is review-only —
  no calculation, persistence, UI, or application. Audit gate: matching
  precision review.
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

---

## 13. Phase 1 — trusted USDA adapter, manifest, store, and bounded cache

Phase 1 implements an **offline, key-free, contract-and-adapter layer only**. It
does not download or bundle a USDA dataset, does not call the live API, and is
not imported by any production surface. Its modules live under
`src/core/nutritionV2/usda/` and are intentionally **not** re-exported from
`src/core/nutritionV2/index.ts` or `src/core/index.ts`.

### 13.1 Source, attribution, and verified releases

- Sole authority: **USDA FoodData Central** (FDC).
- Public domain / **CC0 1.0 Universal**; attribution is requested, not required:
  *U.S. Department of Agriculture, Agricultural Research Service. FoodData
  Central, 2019. fdc.nal.usda.gov.*
- Verified September 2026 baseline: Foundation Foods **April 2026**, SR Legacy
  **final April 2018**, FNDDS **2021-2023 (October 2024)**. Downloads are JSON
  and CSV. These are **manifest data**, never timeless constants scattered
  through production code.
- The live FDC API requires a data.gov key. Phase 1 uses **no key and no live
  API**. Branded Foods and Open Food Facts are out of scope.

**Exact pinned archives supported** (downloaded only under `/tmp` for audit;
never committed or bundled). Their SHA-256 digests were verified before use:

| Data type | Release | Archive (official `fdc-datasets`) | SHA-256 |
| --- | --- | --- | --- |
| `foundation` | April 2026 | `FoodData_Central_foundation_food_json_2026-04-30.zip` | `186e988e…c09c77a` |
| `sr_legacy` | April 2018 | `FoodData_Central_sr_legacy_food_json_2018-04.zip` | `0fe8ae48…6dd338ef` |
| `fndds` | FNDDS 2021-2023 (October 2024) | `FoodData_Central_survey_food_json_2024-10-31.zip` | `dfb06ae7…2a77f3eb` |

Phase 1 supports **only these pinned downloadable JSON records**. It does not
claim generic "USDA JSON" or live-API compatibility, does not support Branded
Foods, and does not auto-discover future releases. A future USDA release requires
a new manifest and a fresh compatibility audit.

### 13.2 Per-100-g source basis vs. recipe-total persistence basis

Every canonical USDA record is `basis: 'per_100_g'`. This is a **source-food**
basis, deliberately distinct from the Phase 0 recipe block basis
`codex_nutrition.basis: 'total'`. Per-100-g values are never serialized directly
as recipe totals; a test asserts that `encodeCodexNutrition` rejects a canonical
per-100-g record. Phase 3 will multiply trusted per-100-g values by reviewed
ingredient mass and persist entire-recipe totals separately.

### 13.3 Release manifest and bundle identity

`manifest.ts` defines a strict, closed `UsdaBundleManifest`:

| Field | Meaning |
| --- | --- |
| `manifest_schema` | `1` |
| `bundle_release` | one bounded (1..64 char) bundle release id |
| `generator` | bounded `{ name, schema_version }` |
| `created_at` | bounded ISO timestamp |
| `data_types` | unique subset of `foundation`/`sr_legacy`/`fndds` |
| `components[]` | one per data type: `data_type`, `upstream_release`, `source_url`, `source_sha256` |
| `canonical_record_count` / `rejected_record_count` | bounded non-negative safe integers |
| `canonical_content_digest` | exact lowercase 64-hex SHA-256 over the canonical records |
| `nutrient_map_version` / `canonicalization_version` | pinned versions |
| `warnings[]` | optional bounded `{ code, count }` |
| `attribution` | required USDA attribution string |

**Bundle identity.** `computeBundleIdentity(manifest)` hashes the authoritative
inputs (manifest schema, generator schema, data types, each component's release /
URL / digest, nutrient-map version, canonicalization version). The bundle release
id is derived from that identity (`usda_fdc_<32 hex>`), so it changes whenever
any component release, input digest, nutrient mapping, canonicalization rule, or
generator schema changes, and it always satisfies the 64-character bound. The
manifest is rejected if the declared `bundle_release` does not match the derived
identity. Phase 0 allows one release id per source, so
`source_releases.usda_fdc` is this single bundle release id.

Validation is closed and bounded: unknown/duplicate/missing/contradictory/unsafe
fields fail; URLs must be `https://fdc.nal.usda.gov/...` with no credentials,
query, or fragment; SHA-256 values must be exact lowercase 64-hex; counts must be
safe non-negative integers (rejecting `-0`, negatives, non-integers, and unsafe
values); oversized manifests fail. **Validation never fetches a URL.**

**SHA-256 caveat.** A SHA-256 digest proves identity/integrity against a pinned
expected manifest; it does **not** prove USDA authorship without a separately
trusted acquisition process. Phase 1 makes no such claim.

### 13.4 Raw transport records vs. canonical trusted records

Phase 1 distinguishes three separate shapes and bounds:

1. **Raw USDA transport record** — the complete official download record
   (`foodClass`, `foodAttributes`, `inputFoods`, `nutrientConversionFactors`,
   `publicationDate`, nutrient-entry `type`/`id`/`dataPoints`/`foodNutrientDerivation`/
   `min`/`max`/`median`, Foundation portion `value`/`minYearAcquired`, FNDDS
   `wweiaFoodCategory`, etc.). Materialized and bounded by `raw.ts` with the RAW
   bounds (see §13.8).
2. **Canonical trusted record** — the small closed projection produced by the
   adapter, bounded by the canonical 64 KiB rule.
3. **Cache entry** — a canonical record plus its digest, bounded separately.

`types.ts`/`record.ts` define the closed, deep-frozen canonical record:

```
source: 'usda_fdc' | bundle_release | upstream_release | fdc_id | data_type
description | food_category? | nutrient_map_version | basis: 'per_100_g'
nutrients: { [NutrientId]: { nutrient_id, unit, amount_per_100g,
             usda_nutrient_id, source_unit, converted } }
portions:   [ { usda_portion_id?, amount?, measure, gram_weight,
               modifier?, sequence? } ]
record_digest
```

Only canonical fields are retained: no raw transport metadata, unused USDA
metadata, input-supplied URLs, HTML, prompts, notes, paths, credentials, personal
information, or arbitrary nested extensions. A test asserts no ignored official
field name survives into canonical output.

### 13.5 Stable nutrient-ID mapping

`nutrientMap.ts` (version `usda_fdc_nutrient_map_v2`) is the single closed mapping
from verified USDA nutrient ids to Phase 0 `NutrientId`s. It never maps by display
name. Ids, names, and the single observed `unitName` were verified against the
**pinned archives themselves** (all three releases), and the official micro sign
`µg` (U+00B5) is normalized before comparison. Representative mappings:
1003→protein, 1004→fat, 1005→carbohydrates, 1008→calories (kcal), 1079→fiber,
1093→sodium, 1106→vitamin_a (`ug_rae`, RAE form), 1114→vitamin_d, 1190→folate
(`ug_dfe`, DFE form), 1253→cholesterol, 1258→saturated_fat, 2000→total_sugars.

- A mapped id with the wrong source unit is rejected (`unit_mismatch`); it is
  never converted.
- IU is never converted, and biological-form nutrients are never merged by
  similar name: 1104 (Vitamin A, IU), 1105 (Retinol), 1107/1108 (carotenes),
  1110 (Vitamin D, IU), 1177 (Folate, total — mass, not DFE), and 1167 (Niacin,
  plain mass) are **not** mapped.
- **`niacin` and `added_sugars` are deliberately UNMAPPED in Phase 1**: the
  pinned releases expose no niacin-equivalent component (1169 absent) and no
  `Sugars, added` (1235 absent). They remain absent rather than being inferred
  from plain niacin or total sugars. No release-specific override is required
  because the rule is uniform across all three pinned releases.
- Unsupported USDA nutrients are ignored only after the whole record passes
  bounded inert validation, and they never enter the output as authority.

**Energy policy.** Only 1008 (`Energy`, kcal) directly represents kilocalories.
1062 (`Energy`, kJ) is a documented fallback used only when no 1008 is present,
converted with the existing exact 4.184 `convertEnergy` helper. Energy components
are never summed, no arbitrary "first" value is chosen, a duplicate direct kcal
component is rejected as a conflict, and the fallback never creates a second
calories entry.

### 13.6 Missing, zero, null, and exact units

- **Missing is absent, never zero.** A supported nutrient with no source value
  has no entry.
- **Explicit source-reported zero** is a present entry with `amount_per_100g: 0`.
- **A `null` amount is absent**, never zero. A mapped nutrient with a present but
  out-of-contract amount (negative, `-0`, non-finite, over-precise, excessive)
  fails the record as `invalid_nutrient` (a small number of pinned Foundation
  records carry negative USDA-derived carbohydrate values; see §13.8).
- Amounts are finite, non-negative, `<= 1_000_000_000`, at most 6 decimal
  places, and never `-0`. Values are rejected, never clipped or truncated.
- Only mathematically identical metric mass conversions (`g`/`mg`/`ug`) and the
  exact kJ↔kcal equivalence are permitted; there is no volume→mass or count→mass
  conversion, and no IU conversion.

### 13.7 Portions are unselected evidence only

Optional source-provided gram-weight portions are preserved as bounded evidence
(stable reference, optional amount, measure, gram weight, optional modifier,
optional sequence). `amount` is **optional** only when it is genuinely absent:
FNDDS portions legitimately omit it and it is never invented as `1`.

Presence-sensitive amount policy:

- an **absent** property (or an explicit `null`) is preserved as absent;
- a **present** amount must satisfy the canonical numeric contract and be
  strictly positive and bounded — `0`, `-0`, negatives, non-finite values,
  numeric strings, and over-precise/unsafe/excessive values all fail;
- a present invalid amount is **never** omitted, normalized, or replaced, and it
  **never** falls back to `value`;
- Foundation/SR Legacy's official `value` alternate is used only when `amount` is
  genuinely absent; when **both** are present they must both be valid and equal,
  otherwise the contradictory pair fails closed;
- an invalid gram weight, a missing measure, or a contradictory duplicate portion
  identity also fails.

Any such failure rejects the **entire food record** as `invalid_portion` — one
invalid portion is never silently turned into trusted evidence, and Phase 1
intentionally excludes affected records rather than laundering invalid evidence.
Phase 1 never selects a portion automatically and never uses a portion to
calculate anything; a volume or count measure is never converted to mass.

### 13.8 Adapter trust boundary

`adaptUsdaFood(raw, context)` is the **pinned download-record adapter**. It
accepts one complete official record plus a validated release context and
returns either one canonical record or a closed, bounded, input-redacted failure.
The trust sequence is: untrusted value → bounded raw materialization (`raw.ts`,
single descriptor pass; no getters/proxy traps/`toJSON`/`valueOf`/coercion) →
exact data-type dispatch on the official transport label (`Foundation`,
`SR Legacy`, `Survey (FNDDS)`) → closed data-type-specific transport-shape
validation (`transport.ts`) → read only authoritative fields → exact stable
nutrient-ID mapping → canonical-unit validation/conversion → canonical record
construction. The raw object is never exposed or revisited. There are three
data-type parsers behind one entry point; the prior reduced/API-shaped projection
is **not** accepted (it is a strict subset only when it also happens to be
schema-valid, and no ambiguous heuristic selects between shapes).

**Closed transport schemas.** Each pinned record type has a closed allowed-field
set for the top level and for the read containers (nutrient entry, nutrient
descriptor, portion, measure unit, category). An unknown field for the pinned
schema fails. Approved ignored official metadata (`foodClass`, `foodAttributes`,
`inputFoods`, `nutrientConversionFactors`, `publicationDate`, derivation,
`dataPoints`, min/max/median, entry `type`/`id`, `minYearAcquired`, …) is still
bounded and inertly validated before being discarded, and never enters the
canonical record, extensions, cache, manifest, or provenance.

**Failure classes.** `malformed`, `unsafe`, `oversized`, `unsupported_data_type`,
`release_mismatch`, `invalid_fdc_id`, `invalid_basis` (reserved — the pinned
transports carry no basis field), `invalid_nutrient`, `unit_mismatch`,
`duplicate_nutrient`, `invalid_portion`, `record_too_large`,
`no_supported_nutrients`, `digest_mismatch`, `validation_error`.

**Bounds (measured from the pinned archives).** Raw transport: max 256 KiB
serialized, depth 8, 64 keys, 512 array entries, 4096-char strings, 256 nutrients,
64 portions. Observed maxima: Foundation 87,874 B / 159 nutrients / depth 5 /
978-char string; SR Legacy 55,622 B / 138 nutrients; FNDDS 17,587 B / 65
nutrients. The canonical bound (64 KiB) and the cache-entry bound are separate
and smaller.

**Full-archive census (temporary probe).** All three pinned archives were
adapted: Foundation 353/395 accepted (32 `null` array placeholders skipped;
10 rejected `invalid_nutrient` for negative USDA-derived amounts); SR Legacy
7,775/7,793 accepted (18 rejected `invalid_portion` — 18 portions across 18
distinct records carry a present `amount: 0`/`value: 0`; see §13.7); FNDDS
5,431/5,432 accepted (1 rejected `no_supported_nutrients` for the empty
"Milk, human" profile). The rejections are explained and documented; Phase 1
does **not** claim complete archive support.

### 13.9 Immutable exact-ID store

`store.ts` builds a read-only store from a validated manifest and canonical
records. It supports exact lookup by bundle release + FDC id, bounded metadata,
and nothing else — no fuzzy search, token search, ranking, ingredient matching,
automatic candidate selection, category guessing, branded fallback, or recipe
parsing. Construction is all-or-nothing: records must match the manifest's bundle
release, component release, and nutrient-map version; duplicate FDC ids, count
mismatches, content-digest mismatches, and any invalid record fail closed. Exact
misses return a closed `not_found`. Returned records are deeply frozen, so caller
mutation cannot alter stored authority.

### 13.10 Bounded in-memory cache

`cache.ts` is a performance layer only, never an authority source. Keys include
the bundle release + FDC id, and each entry stores its canonical digest, which is
verified on read. It never serves a record across releases, never caches raw
USDA input or credentials/URLs, clamps configurable entry-count and byte maxima
to safe hard limits, rejects oversized single entries, uses deterministic LRU
eviction, accounts total bytes exactly across replacement and eviction, and
supports release-specific invalidation and explicit clear. There are no timers,
no hidden persistence (no IndexedDB/localStorage/filesystem/vault), no cross-user
or cross-vault namespace, and no cache-driven trust upgrade. Negative lookup
caching is not implemented.

### 13.11 Strict canonical serialization

`digest.ts` provides `canonicalStringify`, a strict, fail-closed serializer used
for every identity input (bundle identity, canonical record digest, content
digest). It rejects, without invoking attacker code: `undefined`, `-0`, `NaN`,
`Infinity`, bigint, symbol, function, accessors, symbol keys, sparse arrays,
non-enumerable/hidden properties, non-plain prototypes (Date/Map/Set/typed
arrays/class instances), cycles, dangerous keys, and hostile proxies. It never
substitutes `null` for an unsupported value, so `{a: undefined}` and `{a: null}`
can never alias, and `-0` can never alias `0`. `null` serializes only when it was
explicitly present.

Object keys are sorted by a locale-independent UTF-16 code-unit rule; arrays
preserve order; object/array and string/number remain distinct. Strings preserve
exact code units, are escaped exactly as `JSON.stringify` escapes them (lone
surrogates included), and are **never** implicitly Unicode-normalized (NFC and
NFD remain distinct). `1` and `1.0` are the same JS number and are not
distinguished. Digest call sites exclude the digest field itself, include every
authoritative field, and fail closed when strict serialization fails.

### 13.12 Fixtures: real official records vs. synthetic adversarial data

Two clearly separated fixture sets exist under `tests/` (test-only, never
imported by production):

- **Real official records** — `tests/fixtures/usdaRealRecords/` holds the
  complete records for Foundation `321358`, SR Legacy `167512`, FNDDS `2705384`,
  and the intentionally-rejected SR Legacy `168789`. Each is **deterministically
  extracted and compact-serialized from the pinned archive**: parse the verified
  archive JSON, locate the record by exact numeric FDC id (exactly one match),
  serialize the complete parsed record with native compact `JSON.stringify`
  (no replacer, no indentation), encode UTF-8, and write exactly those bytes with
  no added whitespace. The fixtures are therefore byte-identical to that
  documented compact extraction output and semantically equal to the selected
  archive entry — they are **not** raw archive byte slices and **not** synthetic.
  The adjacent closed-schema `PROVENANCE.json` records the FDC id, data type,
  upstream release, official archive URL, expected archive SHA-256, extraction
  method/version, expected fixture byte length, expected fixture SHA-256,
  extraction date, attribution, CC0 status, and the expected adapter outcome.
- **Synthetic adversarial fixtures** — `tests/fixtures/usdaFixtures.ts` is
  clearly labelled synthetic and covers explicit zero, missing/null nutrients,
  unsupported nutrients, valid/absent/invalid portions, duplicate and wrong-unit
  nutrients, conflicting energy, invalid ids/data types, release mismatch,
  oversized/deep/hostile input, dangerous keys, negative/`-0`/non-finite/
  excessive/over-precise values, and malformed portion weights.

No production USDA dataset and no generated bundle is committed. No search,
matching, calculation, UI, or Apply behavior is added.

### 13.13 Future, separately audited acquisition step

A future controlled step may add a pure, testable build boundary that consumes
explicitly supplied local input and writes to an explicitly supplied output path
(never fetching a URL, never discovering "latest" automatically, requiring
expected input SHA-256 values, deterministic ordering, atomic output, refusing
root/home/repository/vault targets, and refusing partial trusted output). That
step is deliberately **not** implemented in Phase 1 and requires separate
approval. Phase 1 does not claim that the adapter or a SHA-256 digest
independently proves USDA authenticity, and it does not calculate accurate recipe
nutrition.

### 13.14 Phase 1 implementation map

| Concern | Module |
| --- | --- |
| Pure SHA-256 + strict canonical serialization | `src/core/nutritionV2/usda/digest.ts` |
| Closed contract, raw/canonical/cache bounds, failure classes | `src/core/nutritionV2/usda/types.ts` |
| Bounded raw-record materialization | `src/core/nutritionV2/usda/raw.ts` |
| Pinned per-data-type transport schemas | `src/core/nutritionV2/usda/transport.ts` |
| Stable USDA nutrient-ID map (v2) | `src/core/nutritionV2/usda/nutrientMap.ts` |
| Canonical record digest + re-validation | `src/core/nutritionV2/usda/record.ts` |
| Release manifest + bundle identity | `src/core/nutritionV2/usda/manifest.ts` |
| Pinned download-record adapter | `src/core/nutritionV2/usda/adapter.ts` |
| Immutable exact-ID store | `src/core/nutritionV2/usda/store.ts` |
| Bounded in-memory cache | `src/core/nutritionV2/usda/cache.ts` |
| Real official-record fixtures (test-only) | `tests/fixtures/usdaRealRecords/` + `tests/fixtures/usdaRealFixtures.ts` |
| Synthetic adversarial fixtures (test-only) | `tests/fixtures/usdaFixtures.ts` |

Phase 1 is **not** wired into any production surface, and
`advancedNutritionApplicationAuthorization()` and `canApplyNutritionEstimate`
remain globally disabled.

---

## 14. Phase 2 — deterministic ingredient parsing & matching review (isolated)

Phase 2 is an **isolated, pure, offline, review-only** layer under
`src/core/nutritionV2/matching/`. It answers exactly one question:

> "Which pinned USDA food records are plausible candidates for this ingredient,
> and does a human need to choose?"

It never answers "what are this recipe's nutrition totals?". It is **not**
re-exported from `src/core/nutritionV2/index.ts` or `src/core/index.ts`, and no
production UI, route, provider, estimator, persistence path, or vault path may
import it. Tests import it directly from its isolated module path.

### 14.1 Implementation map

| Concern | Module |
| --- | --- |
| Closed contract, bounds, versions, failure taxonomy | `src/core/nutritionV2/matching/types.ts` |
| Conservative query normalization + tokenization | `src/core/nutritionV2/matching/normalize.ts` |
| Defensive ingredient parsing | `src/core/nutritionV2/matching/parse.ts` |
| Deterministic ranking | `src/core/nutritionV2/matching/rank.ts` |
| Authority boundary: catalog factory + review + confirmation | `src/core/nutritionV2/matching/review.ts` |
| Isolated barrel (not re-exported publicly) | `src/core/nutritionV2/matching/index.ts` |
| Calculation-free raw-line segmenter | `src/utils/measurements.ts` (`parseRawIngredientMeasurementParts`) |
| Synthetic matching fixtures (test-only) | `tests/fixtures/usdaMatchingFixtures.ts` |

### 14.2 Parsing contract

`parseIngredient(raw)` accepts a bounded raw ingredient string OR the
repository's structured ingredient shape (`{ original?, amount?, unit?, name?,
note?, line_ref?, index?, ... }`) as `unknown`. It materializes the value through
the existing safe inert-value boundary (`toInertValue`) before any field access,
so accessors, proxies, symbol keys, dangerous keys, cycles, sparse arrays, and
non-plain objects fail closed with fixed, bounded, input-redacted diagnostics.
The source object is never mutated and wikilinks are preserved on it.

Derived review fields: `line_ref` (caller-supplied, else `line:<index>`, else the
original text), `original_text`, `amount` (number or null), `raw_unit`,
`normalized_unit`, `measurement_kind`, `grams` (direct mass only), `milliliters`
(volume only), `count` (count classification only), `query` (bounded food name),
and optional `note`.

Honesty rules: a missing amount stays `null` (never defaulted to 1); volume never
becomes mass; count never becomes mass; no density or count-weight is invented;
"pinch"/"dash"/"to taste"/unknown units stay unmeasurable; an oversized line is
rejected (`oversized_input`), never silently truncated into a different valid
ingredient. Measurement derivation reuses the canonical `normalizeUnit`,
`parseAmount`, and `normalizeIngredientMeasurement` primitives and the
calculation-free `parseRawIngredientMeasurementParts` segmenter — no competing
parser.

**Calculation-free segmenter.** The raw-line segmenter was relocated from the
legacy deterministic calculation engine (`src/core/deterministicNutrition.ts`) to
`src/utils/measurements.ts` as `parseRawIngredientMeasurementParts`. It is pure
and imports no nutrition/density/count-weight/per-100-g data, so the Phase 2
matching layer has **no load-time dependency on the calculation layer**. The
legacy engine re-exports the SAME function as `normalizeRawIngredientLine` (one
implementation, no behavior change), and a transitive import-graph test proves no
Phase 2 path reaches `deterministicNutrition.ts` or `foodReference.ts`.

### 14.3 Normalization contract (matching only)

`normalizeQuery(text)` is the single documented matching contract
(`usda_match_normalize_v1`). In order: Obsidian wikilink label extraction
(`[[T|Alias]]`→`Alias`, `[[T]]`→`T`, `[[T#H]]`→`T`, `![[T]]`→`T`), Unicode
**NFC** normalization, non-locale lowercase (`toLowerCase`, never
`toLocaleLowerCase`), Unicode-aware punctuation/symbol separation
(`[^\p{L}\p{N}\s]+` → space), whitespace collapse, and bounded tokenization. It
never stems, singularizes, deletes stop words, uses phonetics, or drops
nutritionally significant qualifiers (raw/cooked, salted/unsalted,
sweetened/unsweetened, whole/skim, lean/ground, canned/drained,
enriched/unenriched, with/without skin, dry/prepared). Queries are bounded:
empty → `empty_query`; more than 32 tokens or a token longer than 48 characters →
`invalid_query`.

### 14.4 Catalog construction and bounds

`createReviewCatalog(manifest, records)` builds a review catalog ONLY from a
validated Phase 1 bundle manifest and caller-supplied canonical Phase 1 records.
Construction is all-or-nothing: strict manifest validity, derived bundle
identity, canonical content digest, exact record count, every record's canonical
digest, bundle-release equality, component/upstream-release equality,
nutrient-map version, allowed data type, unique FDC ids, and record bounds are all
verified. One invalid record rejects the entire catalog.

`MAX_CATALOG_RECORDS = 20,000` — at least the combined accepted population of the
three pinned Phase 1 releases (353 + 7,775 + 5,431 = 13,559). The bound is
**inclusive**: exactly 20,000 otherwise valid records are accepted and 20,001 are
rejected (`too_many_records`); a permanent test exercises `createReviewCatalog` at
both sides of that boundary. An empty catalog is rejected (`empty_catalog`). The
catalog indexes only bounded review identity (`fdc_id`, `data_type`,
`description`, normalized description/tokens, `record_digest`) — never nutrient
values — so it cannot be used as a calculation shortcut. It returns frozen
metadata and frozen candidates; caller mutation of the input array cannot alter
its authority. It exposes `metadata()`, `size()`, `search()`, and
`exactPhraseCount()` — no Phase 1 store surface. The Phase 1 exact-ID store
remains unchanged and still exposes only `lookup`/`metadata`.

`createReviewCatalog` also registers the returned instance in a module-private
`WeakMap` authority registry (see §14.7) used only by confirmation; the registry
is not part of the public barrel and exposes no records, nutrients, or mutable
state.

### 14.5 Ranking tuple and version

`rankCandidates(query, entries, limit)` (`usda_match_rank_v1`) uses an integer
comparison tuple (no floating-point scores, no nutrient values, no data-type
preference):

```
[class_rank, missing_query_tokens, extra_candidate_tokens,
 order_disagreement (0 agrees / 1 disagrees), fdc_id]
```

Closed match classes, most specific first: `exact_phrase`,
`exact_token_multiset`, `all_query_tokens_present`, `partial_token_overlap`,
`no_match` (excluded). `order_agreement` is an ordered-subsequence check. The
numeric `fdc_id` is the only presentation tie-break; it never converts a semantic
tie into an automatic selection. Results are capped by `DEFAULT_RESULT_LIMIT = 10`
and `MAX_RESULT_LIMIT = 25`, and are independent of input entry order.

### 14.6 Outcome state machine and automatic-match rule

`reviewIngredient(catalog, raw, options?)` returns a closed outcome union:

```
invalid          parse/normalize failure (no candidates)
unmatched        no candidate shares any query token
review_required  one or more candidates, but not a unique exact identity
matched_exact    the ONLY automatic identity outcome
```

`matched_exact` requires ALL of: the normalized ingredient phrase exactly equals
the normalized USDA description; **exactly one** catalog record has that exact
normalized description (`exactPhraseCount === 1`); and the result is bound to the
validated bundle. Token-set equality, token overlap, word reordering, containment,
and duplicate exact phrases ALWAYS require review. A numeric score or first-ranked
result never authorizes automatic selection. `matched_exact` is an identity
statement only — it never authorizes calculation, persistence, display as final
nutrition, or application.

### 14.7 Confirmation, rejection, and catalog authority

`confirmIngredientReview(currentCatalog, review, selection)` is a pure boundary.
It requires a **genuine live catalog instance** created by `createReviewCatalog`
and independently **reconstructs** the authoritative review from that catalog.
The selection is `{ kind: 'candidate', fdc_id }` or `{ kind: 'none' }` (explicit
"none of these" rejection), plus a required `review_digest` and optional
cross-checks (`bundle_release`, `normalized_query`, `line_ref`).

**Catalog authority is lexically private and runtime-authenticated, not
structural.** The authority registry and its registration/retrieval operations
live in the SAME lexical module as `createReviewCatalog` and
`confirmIngredientReview` (`src/core/nutritionV2/matching/review.ts`) as a
module-local `WeakMap` with non-exported functions. `createReviewCatalog`
registers the exact catalog instance it returns against the validated internal
authority state (frozen metadata + frozen normalized review entries);
`confirmIngredientReview` retrieves authority only for the exact catalog argument
it is given. Neither the registry nor any registration/retrieval operation is
exported — **not even via a direct file-path import** — so no other module can
register an arbitrary object as a genuine catalog or obtain authority state.
There is no exported registry, symbol, token, brand, key, handle, or
dependency-injection hook for authority, and the public API exposes behavior, not
authority state. A structural clone, spread wrapper, proxy, inherited object,
hand-built lookalike, primitive, or `null` is not registered and is rejected with
`invalid_catalog`. No getter, method, or proxy trap is invoked on the untrusted
catalog argument. Structural typing, `instanceof`, a public symbol, a
caller-visible brand, or a caller-supplied catalog digest are NOT relied upon,
and the private authority, internal index, canonical records, nutrient values, and
mutable state are never exposed.

**Current-catalog reconstruction.** Confirmation defensively materializes the
supplied review, validates its closed schema and bound versions, recomputes its
snapshot digest and compares it to the supplied digest, then independently reruns
the authoritative search/ranking/outcome classification from the genuine current
catalog for the supplied normalized query, line/reference identity, normalization
version, ranking version, and exact effective `result_limit`. It then requires
exact canonical equality between the supplied review and the reconstruction —
including every candidate's FDC id, record digest, match class, complete ranking
evidence, and deterministic order — requires the reconstructed outcome to be
genuinely `review_required`, and only then accepts a selection whose FDC id is in
the **reconstructed** candidate set.

**Digest integrity vs. authority.** The `review_digest` is
`sha256Hex(canonicalStringify({ normalization_version, ranking_version,
bundle_release, catalog_digest, line_ref, original_text, query, normalized_query,
query_tokens, result_limit, candidates: [{fdc_id, data_type, description,
normalized_description, record_digest, match_class, evidence}] }))` using the
strict Phase 1 serializer and SHA-256 primitive. SHA-256 is **unkeyed**: it proves
deterministic review-snapshot integrity, **not authenticity**. A caller may know
and reproduce the algorithm; a caller-built review that is semantically identical
to the genuine current-catalog reconstruction may be accepted (it represents the
same authoritative result), but a review that adds, removes, changes, or
substitutes any candidate or ranking fact fails even if its digest is recomputed
correctly — because current-catalog reconstruction differs.

**Failure codes.** `invalid_catalog` (catalog not genuine), `invalid_review`
(malformed/self-inconsistent review), `unsafe_review` (hostile review object),
`not_reviewable` (outcome other than `review_required`), `stale_review` (review
does not match the supplied genuine current catalog: bundle, catalog/content
digest, record digests, candidate set/description/ranking, query, or versions),
`candidate_not_in_review_set`, `malformed_digest`, `binding_mismatch`,
`unknown_field`, `unsafe_selection`, `invalid_selection`, `validation_error`.

**Stale-catalog behavior and honest limitation.** A review created from catalog A
fails against catalog B when any authoritative component differs (bundle release,
catalog/content digest, record set, candidate record digest, candidate set,
ranking output, normalization version, ranking version). `stale_review` is used
only when comparison with the supplied genuine current catalog establishes
staleness. Confirmation verifies against the catalog instance the caller supplies;
it cannot know which catalog is globally "current", so a caller that deliberately
passes an older genuine catalog cannot be distinguished from one passing the
intended active catalog. Production composition is deferred and will be
responsible for supplying the active catalog.

Confirmation is never auto-chosen and is **never persisted** in this phase; it is
not converted into Phase 0 ingredient evidence, recipe totals, or a
`codex_nutrition` block, and it authorizes no calculation or application. Phase 3
and Phase 5 will handle those separately.

### 14.8 Failure classes

- Parsing: `invalid_input`, `unsafe_input`, `oversized_input`, `unknown_field`,
  `invalid_amount`, `invalid_unit`, `invalid_name`, `invalid_line_ref`,
  `empty_query`, `invalid_query`, `validation_error`.
- Catalog: `invalid_manifest`, `invalid_record`, `duplicate_fdc_id`,
  `release_mismatch`, `count_mismatch`, `content_digest_mismatch`,
  `too_many_records`, `empty_catalog`, `validation_error`.
- Confirmation: `invalid_catalog`, `invalid_review`, `unsafe_review`,
  `not_reviewable`, `candidate_not_in_review_set`, `malformed_digest`,
  `stale_review`, `binding_mismatch`, `invalid_selection`, `unsafe_selection`,
  `unknown_field`, `validation_error`.

Every failure carries a fixed, bounded, input-redacted message.

### 14.9 Immutability guarantees

Catalog metadata, catalog candidates, ranking evidence, review results,
confirmation/rejection results, and parsed review views are deeply frozen or
defensively isolated. A caller cannot mutate catalog identity, normalized query,
ranking evidence, candidate ordering, FDC identity, bundle release, confirmation
binding, or internal index state. Missing information is never converted into
zero, an empty success, a candidate zero, or an invented default.

### 14.10 Test-fixture limitations and non-goals

Phase 2 tests use the existing official-record fixtures and clearly labeled
**synthetic** matching fixtures. The checked-in fixtures are **not** a production
USDA catalog, and no production USDA bundle or dataset is committed. Phase 2 does
NOT add or enable: a production dataset/bundle, a downloader/generator, automatic
release discovery, filesystem acquisition, a live API/API key, a network
route/request, Open Food Facts, branded/barcode matching, AI/provider calls, web
search, density or count-weight conversion, nutrient multiplication/summation, a
calculation engine, per-serving nutrition, `%DV` beyond the existing Phase 0
helper, `codex_nutrition` construction/persistence, frontmatter modification,
vault reads/writes, UI, an Advanced Nutrition page, Apply, automatic
confirmation, Vault Intelligence integration, bulk processing, or any change to
the legacy/simple nutrition engine or deployed behavior. The documentation does
not claim matching precision beyond what tests demonstrate, and it does not mark
Phase 3, Phase 4, Phase 5, or Phase 6 as implemented.

`advancedNutritionApplicationAuthorization()` and `canApplyNutritionEstimate`
remain globally fail-closed.
