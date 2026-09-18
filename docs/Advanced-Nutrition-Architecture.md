# The Kitchen Codex — Advanced Nutrition Architecture

Status: **Phase 0, Phase 1, Phase 2, Phase 3, and Phase 4 implemented (offline
contracts, isolated review layer, an isolated advisory calculation layer, and an
isolated advisory review/display UI layer), plus Phase 4.5A (a pinned,
reproducible canonical USDA bundle artifact generated offline) and Phase 4.5B
(authenticated, explicit-user-intent browser runtime loading of that exact
bundle into a genuine Phase 4 session), Phase 4.5C (US customary portion
resolution and an explicit total-weight fallback), plus Phase 4.5D (a
home-recipe eligibility boundary, corrected exact-unit parsing, a closed
query-role projection, anchor/contradiction/qualifier ranking, bounded culinary
aliases, and the hamburger acceptance corpus), plus Phase 4.5E (authenticated
count-portion resolution: the derived-mass contract, a closed count-identity
vocabulary, explicit size constraints, ambiguity handling, and full bypass
resistance), plus Phase 5A (an isolated Apply-authorization boundary that
reconstructs a canonical schema-v1 `codex_nutrition` persistence candidate from
genuine current authority and returns a closed AUTHORIZED / NOT AUTHORIZED
result), plus Phase 5B (an explicit, user-triggered Apply that immediately
re-proves the Phase 5A authorization at the write boundary and performs a
vault-safe whole-block `codex_nutrition` create/replace through the existing
recipe write path)**. No network route or live API is used. Phase 5A remains
pure/build-only (it writes nothing). Phase 5B is the ONLY Advanced Nutrition
surface permitted to persist, and only on an explicit user Apply: there is no
automatic, background, or on-open persistence. Phase 4.5E still performs no
persistence, no Apply, and never invents a count-to-mass conversion (it uses only
authenticated USDA source portions).

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
persist, apply, or touch any production surface.

Phase 3 adds an **isolated, advisory-only** calculation layer (§15): a trusted
calculation context, match/record rebinding, direct-mass and reviewed
source-portion mass resolution, entire-recipe totals with nutrient-specific
coverage, strict serving derivation, and derived-only `%DV`. It is NOT a
persistence or Apply layer, and it never writes `codex_nutrition`.

Phase 4 adds an **isolated, advisory review-and-display UI layer** (§16): a
lexically private Phase 4 session boundary, a separate compact Advanced Nutrition
card, a full-screen review modal, explicit ingredient-match and source-portion
review, deterministic basis/serving views, nutrient groups, nutrient-specific
coverage, ingredient evidence, and accessible/responsive interaction. It is a
DISPLAY layer only: it never writes `codex_nutrition`, modifies frontmatter, or
authorizes machine application. Phase 5A adds an isolated, build-only Apply
authorization boundary (§22) that constructs and validates the persistence
candidate without writing it. Phase 5B (explicit Apply/safe vault writes) and
Phase 6 (Vault Intelligence integration) remain unimplemented.

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
- **Phase 3 — advisory calculation engine and serving math.** DONE (offline,
  isolated, advisory-only): trusted calculation context, match/record rebinding,
  direct-mass and reviewed source-portion mass, entire-recipe totals with
  nutrient-specific coverage, strict serving derivation, and derived-only `%DV`
  (reusing `src/utils/servingMath.ts`). No persistence/Apply/UI. Audit gate:
  numeric regression review.
- **Phase 4 — simple card + Advanced Nutrition page.** DONE (offline, isolated,
  advisory review/display only): a lexically private Phase 4 session boundary, a
  separate compact Advanced Nutrition card, a full-screen review modal, explicit
  ingredient-match and source-portion review, deterministic basis/serving views,
  nutrient groups, nutrient-specific coverage, ingredient evidence, and
  accessible/responsive interaction. No persistence/Apply. Audit gate: UX/a11y
  review.
- **Phase 4.5D — home-recipe eligibility, exact-unit parsing, and matching
  correctness.** DONE (offline, isolated, review-only): an authentication-before-
  filtering home-recipe eligibility boundary (Fast Foods / Restaurant Foods
  categories plus a closed chain/context marker set), corrected exact-unit
  parsing, a closed query-role projection with deterministic anchors,
  contradiction/qualifier policy, bounded culinary aliases, no-padding ranking,
  and the hamburger acceptance corpus. No persistence, no Apply, no count-to-mass
  calculation. Audit gate: matching-correctness review.
- **Phase 4.5E — authenticated count-portion resolution.** DONE (offline,
  isolated, review-only): resolve count/culinary measures (`slice`, `clove`,
  `bun`, `piece`, …) to mass from an authenticated USDA source portion using the
  derived-mass contract `count / portionAmount × portionGramWeight`, with a closed
  count-identity vocabulary, explicit size constraints, ambiguity requiring
  explicit selection, deterministic unique resolution, and full bypass
  resistance. Still no density table, no invented count weight, no persistence,
  no Apply. Audit gate: count-portion correctness review.
- **Phase 5A — Apply authorization and persistence-candidate construction.**
  DONE (offline, isolated, build-only): a pure, platform-neutral authorization
  boundary that reconstructs the exact reviewed result from the genuine Phase 4
  session and current reviewed state, emits a canonical schema-v1
  `codex_nutrition` candidate (entire-recipe totals only), and returns a closed
  AUTHORIZED / NOT AUTHORIZED result with bounded, input-redacted failures.
  Authority is resolved through the module-private Phase 4 `SESSION_AUTHORITY`
  WeakMap for the exact receiver, so a structurally-complete forged session
  fails closed before any caller method is invoked. Stale authority fails
  closed; a caller-supplied nutrition object is never authority; an opaque
  future schema is never authorized for overwrite. No write, no Apply control.
  Audit gate: authorization + provenance review.
- **Phase 5B — explicit Apply and safe vault writes.** DONE (application-layer,
  write boundary): one explicit user-triggered Apply that immediately re-proves
  the Phase 5A authorization at the write boundary, performs a whole-block
  `codex_nutrition` create/replace through the existing recipe write path,
  preserves unrelated frontmatter, fails closed on stale/forged/unknown/malformed
  input, and verifies the persisted block post-write. No automatic/background
  persistence. Audit gate: persistence + migration review.
- **Phase 5C — consolidation of the existing Nutrition & Macros experience.**
  Future: fold the existing simple Nutrition & Macros/AI estimator into the
  Advanced Nutrition model under explicit user intent. [DEFERRED]
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

---

## 15. Phase 3 — advisory calculation engine (isolated)

Phase 3 is an **isolated, pure, offline, ADVISORY-ONLY** layer under
`src/core/nutritionV2/calculation/`. It answers: given ingredients, reviewed USDA
identities, and defensible masses, what are the advisory entire-recipe totals,
coverage, per-serving values, and derived `%DV`? It is **not** re-exported from
`src/core/nutritionV2/index.ts` or `src/core/index.ts`, and no production UI,
route, provider, estimator, persistence path, or vault path may import it.

### 15.1 Implementation map

| Concern | Module |
| --- | --- |
| Closed contract, bounds, versions, failure taxonomy | `src/core/nutritionV2/calculation/types.ts` |
| Deterministic numeric policy (rounding/overflow/stable sum) | `src/core/nutritionV2/calculation/numeric.ts` |
| Strict serving derivation | `src/core/nutritionV2/calculation/servings.ts` |
| Derived-only `%DV` views | `src/core/nutritionV2/calculation/dailyValues.ts` |
| Mass + source-portion resolution | `src/core/nutritionV2/calculation/mass.ts` |
| Advisory engine (internal) | `src/core/nutritionV2/calculation/calculate.ts` |
| Context authority + public operations | `src/core/nutritionV2/calculation/context.ts` |
| Isolated barrel (not re-exported publicly) | `src/core/nutritionV2/calculation/index.ts` |
| Shared calculation-free serving formulas | `src/utils/servingMath.ts` |
| Shared calculation-free qualitative classifier | `src/utils/ingredientSemantics.ts` |
| Synthetic calculation fixtures (test-only) | `tests/fixtures/usdaCalculationFixtures.ts` |

### 15.2 Calculation-context authority

`createNutritionCalculationContext(manifest, records)` validates the Phase 1
manifest, validates every canonical record, verifies bundle identity, record
count, canonical content digest, record digests, bundle/upstream releases,
nutrient-map/canonicalization versions, and unique FDC IDs, then builds a private
exact-ID record index and constructs its own genuine Phase 2 review catalog from
the same inputs. Construction is all-or-nothing.

Authority is **lexically private**: the registry is a module-local `WeakMap` with
non-exported registration/retrieval in the SAME module as
`createNutritionCalculationContext`, `calculateRecipeNutrition`, and
`reviewFoodPortions` (`context.ts`). No direct file-path import can register a
fake context or retrieve authority state; there is no exported registry, symbol,
token, brand, constructor, callback, or authority object. Structural fakes,
clones, wrappers, proxies, and inherited objects are rejected with
`invalid_context`. Authoritative records and the internal match catalog are never
exposed. The unkeyed digest provides integrity only.

### 15.3 Match and record rebinding

Every ingredient is re-parsed and re-reviewed against the context's internal
genuine current catalog. A current `matched_exact` supplies the food identity as
an **automatic unique-exact identity** (never `user_confirmed: true`). A
`review_required` result contributes only when the supplied review's digest equals
the current review's digest, `confirmIngredientReview` succeeds against the
internal genuine current catalog, the confirmed FDC id is in the reconstructed
current candidate set, and the selected candidate's record digest equals the
context's canonical record digest. Rejected/missing/stale/forged/invalid
confirmations contribute nothing (`ambiguous`); hostile selections reject the
whole request. `unmatched` → `no_match`. A selected record absent from the private
index or with a mismatched digest rejects the whole request.

### 15.4 Ingredient digest

The preview carries `ingredient_digest` = `sha256:<64 lowercase hex>` over the
strict Phase 1 canonical serialization of every calculation-affecting ingredient
field, including ingredient order, line reference, original bounded text, parsed
amount, raw/normalized unit, normalized query, note, current match outcome,
selected FDC id, selected record digest, confirmation digest, and any
source-portion selection/digest. Missing versus zero, `undefined` versus `null`,
`-0` versus `0`, string versus number, reordered arrays, changed preparation text,
and changed match/portion authority all remain distinct.

### 15.5 Mass and source-portion resolution

Only two mass sources exist: `direct_mass` (the existing deterministic g/kg/oz/lb
conversion, finite non-negative amount; explicit `0` resolves to zero grams;
negatives/`-0`/non-finite are rejected) and `source_portion` (an explicitly
reviewed portion of the selected canonical record:
`ingredient amount / source portion amount × source gram weight`). No density,
count weight, invented portion amount, or volume/count-to-mass inference is used.
A portion may be used only when the selection is reconstructed exactly against
the current canonical record (calculation version, line reference, ingredient
identity digest, bundle release, FDC id, record digest, candidate-set digest,
portion index/amount/measure/modifier/gram weight). FNDDS portions with a
legitimately absent source amount yield `no_mass`. `reviewFoodPortions` returns a
bounded, pure portion-review result listing canonical candidates. No portion
decision is persisted.

### 15.6 Nutrient calculation and nutrient-specific coverage

For each scoped nutrient and material ingredient: contribution =
`amount_per_100g × resolved grams / 100`. Missing source nutrients remain absent;
an explicit source zero is covered evidence contributing zero. Coverage is
per-nutrient: `measurable_ingredient_count` = non-qualitative material
ingredients; `covered_ingredient_count` = those with authoritative identity,
defensible mass, and a present source value; `coverage = covered / measurable`;
`complete` requires `covered === measurable` and `coverage === 1`; `partial`
requires at least one contribution and `covered < measurable`; `covered === 0`
omits the nutrient entirely (never a synthesized zero). Qualitative ingredients
do not enter the denominator but remain explained per ingredient. With no
material ingredients the preview is `unresolved` (no zero-denominator coverage).

Ingredient outcome precedence is closed: invalid/unsafe input rejects the whole
request; then `qualitative`, `no_match`, `ambiguous`, `no_mass`,
`no_nutrition`, `calculated`. One scoped nutrient missing from one food reduces
coverage only for that nutrient.

### 15.7 Numeric and rounding policy

Internal contribution arithmetic uses binary floating-point full precision;
reject NaN/Infinity/negatives/`-0`; detect multiplication/division/summation/
serving-scaling overflow; enforce the Phase 0 absolute bound (`1e9`); no clipping;
no fallback to zero; deterministic stable summation in a canonical order (sorted
by line reference) so totals are independent of request-array iteration order.

Canonical totals are rounded EXACTLY ONCE at the canonical total boundary by
evaluating the current IEEE-754 binary number with
`Math.round(value * 1_000_000) / 1_000_000`. ECMAScript `Math.round` selects the
nearest integer and resolves an exact represented half-integer toward positive
infinity; because Phase 3 rejects negatives, an exact represented non-negative
half-integer rounds upward. This is **binary floating-point arithmetic, not
decimal arithmetic**: a source value that appears to be a conceptual decimal half
may be represented slightly below or above that tie, so no independent decimal
half-away-from-zero guarantee is claimed. Totals are limited to at most six
decimal places after the rounding operation; rounding never turns a missing
nutrient into an explicit zero. Invalid and overflow values fail closed.

### 15.8 Totals-only baseline and serving derivation

The authoritative baseline is ALWAYS `basis: 'total'`. Per-serving
(`total / baseServings`) and requested-serving
(`total × requested / baseServings`) values are DERIVED, never persisted, always
from the same immutable total baseline (no drift on repeated toggles). Serving
counts are validated strictly (number only, finite, positive, not `-0`, `<= 1000`,
bounded decimal precision); strings such as `"4"` are rejected, never coerced.
Coverage does not change with serving scaling; only present nutrient amounts
scale. The shared formulas live in `src/utils/servingMath.ts` (the legacy
`src/utils/nutrition.ts` coerces first, preserving its historical behavior, then
uses the same `servingFactor`).

### 15.9 Derived-only Daily Values

`%DV` is always derived at read time from the pinned `fda_adult_4plus_2020`
standard and is NEVER stored in the advisory preview or any persisted schema.
Missing nutrients are unavailable (never `0%`); an explicit calculated zero
yields `0%` when the nutrient has an established DV; nutrients without a DV keep
the existing unavailable reason. Form-qualified units are never reinterpreted and
IU is never converted.

### 15.10 Advisory preview contract

The preview is a distinct immutable type (never `CodexNutritionV1`): calculation
schema/version, bundle release, catalog digest, nutrient-map version, servings,
ingredient digest, explicit nutrient scope, `basis: 'total'`, status
(`complete | partial | unresolved`), entire-recipe nutrient totals with coverage,
per-ingredient evidence, unresolved explanations, `advisory_only: true`, and
`application_authorized: false`. It contains NO `codex_nutrition` key, NO Phase 0
`schema: 1` marker, NO persistence instructions, and NO generated `computed_at`
timestamp. Automatic unique-exact matches are never presented as user-confirmed.
There is NO Apply/persistence converter.

### 15.11 Failure taxonomy

`invalid_context`, `invalid_request`, `unsafe_request`, `oversized_request`,
`unknown_field`, `empty_ingredients`, `too_many_ingredients`, `duplicate_line_ref`,
`invalid_line_ref`, `invalid_servings`, `invalid_nutrient_scope`,
`invalid_ingredient_input`, `invalid_portion_selection`, `numeric_overflow`,
`validation_error`. Every failure carries a fixed, bounded, input-redacted message.

### 15.12 Immutability and input safety

Every public untrusted boundary materializes once into inert data; accessors,
proxies/reflection failures, symbols, sparse arrays, cycles, non-plain prototypes,
functions/bigints/undefined, unknown fields, dangerous keys, and oversized values
fail closed with fixed bounded input-redacted errors. Context metadata, previews,
nutrient results, contribution arrays, ingredient evidence, unresolved entries,
portion reviews, confirmations, serving views, and DV views are deep-frozen or
defensively isolated; caller/returned mutation cannot change later results.

### 15.13 Isolation, limitations, and deferred work

Phase 3 is not wired into any production surface and is not re-exported from any
public barrel; a transitive import-graph test proves no Phase 3 path reaches the
legacy calculation engine (`deterministicNutrition.ts`), the curated food
reference (`foodReference.ts`), UI, server, persistence/vault, provider/network,
or test fixtures. Phase 3 tests use clearly labeled synthetic fixtures; the
checked-in fixtures are NOT a production USDA catalog and no production bundle
exists. Phase 3 does not claim medical accuracy. `%DV` remains derived-only.
Phase 4 (UI / Advanced Nutrition page) is implemented as an isolated advisory
review/display layer (§16); Phase 5 (explicit Apply/persistence) remains deferred
and unimplemented; `advancedNutritionApplicationAuthorization()` and
`canApplyNutritionEstimate` remain globally fail-closed.

---

## 16. Phase 4 — advisory review and display UI (isolated)

Phase 4 is an **isolated, offline, ADVISORY REVIEW AND DISPLAY ONLY** layer. It
consumes the trusted Phase 1–3 contracts without weakening them and adds a
separate compact card plus a full-screen review modal. It NEVER creates or
persists `codex_nutrition`, modifies Markdown/frontmatter, writes a recipe or
vault file, enables Apply, or authorizes machine application. Phase 5 remains
responsible for explicit Apply/persistence.

### 16.1 Implementation map

| Concern | Module |
| --- | --- |
| Closed contract, bounds, failure taxonomy, state types | `src/core/nutritionV2/phase4/types.ts` |
| Lexically private session authority + public operations | `src/core/nutritionV2/phase4/session.ts` |
| Narrow hostile-input materialization (own-data reads) | `src/core/nutritionV2/phase4/materialize.ts` |
| Hardened recipe adaptation + stable line references | `src/core/nutritionV2/phase4/adapt.ts` |
| Explicit UI state machine (reducer) | `src/core/nutritionV2/phase4/state.ts` |
| Nutrient groups, basis/serving derivation, `%DV`, units | `src/core/nutritionV2/phase4/display.ts` |
| Stored-block trust projection | `src/core/nutritionV2/phase4/stored.ts` |
| Bound source-portion choice construction | `src/core/nutritionV2/phase4/portion.ts` |
| Review rows + calculation request builder | `src/core/nutritionV2/phase4/rows.ts` |
| Isolated barrel (not re-exported publicly) | `src/core/nutritionV2/phase4/index.ts` |
| Compact card + full modal (React) | `src/components/AdvancedNutritionCard.tsx`, `src/components/AdvancedNutritionModal.tsx` |

### 16.2 Session trust boundary

`createAdvancedNutritionSession(manifest, records)` builds a genuine session
all-or-nothing from a valid Phase 1 manifest, its canonical records, a genuine
Phase 3 calculation context, and a genuine Phase 2 review catalog created from
the SAME manifest and records. Construction fails closed (`invalid_session`) on
any mismatch, including a catalog/context digest mismatch. The session exposes
only bounded review/display results and user-intent operations:
`metadata()`, `reviewIngredient()`, `reviewPortions()`, `confirmMatch()`, and
`calculate()`. It never exposes canonical food records, the internal record
index, the genuine Phase 2 catalog, or any authority state.

Authority is **lexically private**: a module-local `WeakMap` with non-exported
registration/retrieval in the SAME module as the factory. Operations resolve
authority only for the exact receiver object (`this`), so a structural fake,
clone, spread object, proxy, inherited object, wrapper, primitive, or `null`
cannot impersonate a genuine session and fails closed. No registry, blessing
token, symbol, brand, key, callback, or constructor is exported. The unkeyed
digest proves deterministic integrity, not authenticity.

### 16.3 Honest production availability

**Historical (pre-4.5B).** Before Phase 4.5B, no production USDA bundle was wired
into the runtime. The UI supported an injected genuine session, but production
composition did NOT fabricate one: the compact card was shown, trusted local USDA
source data were reported unavailable in that build, the review/calculation
controls were unavailable, and no fixture, curated reference, AI estimate, empty
catalog, or invented preview was substituted.

**Phase 4.5B (current).** The browser application now supplies a genuine session
from the exact checked-in production bundle, but ONLY after an explicit user
action authenticates it against the source-controlled release lock (§18). Until
then the card shows an honest idle state; while loading it shows a calm
authenticating state; on failure it shows a fixed, bounded failure state with an
explicit retry; and on an unsupported runtime it reports that safely. The wording
remains calm and never describes the recipe as erroneous, and no fallback data
are ever substituted. The Obsidian plugin shell does not expose the full card and
gains no bundle-loading behavior in this phase. The injection boundary still lets
a future audited composition supply the session without rewriting the React UI.

### 16.4 Recipe adaptation, hostile-input materialization, and invalidation

`adaptRecipe(recipeRaw)` is the exported adaptation boundary and treats its
runtime input as `unknown`. The narrow adaptation envelope (only `title`, the
identity fields, `servings`, and `ingredients`) is materialized ONCE into inert
bounded data before any property is used; unrelated recipe fields (full Markdown,
file handles, frontmatter, platform objects) are never touched or materialized.
Ingredients are materialized once before Phase 4 reads or forwards them, using a
closed whitelist for the authoritative adaptation shape. The boundary preserves
ingredient order, assigns deterministic unique line references
(`ing:<index>:<content-digest>`), preserves the original bounded ingredient text,
and never mutates the recipe. The Phase 2 parser/normalizer owns measurement
derivation; Phase 4 never reinterprets notes/preparation text as mass, infers
volume→mass or count→mass, or treats a qualitative ingredient as measurable.

Accessors/getters/setters, proxies/reflection failures, symbol keys, sparse
arrays, cycles, non-plain prototypes, functions, bigints, present-`undefined`
own fields, dangerous keys, and oversized inputs fail closed with a fixed,
bounded, input-redacted Phase 4 failure (`unsafe_request` / `invalid_recipe` /
`unknown_field`); no hostile getter is invoked and no attacker exception object
or message can escape or be rendered. A hostile/malformed/empty/oversized recipe
is never converted into an empty successful adaptation, and a failed adaptation
cannot proceed to matching, review rows, or calculation. The same guarded
own-data read is used for the stored `codexNutrition` block before it is
materialized and projected for display.

The review key combines the stable recipe identity with a digest of the adapted
line references, so a recipe OR ingredient change invalidates all stale match
choices, portion choices, and previews. Changing only the display basis or
requested serving count never reruns matching and never mutates the total
baseline.

### 16.5 Matching and source-portion review

The modal shows one row per ingredient with the authoritative current outcome
(unique exact / review required / unmatched / qualitative / invalid / none
selected). Ambiguous rows show the bounded deterministic candidate set (food
description, data type, FDC ID, match class, concise ranking evidence) and
require an explicit choice, including an explicit “None of these”. Nothing is
preselected; hover/focus/opening/keyboard navigation never confirm. Automatic
unique-exact matches are labeled as automatic and never `user_confirmed`. Source
portions are shown only through the genuine Phase 3 context; a legitimately
amount-less FNDDS portion remains unusable (never invented as `1`), and the final
binding is built from the current review, record digest, candidate-set digest,
ingredient identity digest, and selected portion (`buildPortionChoice`). A match
change invalidates its portion; a portion change invalidates the preview.

### 16.6 Advisory calculation and display

Calculation is an explicit user action (`Calculate Preview`); it never runs on
modal open. The result is an `AdvisoryNutritionPreview` — never `CodexNutritionV1`
— and the UI adds no `schema: 1`, `codex_nutrition`, `computed_at`, persistence
instructions, application authorization, or Apply/Save control. The preview is
prominently labeled “Advisory nutrition preview”, shows the bounded USDA bundle
identity, preview status, ingredient digest, nutrient scope, unresolved count,
and a concise not-medical-advice statement, and is never shown as current after
any calculation-affecting change.

The authoritative baseline is always the immutable Phase 3 entire-recipe total.
`Entire recipe`, `Per serving`, and `Selected servings` are derived through the
shared `src/utils/servingMath.ts` helpers; repeated toggling cannot drift.
Requested servings are validated with the Phase 3 rules (number only, finite,
positive, not `-0`, `<= 1000`, bounded precision). All 34 registered nutrients
are grouped exactly once (energy/macros, fats/cholesterol, carbohydrates/sugars,
minerals, vitamins); missing nutrients display unavailable (never zero), an
explicit zero displays zero, partial coverage is marked, and `%DV` is derived for
the currently displayed amount (nutrients without a DV stay unavailable, never
`0%`). `ug` renders as `µg`; form-qualified units keep their RAE/NE/DFE meaning.
A recognized stored `codex_nutrition` block is validated before trusted display;
an opaque future schema is preserved but not interpreted.

### 16.7 UI state, accessibility, and isolation

A closed reducer owns the workflow (unavailable / ready / preview current /
preview stale / invalid). It invalidates a portion when its match changes,
invalidates the preview on any calculation-affecting change, ignores stale
operation results, and treats basis/serving changes as display-only. The modal
provides `role="dialog"` + `aria-modal="true"`, a named dialog, initial focus,
keyboard-operable controls, Escape close, focus containment, focus restoration,
visible focus styles, associated labels, radio semantics for mutually exclusive
choices, restrained `aria-live` status, non-color-only status, reduced-motion
compatibility, and responsive layouts. No accessibility dependency is added.

Phase 4 imports Phase 1–3 only through its dedicated session boundary. A
dependency-graph security test permits exactly UI components → Phase 4
orchestration/session → Phase 1–3 pure modules; the reverse direction and every
persistence/network/vault/server/provider/fixture path fail the graph test. No
nutrition core imports React/UI, no production code imports test fixtures, and
`advancedNutritionApplicationAuthorization()` and `canApplyNutritionEstimate`
remain globally fail-closed.

### 16.8 Tests, limitations, and deferred work

Phase 4 tests cover session authority (genuine/fake/clone/spread/proxy/inherited/
wrapper/null/primitives/hostile getters, identity binding, cross-session
rejection), hostile-input adaptation (throwing recipe/ingredient getters with
non-execution counters, getters returning plausible values, setter-only and
non-enumerable accessors, unknown-field getters, proxies with `get`/`ownKeys`/
`getOwnPropertyDescriptor`/`getPrototypeOf` traps, symbol keys, sparse arrays,
direct/indirect cycles, class instances, null-prototype acceptance, present
`undefined`, explicit `null`, functions, bigints, dangerous keys, oversized
text/counts, primitive/missing/non-array inputs, missing-vs-zero and `-0`-vs-`0`,
and post-adaptation source mutation), matching review (no auto-selection,
explicit candidate/none, exact-not-user-confirmed, stale rejection,
match→portion invalidation), source-portion workflow (no auto-selection, absent
amount unusable, no invented amount/density, stale digest rejection), UI state
(recipe/ingredient invalidation, basis/serving display-only, stale-result
rejection, StrictMode, honest unavailability, hostile-recipe failure
containment), display (34 nutrients grouped once, missing vs zero, partial vs
complete, coverage counts, no-DV nutrients, `%DV` from the displayed amount,
units/`µg`, total/per/selected values, malformed/opaque stored blocks),
accessibility (roles/names/keyboard/focus/Escape/status), and security (no
persistence/vault/Markdown/network/provider/fixture import, disabled gates, no
Apply/Save, bounded input-redacted failures, import-graph direction).

The checked-in fixtures are NOT a production USDA catalog and no production
bundle exists. Phase 4 does not claim medical accuracy, individualized dietary
advice, or complete nutritional coverage when coverage is partial. Phase 5
(explicit Apply/persistence) and Phase 6 (Vault Intelligence integration) remain
deferred; machine application remains disabled.

---

## 17. Phase 4.5A — trusted local bundle generator and reproducible artifact

Phase 4.5A implements the separately audited local acquisition/generation
prerequisite identified in §13.13. It is **build-time/offline tooling only**: it
produces one deterministic canonical bundle artifact and a strict offline
verifier, but it is **not** wired into `App.tsx`, React, the browser, the plugin,
or Phase 4 session composition. Phase 4 therefore remains honestly unavailable
in production until the next separately audited runtime-composition slice.

The generator/verifier are split into reusable implementation modules
(`generate.ts`, `verify.ts`, no import side effects) and entry-only executables
(`generate.cli.ts`, `verify.cli.ts`, each unconditionally invoking its runner).
Package scripts point directly at the entry modules. A separate, immutable,
source-controlled **release trust lock** (`src/core/nutritionV2/usda/releaseLock.ts`)
lives outside the generated artifact and makes verification authenticity-bearing
rather than merely self-consistent.

### 17.1 Source archive identities

Only the three pinned official USDA FoodData Central downloads are consumed.
Each archive is verified by exact SHA-256 before extraction or parsing:

| Data type | Release | Archive | SHA-256 |
| --- | --- | --- | --- |
| `foundation` | April 2026 | `FoodData_Central_foundation_food_json_2026-04-30.zip` | `186e988ec542e913f51ef62b86a47758e8cdd0d1dc3889e7b055581f3c09c77a` |
| `sr_legacy` | final April 2018 | `FoodData_Central_sr_legacy_food_json_2018-04.zip` | `0fe8ae486a2c8eb42cb96413f058deb51863a46c8fb8eeb4b1fb45006dd338ef` |
| `fndds` | FNDDS 2021–2023 (2024-10) | `FoodData_Central_survey_food_json_2024-10-31.zip` | `dfb06ae7ddc397ccd570b91c14b75438ab2ba39f64f22d321f61d4a52a77f3eb` |

Official source URLs are exactly the `https://fdc.nal.usda.gov/fdc-datasets/…`
URLs recorded in the Phase 1 provenance and satisfy the manifest URL policy
(HTTPS, exact USDA host, no credentials/query/fragment).

### 17.2 Secure local acquisition boundary

The generator is offline and accepts explicit local archive paths
(`--foundation`, `--sr-legacy`, `--fndds`, `--out`). It never downloads, never
searches the filesystem, never reads environment archive paths, rejects duplicate
paths, and rejects directories, non-regular files, and symlinks. A human/auditor
separately downloads the archives to `/tmp` and passes their exact paths.

Secure ZIP extraction (`scripts/usda_bundle/zip_extract.py`, Python standard
library only, no new dependency) rejects, with fixed bounded codes: encrypted
members, symlinks and unusual member types, absolute paths, `..` traversal,
backslash ambiguity, drive letters, NULs, duplicate/case-colliding member names,
unexpected members, oversized members, and compression-ratio breaches; it
validates the member CRC while streaming to EOF, writes only into a freshly
created directory, refuses overwrite, and removes partial output on failure. No
Python code performs canonical adaptation, numeric conversion, digest
construction, or manifest generation.

**Same-open-descriptor ZIP binding (TOCTOU repair).** The exact bytes that are
hashed are the bytes that are opened as a ZIP archive. The helper opens the
source archive exactly once with low-level no-follow semantics (`O_NOFOLLOW`
where available), `fstat`s the open descriptor and requires a regular file, and
stream-copies that same descriptor (hashing as it copies) into a newly created
private temporary file inside a private, fresh staging directory — fixed
private filename, mode `0600`, exclusive creation (`O_CREAT | O_EXCL`), bounded
archive size. The pinned SHA-256 is compared against the bytes just copied; on
mismatch the private copy is rejected and deleted. Only that private verified
copy is ever reopened for `zipfile.ZipFile`; the original caller pathname is
never reopened for ZIP parsing. Pathname replacement therefore cannot substitute
extraction bytes: a replacement before staging is either the file that gets
hashed (and fails the pinned digest) or is rejected, and in-place mutation during
copying yields a digest mismatch. The private copy is deleted during cleanup. On
platforms without `O_NOFOLLOW` the authoritative protection is the private
verified copy, not pathname stability.

### 17.3 Bounded streaming ingestion

`scripts/usda_bundle/stream_json.ts` reads the exact pinned top-level JSON
envelope (`FoundationFoods`, `SRLegacyFoods`, `SurveyFoods`) and yields one
complete root-array entry at a time as its exact JSON substring; the archive is
never parsed into one in-memory object. It correctly handles braces/brackets
inside strings, escaped quotes/backslashes, Unicode escapes, nested structures,
and whitespace, and rejects an unexpected/multiple root key, invalid root
structure, truncation, malformed syntax, trailing garbage, and oversized entries
(256 KiB bound) with fixed codes. Each entry is `JSON.parse`d once, passed
immediately into the production Phase 1 adapter, and released.

### 17.4 Deterministic identity and artifact layout

Generator identity is pinned (`the-kitchen-codex-usda-bundle`, schema `1`) and
the manifest timestamp is pinned to `2026-09-15T00:00:00.000Z` (reproducible
bundle-build metadata, not a USDA publication time). All ordering is explicit and
locale-independent. The bundle release is derived only through the existing Phase
1 manifest identity rules, so it changes whenever any component release, URL,
archive digest, generator schema, nutrient-map version, or canonicalization
version changes. The generated artifact is checked into the uncommitted working
tree at `data/advanced-nutrition/usda/<bundle_release>/` and contains exactly:
`manifest.json`, `artifact.json`, `records.foundation.json.gz`,
`records.sr_legacy.json.gz`, `records.fndds.json.gz`. No raw or uncompressed USDA
dataset is committed.

Each shard is the canonical record array for one data type, sorted by numeric FDC
id ascending (then record digest), serialized with the strict Phase 1
`canonicalStringify`, UTF-8 encoded with no BOM/indentation/trailing newline, and
gzip-compressed at a pinned level with the gzip MTIME zeroed and the OS byte fixed
to 255. `artifact.json` is a strict closed descriptor (no local paths, host/user,
timestamps, extensions, or self-digest).

**Why `bundle_release` alone does not bind canonical content.** The bundle
release is derived only from authoritative *inputs* (manifest schema, generator
schema, data types, each component release/URL/archive digest, nutrient-map
version, canonicalization version). It deliberately excludes record content,
counts, and digests. It therefore proves *which inputs* produced a bundle, not
*what canonical records* the bundle contains: two artifacts with the same inputs
but different record content share a `bundle_release`. Binding canonical content
requires the external release lock below.

### 17.5 Generated artifact (exact bytes and digests)

Bundle release: **`usda_fdc_87c5408a3e98838944a87be74824761e`**.

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `manifest.json` | 1,573 | `3b4ee9888bda49ff705e9e38971621beac7a091fe0b53e1187e68d050e70e2ba` |
| `artifact.json` | 1,604 | `1e525d9423572ab202d80ed78ff05b7ec34899744f62b24664f8d32c4d0efd3b` |
| `records.foundation.json.gz` | 53,877 | `50bb6999d12b7c68f167509bc2d88d35ad9c2df9d6a03a9a7f89379323399709` |
| `records.sr_legacy.json.gz` | 1,456,503 | `2fa6be1ebefa1ffd2b70554e082237f15e14ce2c51302fdf00cde97ae6e3a876` |
| `records.fndds.json.gz` | 981,412 | `1a25a5d8c4e18fbca8e91d80a0b051860bad72aedb27486e8940699ad8158b2b` |

Total compressed: **2,491,792 bytes**; total uncompressed canonical:
**59,678,264 bytes**; canonical-content digest:
`dd9740bcf0efb577f0afd5b87ddb70a652384e4d7833947e83b30da8b39f67e4`.

### 17.6 Exact census

| Data type | Array entries | Null placeholders | Accepted | Rejected |
| --- | --- | --- | --- | --- |
| `foundation` | 395 | 32 | 353 | 10 `invalid_nutrient` |
| `sr_legacy` | 7,793 | 0 | 7,775 | 18 `invalid_portion` |
| `fndds` | 5,432 | 0 | 5,431 | 1 `no_supported_nutrients` |

Combined: **13,559** accepted canonical records, **29** rejected non-null
records, **32** Foundation null placeholders. The 18 rejected SR Legacy FDC ids
are exactly `168789, 168790, 168796, 169239, 169617, 169621, 171056, 171062,
171073, 171300, 171450, 171452, 171453, 171472, 171475, 171492, 172252, 173509`.
The manifest preserves the census with explicit deterministic warnings
(`foundation_null_placeholder: 32`, `rejected_invalid_nutrient: 10`,
`rejected_invalid_portion: 18`, `rejected_no_supported_nutrients: 1`); distinct
failure classes are never collapsed. The manifest validates with the existing
Phase 1 validator, and the immutable exact-ID store is constructed from the final
manifest and complete record set as an end-to-end check.

### 17.7 Reproduction and verification

Reproduce (after a human downloads and verifies the archives under `/tmp`):

```
bun run generate:usda-bundle -- \
  --foundation /tmp/FoodData_Central_foundation_food_json_2026-04-30.zip \
  --sr-legacy  /tmp/FoodData_Central_sr_legacy_food_json_2018-04.zip \
  --fndds      /tmp/FoodData_Central_survey_food_json_2024-10-31.zip \
  --out        data/advanced-nutrition/usda/<bundle_release>
```

The generator exits `0` **only** after it has written its requested output and
verified that exact output against the release lock. On any failure it removes
the just-written, unverified output and exits nonzero with a fixed bounded code.

Verify the checked-in artifact against the built-in release lock (no network):

```
bun run verify:usda-bundle
```

Verify an explicit directory (documented option):

```
bun run verify:usda-bundle -- --dir /tmp/<fresh-output>
```

Three independent real runs were performed and are byte-for-byte identical
(§17.12). The authenticity-bearing verifier resolves the expected file set from
the release lock, re-lists the directory (rejecting missing/extra/case-colliding/
symlinked entries), hashes and measures `artifact.json` **before** trusting it,
requires its exact locked length and SHA-256, safely parses and validates it,
requires every authoritative descriptor field to match the lock, hashes and
measures `manifest.json` against the lock, validates it and compares every
authoritative field, verifies every compressed shard against **both** the lock and
the descriptor, bounded-decompresses each shard, verifies uncompressed
length/hash against both, validates every canonical record and record digest,
recomputes counts and the canonical-content digest (requiring lock equality),
reconstructs the exact-ID store, and returns success only when the entire locked
release matches. It never trusts a filename, count, digest, or uncompressed
length merely because it appears in `artifact.json`, and it does not accept a
caller-supplied replacement lock, environment override, query, or CLI flag.

### 17.8 Size budget and licensing

Hard limits: manifest/descriptor ≤ 64 KiB each; compressed shard ≤ 16 MiB; total
compressed ≤ 32 MiB; uncompressed shard ≤ 128 MiB; total uncompressed ≤ 256 MiB;
≤ 20,000 records; verifier decompression ratio ≤ 200; ZIP member count ≤ 16,
member uncompressed ≤ 256 MiB, member compressed ≤ 64 MiB, ZIP ratio ≤ 400. The
genuine output (2.49 MiB compressed / 59.68 MiB uncompressed) is well within
budget. No Git LFS is used. USDA FoodData Central data are public domain / CC0
1.0; the requested attribution is preserved verbatim in the manifest and
descriptor.

### 17.9 Integrity versus authenticity

These are distinct trust properties, and Phase 4.5A keeps them distinct:

* **Archive authenticity** comes from the separately verified official
  acquisition process plus the pinned source archive filenames, official HTTPS
  URLs, releases, and SHA-256 values (§17.1). A SHA-256 digest proves
  identity/integrity against a pinned expected value; it does **not**, by itself,
  prove USDA authorship.
* **Deterministic generation** means the same verified inputs produce the same
  bytes under the tested toolchain (§17.12).
* **Artifact internal integrity** is accidental-corruption self-consistency: the
  artifact's own embedded digests agree with each other. This is what the
  explicitly-named, non-authoritative `verifyBundleDirectoryIntegrityOnly` checks.
* **Artifact authenticity** is verified against the source-controlled release
  lock (§17.10) and is what the exported `verifyBundleDirectory` and the package
  verifier command do.

**Why a fully recomputed artifact still fails locked verification.** The artifact
is self-describing: a forger can change a canonical record, recompute the record
digest, re-canonicalize and recompress the shard, recompute the compressed and
uncompressed lengths/hashes, the canonical-content digest, the manifest bytes and
hash, and the artifact descriptor values and hash — producing a *fully
self-consistent* artifact that passes integrity-only verification. It still fails
locked verification because the release lock pins the audited exact production
byte lengths, SHA-256 values, canonical-content digest, record counts, and warning
counts independently of the artifact. Permanent regressions prove this for both a
semantically changed canonical description and a nutrient amount changed within
valid numeric bounds, and for every individual locked comparison (artifact hash,
manifest hash, canonical-content digest, compressed shard hash, uncompressed shard
hash, locked count/warnings).

**Deliberate lock updates.** The generator never silently updates the release
lock. A future USDA release or generator-version change requires a manual,
reviewed edit of `src/core/nutritionV2/usda/releaseLock.ts` and of the tripwire
test expectations, followed by a full re-audit and test run. The tripwire test
fails until that deliberate review happens.

No raw archive, extracted raw JSON, temporary shard, log, or report is committed,
and no production bundle loader is introduced in this phase. Phase 4 continues to
report the honest unavailable state, and Phase 5 remains disabled.

### 17.10 Source-controlled release trust lock (exact pinned values)

`src/core/nutritionV2/usda/releaseLock.ts` is immutable, data-only, imports
nothing (no Node/filesystem/child-process/ZIP/Python/React/application/platform
module), lives outside the generated artifact directory, is never generated into
or read from that directory, is never caller-supplied at verification time, and
accepts no environment/query/CLI overrides. It pins the independently audited
exact production release:

* lock schema `1`; bundle release `usda_fdc_87c5408a3e98838944a87be74824761e`;
* generator `the-kitchen-codex-usda-bundle` schema `1`; pinned build timestamp
  `2026-09-15T00:00:00.000Z`; nutrient-map `usda_fdc_nutrient_map_v2`;
  canonicalization `usda_canonical_v1`;
* the three source archive filenames, official URLs, releases, and SHA-256 values
  from §17.1;
* exact artifact filename set (`artifact.json`, `manifest.json`,
  `records.foundation.json.gz`, `records.sr_legacy.json.gz`,
  `records.fndds.json.gz`);
* canonical record count `13,559`; rejected non-null `29`; Foundation null
  placeholders `32`;
* canonical-content digest
  `dd9740bcf0efb577f0afd5b87ddb70a652384e4d7833947e83b30da8b39f67e4`;
* `manifest.json` 1,573 bytes / `3b4ee9888bda49ff705e9e38971621beac7a091fe0b53e1187e68d050e70e2ba`;
  `artifact.json` 1,604 bytes / `1e525d9423572ab202d80ed78ff05b7ec34899744f62b24664f8d32c4d0efd3b`;
* per shard (compressed bytes / SHA-256; uncompressed bytes / SHA-256; record
  count):

  | Shard | Compressed | Compressed SHA-256 | Uncompressed | Uncompressed SHA-256 | Records |
  | --- | --- | --- | --- | --- | --- |
  | `records.foundation.json.gz` | 53,877 | `50bb6999d12b7c68f167509bc2d88d35ad9c2df9d6a03a9a7f89379323399709` | 958,025 | `5082031987b75d388880b8d416b4c3cacd3ee4f7c227a2717d1cedfdc6b043e6` | 353 |
  | `records.sr_legacy.json.gz` | 1,456,503 | `2fa6be1ebefa1ffd2b70554e082237f15e14ce2c51302fdf00cde97ae6e3a876` | 33,695,908 | `e916f71396f4f55db04365e4b622fdfa3ec8006d499ed67789434e4e5d213f35` | 7,775 |
  | `records.fndds.json.gz` | 981,412 | `1a25a5d8c4e18fbca8e91d80a0b051860bad72aedb27486e8940699ad8158b2b` | 25,024,331 | `426e6e2642bcccfe64c2f86e831ef9c272b3def9829e25a17f179b283a055fc7` | 5,431 |

* totals: compressed `2,491,792`; uncompressed `59,678,264`;
* exact warning codes/counts (`foundation_null_placeholder: 32`,
  `rejected_invalid_nutrient: 10`, `rejected_invalid_portion: 18`,
  `rejected_no_supported_nutrients: 1`);
* requested USDA attribution (verbatim).

### 17.11 Executable CLI boundary

The published package commands are entry-only modules that unconditionally invoke
their runners:

```
bun run generate:usda-bundle -- --foundation <path> --sr-legacy <path> --fndds <path> --out <path>
bun run verify:usda-bundle
bun run verify:usda-bundle -- --dir <path>
```

`generate.ts` and `verify.ts` expose reusable logic with no import side effects
and are never CLI entry points. Exit code is nonzero on invalid arguments or
failure and zero only after the requested operation succeeds; rejected promises
and synchronous exceptions are contained and converted to fixed bounded
diagnostics that never echo an attacker exception message or a local path. There
is no successful no-op path. Entry modules are never imported by production code
or test helpers (tests exercise them as real subprocesses).

### 17.12 Tested reproducibility scope

Three real generation runs were executed and compared:

* **Run A** — repository working directory, default locale/timezone, ordinary
  named-flag order.
* **Run B** — working directory outside the repository, absolute entry-script
  paths, reversed named-flag order, `LC_ALL=C`, `TZ=UTC`, different temporary and
  output directory names.
* **Run C** — a different fresh working directory, `TZ=America/New_York`,
  different output path, repeated generation from the same verified archives.

All three are byte-for-byte identical to each other and to the checked-in
candidate: same exact filename set, byte lengths, SHA-256 values, gzip headers
(`1f 8b 08 00 00 00 00 00 02 ff`), and parsed semantic content. Only the `C`
locale is installed on this host; the matrix used `LC_ALL=C` and did not test
additional locales. Reproducibility is scoped to the tested runtime/toolchain
(Bun 1.4.0, Node 22.22.1, Python 3.14.4, zlib via Node `node:zlib`). Cross-platform
or cross-zlib byte identity is **not** claimed.

### 17.13 Runtime loading (Phase 4.5A scope)

This section records the Phase 4.5A state. Phase 4.5B (§18) supersedes the
runtime-availability statement without changing the 4.5A tooling.

In Phase 4.5A: no production runtime imports the generator, verifier, Python,
filesystem, child process, or ZIP tooling; no artifact is copied to `public/`,
`dist/`, or plugin output; `App.tsx` injects no Phase 4 session; Phase 4 remains
honestly unavailable; Phase 5 remains unimplemented; and application gates remain
globally disabled. No archive or raw extracted JSON remains in the repository.

Phase 4.5B adds a browser runtime loader that authenticates and composes the
bundle on explicit user intent (§18). The generator/verifier/Python/ZIP tooling
still remains build-time/offline only and is never imported by any runtime.

---

## 18. Phase 4.5B — authenticated runtime bundle loading and Phase 4 composition

Phase 4.5B is the separately audited runtime-composition slice that Phase 4.5A
explicitly deferred. It activates the **full browser application's existing
Advanced Nutrition card**: on explicit user intent it authenticates the exact
checked-in production bundle against the source-controlled release lock and
composes one genuine existing `AdvancedNutritionSession`. It is **not** a
calculation/Apply/persistence phase. It never writes `codex_nutrition`, never
modifies Markdown/frontmatter, never writes a vault file, and never enables
machine application.

The intended user flow is:

```
Open Advanced Nutrition -> load and authenticate local bundle
  -> create genuine Phase 4 session -> review matches
  -> explicitly calculate advisory preview
```

It is never `open recipe/app -> calculate automatically -> save automatically`.

### 18.1 Implementation map

| Concern | Module |
| --- | --- |
| Pure authenticated decoder/composer (platform-neutral) | `src/core/nutritionV2/runtime/bundle.ts` |
| Pure bounded browser-native gzip + strict UTF-8 | `src/core/nutritionV2/runtime/gzip.ts` |
| Isolated runtime barrel (not re-exported publicly) | `src/core/nutritionV2/runtime/index.ts` |
| Fixed compile-time-owned browser asset URL map | `src/application/advancedNutritionBundleAssets.ts` |
| Fixed no-argument production loader (browser composition) | `src/browser/advancedNutritionBundle.ts` |
| Bounded same-origin static-asset fetch (browser platform) | `src/platform/browser/advancedNutritionBundleFetch.ts` |
| Lazy one-session React controller | `src/application-ui/useAdvancedNutritionBundle.ts` |
| Card loading/ready/failed/unsupported states | `src/components/AdvancedNutritionCard.tsx` |

The runtime composer is intentionally **not** re-exported from
`src/core/nutritionV2/index.ts` or `src/core/index.ts`. It imports only pure
Phase 1–4 core modules and the pure gzip helper: no React, application, browser,
Node, filesystem, child-process, ZIP, Python, server, provider, vault,
persistence, fixture, or `scripts/usda_bundle/` module.

### 18.2 Pure authenticated runtime decoder/composer

`composeAdvancedNutritionSessionFromBundle(inputs)` consumes a closed set of raw
byte inputs (`{ files: [{ name, bytes }] }`) through a narrow, testable
interface. Every supplied byte and every parsed value is untrusted; the
interface is read with own-data property descriptors only, so hostile getters and
proxy traps are never invoked. The composer authenticates the bundle
**exclusively** against the source-controlled `USDA_BUNDLE_RELEASE_LOCK`: no
caller-supplied lock, environment variable, URL, path, or replacement byte source
is accepted.

The success result exposes ONLY the genuine session, the bounded immutable
`session.metadata()`, and the locked USDA attribution. It never returns manifest
objects, canonical records, shards, stores, indexes, catalogs, or authority
material. Failures use a closed code vocabulary and fixed, bounded,
input-redacted messages (`advanced_nutrition_bundle_*`); URLs, paths, response
bodies, parsed content, and exception messages are never echoed.

Per-shard decoded validation is a **module-private implementation detail** of the
composer. It is not exported from `bundle.ts`, not re-exported from the runtime
barrel, and not reachable through any production import path; the runtime barrel
exposes no canonical-record-returning helper. There is no validator callback,
release-lock override, dependency injection, debug interface, symbol, or registry,
and the composer's signature accepts only the raw byte inputs.

### 18.3 Verification order (all-or-nothing, fail closed)

1. Require exactly the five logical inputs; reject missing, duplicate, unknown,
   and case-colliding logical filenames.
2. Enforce locked byte bounds while reading (exact locked lengths, not a declared
   `Content-Length`).
3. Verify the exact byte length and SHA-256 of `artifact.json` against the lock
   **before** trusting its contents.
4. Decode UTF-8 strictly, parse, validate the closed artifact schema, require
   canonical serialization, and compare every authoritative field with the lock.
5. Verify the exact byte length and SHA-256 of `manifest.json` against the lock
   before trusting it; decode strictly, parse, validate with the existing Phase 1
   manifest contract, require canonical bytes, and compare every authoritative
   field (including components, data types, warnings, and attribution).
6. For each shard in locked order: enforce the exact compressed length and
   SHA-256 **before** decompression; require a valid gzip stream; decompress with
   an independent incremental output ceiling; reject trailing, concatenated,
   truncated, and malformed gzip data; enforce the exact locked uncompressed
   length and SHA-256; decode UTF-8 strictly; parse as a JSON array; require
   canonical serialization; validate every canonical record; and require the
   expected data type, bundle release, upstream release, nutrient-map version,
   record count, and unique positive FDC identity.
7. Require the exact total count of 13,559 canonical records.
8. Recompute and compare the canonical-content digest
   `dd9740bcf0efb577f0afd5b87ddb70a652384e4d7833947e83b30da8b39f67e4`.
9. Cross-check artifact, manifest, shard, record, component, count, byte, digest,
   generator, timestamp, version, warning, and attribution identities against one
   another and the independent lock.
10. Call the existing Phase 4 session factory only after all authentication
    succeeds, then verify the resulting session metadata matches the locked
    release before returning success.

A fully recomputed, internally self-consistent forgery still fails: the
compressed shard SHA-256 (and, when changed, the artifact/manifest SHA-256) is
compared to the external lock before any decompression or trust.

**Decoder versus composer enforcement.** Standalone gzip decoder behavior differs
across runtimes: real Chrome's native `DecompressionStream('gzip')` rejects
trailing bytes and a concatenated second member, while Bun/Node may decode a
concatenated member. The authoritative composer therefore does **not** rely on
standalone decoder behavior. It checks the exact locked compressed length and
SHA-256 **before** decompression and the exact locked uncompressed length and
SHA-256 **afterward**, so trailing, concatenated, truncated, altered, or
substituted input cannot pass the complete locked composition boundary,
regardless of how a particular runtime's decoder behaves on its own.

### 18.4 Fixed browser asset source and delivery

The browser asset module contains ONLY a compile-time-owned URL map for the five
checked-in files for the locked release, paired with their logical locked
filenames. Vite emits each original file as a distinct content-hashed static
asset (`?url&no-inline`) whose bytes stay byte-identical to the checked-in
source; the module carries no payload, no base64, and no fetch logic. No
environment variable, setting, query parameter, local-storage entry, URL
parameter, API response, server route, user-selected directory, or caller
argument can replace these URLs, and there is no silent or fixture fallback.

The runtime delivery boundary is:

```
fixed compile-time URL map -> bounded same-origin fetch -> exact locked bytes
  -> unchanged authenticated composer -> genuine Phase 4 session
```

The loader confirms the safe gzip capability before requesting the dataset,
resolves each fixed URL against the current document, requires same-origin,
rejects URLs carrying credentials and rejects redirects / changed final URLs,
fetches with `redirect: 'error'`, `credentials: 'omit'`, and `cache: 'no-store'`,
and streams each body with a hard incremental ceiling equal to the exact locked
length (never trusting `Content-Length` alone). The reconstructed bytes are then
authenticated by the unchanged composer against the source-controlled release
lock, so a wrong or substituted asset fails closed.

Measured build output: the five original files are emitted as five distinct
static assets; the original compressed USDA payload totals **2,491,792 bytes**
and the full authenticated uncompressed data is **59,678,264 bytes**. No shard
payload or long base64 representation exists in the eager main JavaScript or in
any lazy JavaScript chunk — the client JavaScript carries only the fixed
generated asset URLs. No raw USDA archive (`.zip`) or extracted upstream JSON is
emitted, and the production server serves the app and the five assets as ordinary
static files; no Vite dev middleware and no server route are added.

### 18.5 Explicit lazy loading, one in-memory session

Loading is **explicit-user-intent only**: nothing is fetched, decoded, or
installed at application startup, and recipe navigation alone never loads the
bundle. The React controller owns exactly one in-flight load at a time, installs
at most one session, ignores results from a superseded request or an unmounted
owner, and reuses the successful session in memory across recipe navigation for
the lifetime of the application page. Retry is explicit and genuine: the loader
uses ordinary same-origin `fetch` (never a cached dynamic module import), so a
failed attempt's Retry issues new requests and can install exactly one session
without a page reload. StrictMode does not duplicate the load or session.

The session and the bundle bytes are never written to IndexedDB,
localStorage/sessionStorage, Cache Storage, a service worker, a vault file,
settings, Markdown/frontmatter, or a server cache. As each shard is
authenticated and decoded, the composer drops its reference to that shard's
compressed bytes, and it drops the decoded JSON string after parsing; those
values then become eligible for garbage collection, although actual reclamation
is controlled by the browser runtime. There are no timers, no background refresh,
and no periodic network activity. The existing record, manifest, digest, catalog,
context, and session validation is not weakened to reduce memory or startup time.

### 18.6 UI states, wording, and accessibility

The card distinguishes `idle` ("Trusted USDA source data are ready to load."),
`loading` ("Authenticating local USDA nutrition data…"), `ready` (genuine session
available), `failed` ("Advanced Nutrition could not authenticate its local USDA
data."), and `unsupported` ("This browser cannot safely open the local USDA
nutrition bundle."). Copy is calm, bounded, and input-redacted; success is never
claimed before the locked bundle and genuine session are ready; a preview is
never called saved nutrition; advisory/not-medical-advice language is retained.
Controls are keyboard-operable with accessible names and restrained `aria-live`;
the modal keeps `role="dialog"`/`aria-modal`, initial focus, focus containment,
Escape close, and focus restoration. No Apply, Save, Persist, Update Recipe, or
Write to Vault control appears.

### 18.7 Browser-only runtime; plugin exclusion

Phase 4.5B activates the full browser application only. The minimal Obsidian
plugin shell does not expose the Advanced Nutrition card and gains no
filesystem, ZIP, generator, verifier, or bundle-loading behavior; the USDA
artifact bytes are not embedded in `plugin/main.js`, and the plugin runtime
imports no browser asset URL. Plugin Advanced Nutrition runtime support is not
claimed in this phase.

### 18.8 Gates, persistence, and deferred work

`application_authorized` remains `false`,
`advancedNutritionApplicationAuthorization()` remains fail-closed, and
`canApplyNutritionEstimate` remains disabled. Phase 4.5B adds no Apply or
persistence path, no legacy migration, no Vault Intelligence integration, and no
bulk processing. Phase 5 remains responsible for explicit Apply/persistence and
legacy compatibility; Phase 6 (Vault Intelligence integration) remains
separately gated.

### 18.9 Tests

Phase 4.5B tests prove: the exact checked-in bundle loads and yields a genuine
working Phase 4 session with the locked release, 13,559 records, locked
nutrient-map version, and all data types; artifact/manifest/shard byte mutations,
truncation, trailing/concatenated gzip data, decompression beyond the bound,
uncompressed digest/UTF-8/JSON/canonical/record/duplicate/count/identity
mismatches, and a fully self-consistent forgery all fail closed with no partial
session; the input set is closed against missing/duplicate/unknown/case-colliding
names; the production entry point accepts no caller URL/directory/lock/env/
replacement byte source; the runtime/asset/loader path imports no Node/fs/ZIP/
Python/child/server/provider/persistence/vault/fixture module and performs no
network access beyond the single fixed same-origin bounded static-asset fetch
(credentials/redirects/changed final URLs rejected; `Content-Length` never
trusted alone); errors are fixed, bounded, and input-redacted; no bundle material
is written to browser or vault persistence; the plugin bundle excludes the
payloads and their locked signatures; loading is explicit and singleton with
genuine same-page retry and stale-result rejection under StrictMode; and the card
renders idle / loading / ready / failed / unsupported states truthfully with no
Apply/Save control. The production build/serve verification proves the five
emitted static assets are byte-identical to the checked-in sources, that no
client JavaScript carries the payload, and that the compiled server serves the
exact locked bytes.

---

## 19. Phase 4.5C — US customary portion resolution and explicit weight fallback

Phase 4.5C makes ordinary US recipe quantities useful while preserving strict
provenance and fail-closed behavior. It is a **runtime interpretation and review
improvement only**: it never persists, applies, writes a vault/Markdown file,
or authorizes machine application. The authenticated composer, the release lock,
and the checked-in artifact are unchanged.

The governing rule is:

```
recognized recipe quantity + explicitly selected authenticated USDA portion
  -> resolved mass
```

If no compatible USDA portion exists, the only fallback is an explicit
user-entered total weight for that ingredient line. Otherwise the ingredient
remains `no_mass`.

### 19.1 Supported measurements and exact conversions

- **Direct mass** (preferred when present): `g`, `kg`, `oz`, `lb`. US inputs such
  as `4 oz Cornmeal` resolve directly with no source portion.
- **Volume**: `tsp`, `tbsp`, `fl oz`, `cup`, `pint`, `quart`, `gallon`, `ml`, `l`
  (including existing aliases, plurals, abbreviations, ASCII/Unicode fractions,
  and mixed numbers). Larger US customary units are derived relationally from the
  single canonical fluid-ounce constant (1 cup = 8 fl oz, 1 pint = 16 fl oz,
  1 quart = 32 fl oz, 1 gallon = 128 fl oz) so there is no second, contradictory
  conversion table.
- Plain `oz` remains **mass**; fluid ounce requires an unambiguous fluid-ounce
  form.
- **Counts / packages** (`egg`, `slice`, `piece`, `clove`, `can`, `package`,
  `stick`, …) are never converted to mass. Descriptors such as `large`/`medium`/
  `small` are not treated as interchangeable counts. Count-to-mass resolution is
  not implemented in this phase; such lines stay unresolved and offer the
  explicit total-weight fallback.

### 19.2 Canonical portion semantics (`usda_portion_semantics_v1`)

One pure, deterministic layer (`calculation/portionSemantics.ts`) understands the
three canonical USDA portion shapes without altering the artifact:

1. **Foundation** — numeric `amount` + a real `measure` unit (optional
   descriptive `modifier`).
2. **SR Legacy** — `measure: "undetermined"`; the real unit is the leading
   ANCHORED token of `modifier` (e.g. `cup`, `cup, chopped`, `tbsp`, `fl oz`).
   A unit substring in the middle of a word is never treated as a measure.
3. **FNDDS** — no `amount`; `measure` embeds an explicit amount + unit (e.g.
   `1 cup`, `1 fl oz`). The numeric `modifier` is a USDA source code and is never
   shown as a human descriptor.

A missing amount is **never defaulted to one**. Text such as
`Quantity not specified`, `Guideline amount …`, `Juice of 1 …`, `Skin from …`,
`Topping …`, `1 large`, or `1 4 oz container` is `unusable`. The normalized
representation is closed and versioned (kind, positive finite effective amount,
normalized unit, exact canonical volume where applicable, gram weight, amount
source, bounded descriptor, safe display label, and raw identity binding).

### 19.3 Correct source-portion calculation

A source portion resolves mass only when its dimension is **compatible** with the
recipe measurement:

```
volume recipe + volume portion: resolved = recipe_ml / portion_ml * portion_gram_weight
mass   recipe + mass   portion: resolved = recipe_g  / portion_g  * portion_gram_weight
```

`2 tbsp` against `1 cup = 122 g` resolves to `2 tbsp / 1 cup * 122 g = 15.25 g`
using the canonical volume system — never numeric-only division. Incompatible
dimensions (volume recipe + count portion, count recipe + volume portion, …),
unusable portions, invalid/zero/non-finite amounts, and overflow fail closed.
The calculator independently recomputes the canonical portion semantics from the
authenticated raw fields; a caller-supplied normalized amount, unit, volume,
label, or gram weight is never trusted.

### 19.4 Provenance and invalidation

A selected source portion is bound to the calculation version, portion-semantics
version, line reference, ingredient identity digest, bundle release, FDC id,
record digest, candidate-set digest, portion index, raw portion fields, derived
semantic fields, and the resolved compatibility dimension. A user-entered total
weight is bound to the calculation version, line reference, ingredient identity
digest, bundle release, FDC id, record digest, entered quantity/unit, recomputed
gram value, and a selection digest. Changing the ingredient, selected food,
bundle, record, candidate set, portion, semantics version, or entered weight
invalidates the selection and any dependent preview. A portion selection and a
manual total weight are **mutually exclusive**; a request containing both is
rejected.

### 19.5 Explicit total-weight fallback (`user_mass`)

After a food is selected, the review offers a visually distinct
`Enter total weight for this ingredient line` control accepting `g` / `oz` / `lb`.
It represents the total weight of that recipe ingredient line and is **not a
density**. It requires a positive finite quantity, a supported explicit unit, a
deterministic conversion to grams, bounded input, and explicit user confirmation.
It is never prefilled, inferred, or auto-submitted. The calculator recomputes the
conversion; caller-supplied grams are never trusted. No fallback value is
persisted to the recipe, vault, settings, browser storage, or any external
service.

### 19.6 Evidence and review presentation

Ingredient evidence distinguishes `direct_mass`, `source_portion`, and
`user_mass` (and `no_mass`). A user-entered weight is never mislabeled as USDA
portion evidence. Candidate rows show a bounded portion-availability annotation
relevant to the current ingredient measurement (computed through the semantics
layer, never merely because a record has some portion). After a food is selected
for a non-mass ingredient, compatible canonical portions are presented
immediately with a semantic label such as `1 cup = 122 g`; the SR Legacy
`undetermined` placeholder is never shown; nothing is auto-selected; and
incompatible/unusable portions are disabled rather than selectable. The
annotation never changes food ranking, candidate order, or user-confirmation
requirements.

### 19.7 Gates, isolation, and deferred work

Phase 4.5C keeps the Phase 4.5B properties: explicit-user-intent loading, five
fixed build-owned asset URLs, no arbitrary URL, no external USDA/API/provider
fallback, no filesystem/Node production dependency, no payload in the main UI
chunk, authenticated bundle verification before record use, no partial session,
same-page retry, plugin payload exclusion, no automatic calculation, and no
application/persistence authority. Phase 4.5C adds no persistence, service
worker, IndexedDB, localStorage, Cache Storage, vault, Markdown, frontmatter,
settings, telemetry, secret, or server write. `application_authorized` remains
`false`; `advancedNutritionApplicationAuthorization()` remains fail-closed; and
`canApplyNutritionEstimate` remains disabled. Phase 5 (explicit Apply/persistence
and legacy compatibility) and Phase 6 (Vault Intelligence integration) remain
deferred.

The calculation contract version was bumped to `usda_advisory_calc_v2` (the
portion mass computation, the portion-semantics binding, and the `user_mass`
source materially changed). The Phase 4 state version was bumped to
`usda_phase4_state_v2` (new explicit user-weight selections).

---

## 20. Phase 4.5D — home-recipe eligibility and matching correctness

Phase 4.5D is the home-recipe catalog eligibility and matching-correctness slice.
It is a **review-only** change: it never persists, applies, writes a
vault/Markdown file, or authorizes machine application, and it still performs
**no count-to-mass calculation**. Count and culinary measures stay `no_mass`; the
only fallback remains the explicit user-entered total weight from Phase 4.5C.

### 20.1 The home-recipe eligibility boundary

The Advanced Nutrition ingredient picker is for home-recipe ingredients.
Restaurant- and fast-food-specific USDA records remain part of the authenticated
artifact but are **not available** to the matcher.

```
authenticated complete bundle (13,559 canonical records)
  -> manifest / record / count / content-digest / release / nutrient-map /
     component bindings ALL pass
  -> closed home-recipe eligibility policy
  -> eligible home-recipe catalog (12,924 records)
```

**Authentication before filtering.** Eligibility is applied only *after* the
complete source artifact has passed manifest validation, every canonical-record
validation, the canonical record count, the canonical content digest, the bundle
release binding, the nutrient-map version binding, and the component release
binding. A damaged, incomplete, or forged artifact can never be made to look
valid by the filter.

**Source count vs. eligible catalog count.** The complete authenticated source is
**13,559** records. The eligible home-recipe catalog is **12,924** records. The
policy excludes **635** records:

- `fast_food_category` — every record whose exact canonical food category is
  `Fast Foods` (312);
- `restaurant_food_category` — every record whose exact canonical food category
  is `Restaurant Foods` (113);
- `restaurant_chain_marker` — a closed, source-controlled set of normalized
  restaurant-chain markers derived from the complete pinned-bundle census (15
  records outside the two categories, e.g. `Hamburger (McDonalds)`,
  `Hamburger (Burger King)`, `Beverages, WENDY'S, tea`);
- `restaurant_context_marker` — the closed restaurant-context descriptors
  `restaurant` / `fast food` (195 records, e.g. `Ketchup, restaurant`,
  `Pizza, cheese, from restaurant or fast food`).

The marker set is closed and source-controlled in `matching/eligibility.ts`; no
caller input, environment variable, browser storage, network data, or runtime
configuration can alter it. The policy never keys on uppercase text, on
apostrophes, or on an unbounded heuristic, and it performs no network lookup and
no AI classification.

**Retail-brand retention.** Ordinary packaged grocery products stay eligible.
`Pillsbury`, `Nabisco`, `Kraft`, `CAMPBELL'S`, `HERSHEY'S`, `QUAKER`,
`Pepperidge Farm`, and `HORMEL` records (and similar) are retained; they are not
excluded merely because their descriptions contain a brand or uppercase text.

**No direct-ID bypass.** An excluded FDC id cannot become confirmable through
direct caller construction, a forged review snapshot, a forged candidate, a
manipulated result limit, capitalization, punctuation, an explicit restaurant-name
query, a stale pre-4.5D confirmation, a direct-path import, or a synthetic
structural catalog object. The genuine private catalog reconstruction enforces
eligibility: the calculation context's record map is built only from eligible
records, so an excluded record can never be reached for portion review or
calculation.

### 20.2 Corrected exact-unit parsing

A single shared, pure leading-unit recognizer (`matchLeadingUnit` in
`utils/measurements.ts`) consumes a recognized unit only as one complete token or
one exact recognized multi-token unit (`fl oz`, `fluid ounce(s)`). It is shared by
the deterministic raw-line segmenter and the canonical Markdown ingredient parser
(`parseIngredientLine`). Singular alternatives never consume prefixes of plurals:
`slice` matches `slice` (and `slices` matches `slices`), `tablespoon`/`tablespoons`
likewise, `can` never consumes `candy`, `g` never consumes `garlic`, `l` never
consumes `lettuce`, and `c` never consumes `cheese`. Punctuation adjacent to a
valid unit is handled by one explicit tested rule (`cups,` → `cups`). The exact
original ingredient text is preserved for display/evidence.

This repairs the real defect where `8 slices bacon` parsed to the leftover token
`s` and matched `McDONALD'S … Bacon`. Count and culinary measures (`slice`,
`clove`, `pinch`, `bunch`, `can`, `stick`, `head`, …) are removed from the
food-name query while their raw measurement identity is preserved; `egg`/`eggs`
stay food names. No count/culinary measure is converted to grams in this phase.

### 20.3 Query roles and the anchor contract

One pure, closed, versioned projection (`matching/query.ts`,
`usda_query_projection_v1`) turns a normalized food-name query into explicit
roles: food identity, measurement, size/portion qualifiers (`small`, `medium`,
`large`, …), a closed preparation set (`sliced`, `shredded`, `chopped`, `diced`,
`minced`, `grated`, `peeled`, `drained`, `rinsed`, `halved`, `quartered`, …),
non-authoritative recipe notes (a bounded trailing instruction such as
`formed into 4 patties`), bounded numeric qualifiers (`80 20`), and deterministic
matching anchors. The projection never mutates the source ingredient and never
rewrites a stored recipe.

`ground` is identity-bearing only when a meat species is present (`ground beef`),
and preparation-only otherwise (`ground black pepper` → identity `black pepper`).
Nutritionally significant qualifiers (`raw`/`cooked`, `salted`/`unsalted`,
`sweetened`/`unsweetened`, `whole`/`skim`, `enriched`/`unenriched`,
`lean`/fat-ratio, skin/no-skin, meat species, `fresh`/`canned`/`dried`) are never
blindly discarded.

**Anchors.** At least one deterministic anchor is derived from the food identity:
the head noun = the last identity token not in a closed descriptor stopword set
(colors, sizes, preparations, preservation/nutrition qualifiers, salt types,
`ground`). A candidate must contain a token (or an approved bounded morphological
equivalent) from every required anchor group. A candidate that only shares a
preparation word is never returned: black-pepper candidates must contain
`pepper`, lettuce candidates `lettuce`, tomato candidates `tomato`/`tomatoes`,
mayonnaise `mayonnaise`, bacon `bacon`, and burger-bun candidates a recognized
`bun`/`roll`. The anchor rule is deterministic, bounded, documented, and is bound
into review identity through the candidate set that the review digest covers.

### 20.4 Contradiction and qualifier policy

- **Contradictions.** A candidate never receives positive relevance merely
  because the query food appears in a negated or `with`-prepared phrase
  (`without salt`, `no salt`, `salt free`, `salt added`, `salt not added in
  processing`, `made with mayonnaise`). A bounded forward-negation window
  (`not`/`no`/`never` within two tokens after the matched food token) covers
  negations that follow the food word. If the query itself explicitly requests
  the corresponding qualifier, the compatible rule applies instead.
- **Identity-changing qualifiers.** A closed, tested set (`meatless`, `vegan`,
  `vegetarian`, `imitation`, `turkey`, `beef`, `canadian`, `bits`, `tofu`,
  `substitute`, `reduced`, `light`, `diet`, `low`, `free`) and a closed dish-form
  set (`sandwich`, `salad`, `soup`, `sauce`, `juice`, `patty`, …) lower an
  unmatched candidate. Nutritionally meaningful composition words that can be
  identity-bearing (`sweetened`/`unsweetened`, `skim`, `nonfat`, `whole`,
  `raw`/`cooked`, …) are deliberately **not** treated as generic conflicts; they
  remain identity tokens and only lower a candidate through normal identity
  coverage. For plain `bacon`,
  a generic ordinary bacon record outranks meatless, turkey, beef, Canadian,
  reduced-sodium, and bacon-bit variants unless the ingredient requests them.
- **No padding.** The result limit is a maximum, not a quota. Candidates that
  lack the required anchor, contradict the query, or are a different dish form
  are excluded rather than used as filler.

### 20.5 Bounded culinary aliases

A small, directional, versioned alias table (visible in ranking evidence) maps
demonstrated home-recipe language to USDA terminology. The initial case is
`burger bun(s)` → `hamburger bun` / `roll`, with a required `bun`/`roll` anchor.
Aliases never silently rewrite the stored recipe, never authorize an automatic
exact match, and never bypass explicit review.

### 20.6 Possessive normalization

One explicit NFC-safe rule removes straight (`'`) and typographic (`’`)
apostrophes before punctuation separation, so `McDonald's` → `mcdonalds` and
`USDA's` → `usdas`. A possessive can never produce a meaningful standalone `s`
token. No one-letter token is globally discarded, and plural food words
(`tomatoes`, `pickles`) and literal single letters (`vitamin c`) are preserved.

### 20.7 Versioning and stale invalidation

This phase materially changed parsing, normalization, catalog membership,
ranking, review digests, and candidate identity. Every affected version was
bumped: matching normalization `usda_match_normalize_v2`, ranking
`usda_match_rank_v2`, review catalog `usda_review_catalog_v2`, confirmation
`usda_match_confirm_v2`, query projection `usda_query_projection_v1`, eligibility
`usda_home_recipe_eligibility_v1`, calculation `usda_advisory_calc_v3`,
calculation context `usda_calc_context_v2`, Phase 4 session
`usda_phase4_session_v2`, and Phase 4 state `usda_phase4_state_v3`. The Phase
4.5C portion-semantics version (`usda_portion_semantics_v1`) is unchanged because
its semantics genuinely did not change.

The catalog digest binds the complete authenticated bundle identity, the matching
normalization version, the ranking version, the query-projection version, the
eligibility version and policy digest, the source/eligible/excluded counts, and
the exact eligible record identities. Any pre-4.5D catalog, review, confirmation,
match selection, portion selection, user-mass selection, calculation request,
preview, or Phase 4 state is therefore rejected or invalidated rather than reused
under the new contract.

### 20.8 The hamburger acceptance corpus

The principal acceptance corpus is the real hamburger recipe:

```
1 pound ground beef (80/20), formed into 4 patties
1 teaspoon kosher salt
0.5 teaspoon ground black pepper
8 slices bacon
4 slices cheddar cheese
4 burger buns
1 cup shredded lettuce
2 medium tomatoes, sliced
4 pickles, sliced
2 tablespoons mayonnaise
1 tablespoon ketchup
```

Parsing never presents `slice s` or `tablespoon s`; original lines are unchanged
for display/evidence; food identities are sensible and bounded; and
size/preparation/note roles are preserved separately. Ground beef surfaces raw
80/20 records first and the `formed into 4 patties` instruction is not identity;
kosher salt surfaces actual salt records first and excludes `without salt` foods;
black pepper surfaces `Spices, pepper, black` first and never ground meats;
bacon surfaces generic pork bacon first with no chain or variant outranking it;
cheddar cheese surfaces generic cheddar first with no USDA-possessive advantage;
burger buns surface `hamburger bun`/`roll` records with no Burger King record;
lettuce surfaces lettuce records with no shredded non-lettuce food; tomatoes
surface `Tomatoes, raw` first with `medium`/`sliced` kept as context; pickles
surface pickle records first; mayonnaise surfaces `Mayonnaise, regular` first
with no `McDonald's … without mayonnaise`; and ketchup remains a deterministic
unique exact match with no restaurant record.

### 20.9 Gates, isolation, and deferred work

Phase 4.5D keeps every Phase 4.5A–C property: the five fixed same-origin asset
URLs, no arbitrary URL, no USDA/API/provider fallback, no filesystem/Node
production dependency, bundle authentication before record use, no partial
session, same-page retry, plugin payload exclusion, no automatic calculation, no
count-to-mass calculation, no generic density or weight table, no application
authority, no persistence, and no vault/Markdown/frontmatter/recipe/settings/
browser-storage/cache-storage/service-worker write. Phase 5 and Phase 6 remain
unimplemented. The existing simple Nutrition & Macros/AI estimator is not
consolidated in this phase.

**Phase 4.5D still performs no persistence, no Apply, and no count-to-mass
calculation.**

---

## 21. Phase 4.5E — authenticated count-portion resolution

Phase 4.5E turns an authenticated USDA source portion into mass for a count
ingredient (e.g. `8 slices bacon`). It is **review-only**: it never persists,
applies, writes a vault/Markdown file, or authorizes machine application, and it
never invents a count-to-mass conversion. It uses only authenticated USDA
evidence.

### 21.1 Trust order

The count-portion path preserves the established trust chain end to end:

```
authenticated complete bundle (13,559 canonical records)
  -> manifest / record / count / content-digest / release / nutrient-map /
     component bindings ALL pass
  -> Phase 4.5D eligible home-recipe view (12,924 records)
  -> confirmed, eligible selected food
  -> the portion is read ONLY from that authenticated selected record
  -> structural + semantic validation (positive finite amount and gram weight)
  -> closed count-identity compatibility with the parsed ingredient count
  -> derived grams
  -> existing advisory calculation totals / per-serving derivation
```

Filtering, compatibility checks, or UI state never let a corrupted or substituted
source record escape bundle authentication. The calculation context's record map
contains only eligible records, so a restaurant/fast-food record can never supply
a portion.

### 21.2 Count identity and provenance (`usda_count_portion_v1`)

Every usable count portion has a deterministic closed identity `{ unit, size }`:

- `unit` is a canonical count unit drawn from a **closed** spelling table
  (`slice`, `piece`, `item`, `serving`, `clove`, `can`, `package`, `stick`,
  `head`, `egg`, `container`, `bun`, `roll`, `pickle`) extracted from the
  portion's measure/modifier, where the bounded alias `pkg` canonicalizes to
  `package` and regular plurals collapse to the singular. No other noun is ever a
  count unit, and there is no fuzzy or substring matching;
- `size` is a bounded size qualifier from a **closed** table (`small`, `medium`,
  `large`, `jumbo`, `mini`, `petite`, `xl`, `xxl`) when the portion identity is a
  size, where `miniature` canonicalizes to `mini` and `xlarge` / `extra large`
  canonicalize to `xl`; these are explicit aliases only, never fuzzy matches;
- an ambiguous description (`any size`, `NFS`, `not specified`, `unspecified`,
  `quantity`, `guideline`, `variable`, `unknown`) is never a count identity;
- a mass/volume unit is never a count identity.

A `CountPortionSelection` binds the count-portion version, calculation version,
line reference, ingredient identity digest, bundle release, catalog identity
(which itself binds the eligibility policy, normalization, ranking, and eligible
membership), selected food id, record digest, candidate-set digest, exact portion
index, authoritative portion amount, authoritative gram weight, the portion
measure, the count unit/size, and a deterministic selection digest. A portion belonging to one food can never be
reused with another food, and a caller-supplied gram value is never trusted — the
calculator recomputes grams from the authenticated record.

### 21.3 Compatibility rules

Compatibility between the parsed ingredient count and an authenticated portion is
conservative and closed:

- an explicit input size is a **constraint**: the portion size must equal it;
  `2 medium tomatoes` may use an authenticated `medium` portion and must never
  silently fall back to small/large/generic/unspecified;
- an unspecified input size never silently adopts a size-specific portion;
- an explicit count unit must match, with only two bounded equivalences:
  `bun ↔ roll` and `item ↔ pickle`;
- `slice` is never `piece`; `package` is never `serving`; `order`/`recipe` are
  never `serving`; a volume measure is never a count portion; a prepared
  restaurant serving is never a home-recipe item;
- a bare count with no unit/size never matches a slice/piece portion.

A usable count portion must have a finite amount greater than zero, a finite gram
weight greater than zero, an authenticated association with the selected food,
and a supported count description. A present-invalid amount or gram weight makes
the whole portion unusable; a present-invalid value is never replaced with an
alternate field or a default.

### 21.4 Deterministic selection and ambiguity

If exactly one compatible count portion is valid (or every compatible candidate
resolves to the same `(amount, gram_weight)`), it becomes the deterministic
compatible portion and is applied automatically. If multiple compatible portions
resolve to materially different gram weights, the review UI exposes the choices
with USDA description and gram weight and **requires explicit selection** before
calculating. Candidate order never affects compatibility, ambiguity, the chosen
identity, or the calculated grams; reversing the source portion order leaves the
result unchanged.

### 21.5 Derived-mass contract

```
totalGrams = ingredientCount / authoritativePortionAmount
             × authoritativePortionGramWeight
```

Examples: `8 slices` using `1 slice = 28 g` → 224 g; `4 slices` using
`1 slice = 17 g` → 68 g; `6 pieces` using `3 pieces = 45 g` → 90 g. Intermediate
values are never prematurely rounded; non-finite, non-positive, or overflowing
results are rejected. The canonical USDA record is never mutated and derived
grams are never written back into the bundle. The Phase 4.5C direct-mass and
`user_mass` contracts are unchanged, and the existing recipe-total/per-serving
derivation is preserved.

### 21.6 Review presentation

For a compatible count portion the review shows the parsed ingredient count, the
selected USDA food, the authoritative portion, the derivation math, the resulting
total grams, and whether the choice was deterministic or explicitly selected
(e.g. `8 slices × 28 g per slice = 224 g · deterministic`). Ambiguous foods show
the compatible choices; incompatible foods stay unresolved with a bounded
explanation. No Apply/Save/Persist control exists.

### 21.7 Invalidation

Changing the ingredient text, parsed quantity, count unit, explicit size,
selected food, selected portion, confirmation, bundle/release/component identity,
eligibility-policy identity, or any existing session-version dependency
invalidates the count-portion selection and the derived calculation. Closing and
reopening Advanced Nutrition never resurrects stale portion authority; nothing is
persisted (Phase 5 owns persistence).

### 21.8 Bypass resistance

All calculation paths independently re-verify the authenticated bundle, the
eligible view, the selected food, the portion's exact food association, the
portion's validity, the ingredient compatibility, and the current state. Direct
excluded-id access, forged food/portion snapshots, swapping a portion between
foods, changing gram weight/amount after selection, capitalization/punctuation
variants, oversized limits, direct calculation-context calls, stale session data,
stale bundle/release/eligibility identity, and reordered/added/removed source
records all fail closed.

### 21.9 Gates, isolation, and deferred work

Phase 4.5E keeps every Phase 4.5A–D property: USDA artifacts and the release lock
are unchanged, the five fixed same-origin asset URLs are unchanged, no arbitrary
URL, no USDA/API/provider fallback, no filesystem/Node production dependency,
bundle authentication before record use, no partial session, plugin payload
exclusion, no automatic calculation, no density or weight table, no application
authority, no persistence, and no vault/Markdown/frontmatter/recipe/settings/
browser-storage/cache-storage/service-worker write. Phase 5 (persistence/Apply)
and Phase 6 (Vault Intelligence) remain unimplemented, and the existing simple
Nutrition & Macros/AI estimator is not consolidated here.

**Phase 4.5E still performs no persistence, no Apply, and never invents a
count-to-mass conversion.**

---

## 22. Phase 5A — Apply authorization and persistence-candidate construction

Phase 5A establishes the trusted boundary between the advisory Phase 3/4
calculation and the future Phase 5B Apply/write. It is **isolated, pure,
platform-neutral, and build-only**: it constructs and validates an in-memory
`codex_nutrition` persistence candidate and returns a closed authorization
result. It writes nothing and exposes no Apply control.

```
current authenticated authority
  (genuine Phase 4 session + re-adapted recipe + current reviewed state)
    -> deterministic re-derivation of the exact reviewed result
    -> canonical schema-v1 `codex_nutrition` candidate (entire-recipe totals)
    -> final schema validation + canonical encode gate
    -> AUTHORIZED { candidate, identity, mode } | NOT AUTHORIZED { bounded reason }
```

Module: `src/core/nutritionV2/phase5/` (`types.ts`, `authorize.ts`, `index.ts`).
It is intentionally NOT re-exported from the public `nutritionV2`/`core` barrels.

### 22.1 Trust boundary

A caller-supplied nutrition object is **never** authority, and a caller-supplied
session object is **never** authenticated structurally. The candidate is
reconstructed exclusively through the genuine Phase 4 session boundary
(`recomputeReviewedNutrition`), which resolves the module-private
`SESSION_AUTHORITY` WeakMap for the exact receiver and fails closed for any
structural fake, clone, spread, inherited object, proxy, wrapper, primitive, or
`null` **before invoking any caller-supplied method**. It uses:

- the **genuine Phase 4 session** (lexically private authority; resolved only
  for the exact receiver);
- the **raw recipe**, re-adapted through the hardened Phase 4 `adaptRecipe`
  boundary (never read directly);
- the **current reviewed state**, read through guarded own-data descriptors; and
- a **fresh advisory calculation** through the genuine session.

Phase 5A itself never calls `session.metadata()`, `session.calculate()`,
`session.reviewIngredient()`, `session.reviewPortions()`, or any other method on
the caller-supplied session object; it only passes the object to the genuine
Phase 4 capability, which proves possession of the private registration.

The caller's preview is used only as a **stale-detection binding**: it must match
the fresh re-derivation on every authoritative scalar
(`calculation_schema`, `calculation_version`, `bundle_release`, `catalog_digest`,
`nutrient_map_version`, `servings`, `status`, `ingredient_digest`, `basis`, and
the canonical `nutrient_scope`). Totals are a deterministic function of the
ingredient digest + scope + servings, so this is a complete staleness proof. The
emitted block is always built from the **recomputed** preview, never from the
caller's preview.

### 22.2 Persistence-candidate builder

The builder maps the recomputed `AdvisoryNutritionPreview` onto schema v1:

- `basis` is always `total`; **entire-recipe totals only** (per-serving values
  remain derived at display time and are never persisted);
- `status` is the calculation status (`complete` / `partial` / `unresolved`);
- `computed_at` is set once by the builder from an explicit timestamp seam (or a
  single default clock read); a caller-supplied block/timestamp is never copied;
- `servings` is the recipe's authoritative serving denominator (the adapted
  `base_servings`), validated with the existing strict serving rules;
- `nutrient_scope` is the exact canonical scope the current calculation
  attempted (never widened, never zero-filled);
- `nutrients` carries only present totals; a missing nutrient stays absent, and
  an explicit source-reported zero stays zero;
- `sources` is `['usda_fdc']` and `source_releases.usda_fdc` is the
  authenticated bundle release currently in authority;
- `ingredients` carries one traceable evidence record per **resolved**
  ingredient (`source_food_id` = the authenticated FDC id, `source_release` = the
  authenticated release, `match_status: 'confirmed'`, `resolved: true`,
  `user_confirmed: true`, and a canonical gram `amount`), with `conversion_basis`
  `direct_mass` for direct mass, `source_portion` for source/count portions, and
  omitted for a user-entered total weight (schema v1 has no `user_mass` basis, so
  it is never mislabelled — see §22.11);
- `unresolved` carries the calculation's unresolved references with the closed
  reason vocabulary.

The persisted `match_status: 'confirmed'` / `resolved: true` /
`user_confirmed: true` triple means **"this evidence was part of the explicit
reviewed result authorized for a future Apply"**, not necessarily "the original
Phase 3 match required a manual click". A deterministic unique-exact match and a
manually confirmed match both become resolved evidence once the user explicitly
reviews and authorizes the result (§22.12).

### 22.3 Authorization result

A closed union (never throws):

- **AUTHORIZED** — `{ candidate: { identity, block, encoded } }`, where `block`
  is the canonical validated schema-v1 block, `encoded` is the frontmatter-ready
  whole-block replacement unit, and `identity` binds the authorization-contract
  version, recipe key, session identity, calculation/context/bundle/catalog
  identity, the reviewed `ingredient_digest`, the serving denominator, the
  create/replace mode, and a `candidate_digest` over the canonical encoded block.
- **NOT AUTHORIZED** — a fixed, bounded, input-redacted failure code from the
  closed set `stale_preview`, `invalid_servings`, `unresolved_authority`,
  `schema_invalid`, `calculation_mismatch`, `unknown_future_schema`,
  `unsafe_request`, `invalid_request`, `validation_error`. Attacker-controlled
  values are never echoed.

### 22.4 Stale rejection

Authorization fails closed when any dependency changed since the reviewed
preview was produced. Because the builder re-derives from current authority and
requires an exact binding match, a change to ingredient text/order/quantity/unit,
explicit size, selected food, portion/count-portion/user-mass selection, serving
denominator, bundle release, catalog identity, eligibility policy, calculation or
context version, or session identity all yield a different re-derivation and are
rejected (`stale_preview` / `calculation_mismatch`). A `preview_stale` status, a
missing preview, or a `recipe_key`/`session_identity`/`baseServings` mismatch is
rejected directly. Nothing is silently refreshed: a stale result requires a new
calculation/review cycle.

### 22.5 Whole-block replacement semantics

When the current recipe already carries a recognized schema-v1 block, the
authorization reports `mode: 'replace'` (an absent block reports `mode: 'create'`)
so Phase 5B can distinguish create from replace. The candidate is always a
**whole new block** — nutrient maps are never merged piecemeal — and unrelated
frontmatter is untouched (Phase 5A performs no write at all).

### 22.6 Unknown-future-schema protection

A stored block with an unknown numeric `schema` is decoded as bounded opaque safe
data. Phase 5A **fails closed** (`unknown_future_schema`) rather than authorizing
an overwrite, and never drops or interprets the future-schema data. Malformed
recognized data also fails closed (`schema_invalid`) rather than being silently
replaced.

### 22.7 Final schema validation gate

Before returning an authorized candidate, Phase 5A (1) constructs the block from
the recomputed authority, (2) runs `validateCodexNutritionV1`, (3) canonical
encodes it with `encodeCodexNutrition` (proving serializability and the 64 KiB
UTF-8 serialized-byte bound), and (4) computes a canonical `candidate_digest`.
Any validation failure rejects the candidate. Phase 5B can therefore treat the
Phase 5A output as the **only** permitted source for `codex_nutrition`.

### 22.8 No-write isolation

Phase 5A contains no path that writes recipe Markdown, YAML/frontmatter, vault
files, File System Access handles, `localStorage`, `IndexedDB`, Cache Storage,
service-worker storage, or backend storage. It performs no network call and no
provider call. The Advanced Nutrition UI may display a bounded "eligible for a
future Apply" / "not eligible" indicator, but there is **no Apply/Save/Persist
control** and no automatic persistence. The centralized machine-application
disable (`canApplyNutritionEstimate` / `advancedNutritionApplicationAuthorization`)
remains in force.

### 22.9 Deferred Phase 5B responsibilities

Phase 5A deliberately does **not** implement the actual write. Phase 5B still
owns: the explicit user Apply action; re-proving the candidate identity
immediately before the write; all-or-nothing vault-safe Markdown/frontmatter
replacement; preserving unrelated frontmatter; and the create-vs-replace
decision. Phase 5C (consolidation) and Phase 6 (Vault Intelligence) also remain
unimplemented.

### 22.10 Genuine session authority (independent-audit repair)

An independent audit found that an earlier Phase 5A draft authenticated the
Phase 4 session **structurally**: a caller could manufacture a structurally
complete fake session (plausible `metadata()`, `calculate()`, `reviewIngredient()`,
…) and obtain `ok: true` with attacker-chosen totals. That is repaired by moving
the authority-sensitive re-derivation behind the Phase 4 private session
boundary.

The single audited capability is
`recomputeReviewedNutrition(session, recipe, state)` in
`src/core/nutritionV2/phase4/session.ts` — the one lexical module that owns the
module-private `SESSION_AUTHORITY` WeakMap. It:

1. resolves `SESSION_AUTHORITY.get(session)` for the **exact receiver** and fails
   closed with `invalid_session` for any fake/clone/spread/inherited
   object/proxy/wrapper/primitive/`null` — **before** invoking any method on the
   supplied object;
2. re-adapts the raw recipe through the hardened Phase 4 adapter;
3. reads the current reviewed state through guarded own-data descriptors;
4. runs a fresh advisory calculation on the genuine session; and
5. returns only bounded derived data (`metadata`, `session_identity`,
   `recipe_key`, `servings`, `preview`) — never the private catalog, context,
   records, WeakMap, or a forgeable boolean/token/symbol.

Phase 5A maps a failed re-derivation to `unresolved_authority` (or the
appropriate closed code) and never mints a candidate or identity. The proof
derives from **possession of the genuine Phase 4 session object**, not from
`instanceof`, object shape, method names, symbols, constructor/prototype names,
metadata consistency, or a recomputable public digest. Proxy wrapping and
`Object.create(genuineSession)` are deliberately **not** treated as genuine.

### 22.11 `user_mass` provenance — documented schema-v1 limitation

For a `user_mass` line (an explicitly user-entered total ingredient weight),
Phase 5A persists the resolved gram `amount` with **no `conversion_basis`**. This
is deliberate:

- schema v1 permits only `direct_mass` and `source_portion`; it cannot faithfully
  preserve that the mass was explicitly supplied by the user;
- Phase 5A therefore does not pretend the value is `direct_mass` (which would
  falsely imply the ingredient text supplied the mass) or `source_portion` (which
  would falsely imply an authenticated USDA portion supplied it);
- provenance fidelity for explicit user-entered mass is a **known schema-v1
  limitation**; a dedicated `user_mass` provenance marker/conversion basis
  requires a **future schema revision**;
- Phase 5B must **not** silently reinterpret a missing `conversion_basis` as
  `direct_mass`, `source_portion`, or USDA-derived.

A focused test asserts the user-mass evidence is never mislabelled.

### 22.12 Audit notes accepted without code change

- **Persisted evidence semantics (NOTE 3).** `match_status: 'confirmed'` +
  `resolved: true` + `user_confirmed: true` denote "part of the explicit reviewed
  result authorized for future Apply", not "the original match required a manual
  click". A deterministic unique-exact match and a manually confirmed match are
  both persisted this way; the schema-v1 validator requires this shape for
  resolved evidence, and Phase 5A does not redesign it.
- **`computedAt` test seam (NOTE 4).** The optional `computedAt` request field is
  a deterministic timestamp seam. The production UI does not pass it; the builder
  validates it (bounded ISO-8601, `MAX_TIMESTAMP_LENGTH`) and falls back to a
  single clock read. It cannot influence authority: the block is rebuilt from the
  genuine preview and the identity is bound to the canonical candidate digest.
- **Unknown top-level request fields (NOTE 5).** Extra request fields are ignored
  (they are never authority); no broad unknown-field rejection was added.

**Phase 5A performs no persistence, no Apply, and no vault/Markdown write.**

---

## 23. Phase 5B — explicit Apply and vault-safe whole-block persistence

Phase 5B is the first Advanced Nutrition phase permitted to write
`codex_nutrition`. It adds one explicit, user-triggered Apply action and a
write/commit boundary that consumes the genuine Phase 5A authorization. It is NOT
a second calculator: it never maps nutrients, provenance, digests, or schema, and
it never accepts caller-supplied nutrition as authority.

Module: `src/application/advancedNutritionApply.ts` (application layer; no direct
File System Access / storage / network / provider API). The Phase 5A core
(`src/core/nutritionV2/phase5/`) stays pure/no-write and is NOT re-exported from
the public core barrels.

### 23.1 Explicit Apply only

Persistence happens ONLY when the user clicks Apply and then confirms. The
coordinator is invoked exclusively by that action. There is:

- no automatic persistence on modal/card open, on calculation, or on
  match/portion/basis/serving changes;
- no background/timer/observer write surface;
- no write when the reviewed result is not eligible (the control is disabled);
- no duplicate write while an Apply is in flight.

### 23.2 Immediate pre-write re-proof (the central rule)

Immediately before the write, the coordinator re-runs
`authorizeNutritionPersistence` from the CURRENT genuine Phase 4 session + current
recipe + current reviewed state + current existing block. Only the candidate
returned by that fresh authorization is written. A cached UI eligibility result
is never trusted; any authority mutation between the eligibility render and Apply
fails closed as `stale_authorization`.

The genuine-session repair from §22.10 is preserved end to end: a structurally
fake session, a Proxy of a genuine session, `Object.create(genuineSession)`,
copied metadata, or copied method references all fail closed before any write.

### 23.3 TOCTOU protection

The write-time re-authorization plus a create/replace mode cross-check catches
every dependency mutation between check and use: ingredient text/order/quantity/
unit/size, servings, selected match, source/count portion, user mass,
confirmation, bundle/catalog/eligibility identity, calculation/context version,
session identity, existing block content, and create<->replace mode changes. The
UI additionally passes the mode it displayed; a change of the stored block's mode
before the write fails closed. No write occurs on any mismatch.

### 23.4 Create vs. replace (whole-block)

The Phase 5A mode is authoritative:

- **create** — the recipe has no `codex_nutrition`; exactly one canonical
  schema-v1 block is added;
- **replace** — the recipe has a recognized valid schema-v1 block; the ENTIRE
  `codex_nutrition` slot is replaced.

Nutrients, sources, evidence, unresolved entries, and source releases are never
merged piecemeal. The update is expressed as a whole-block assignment on the
serialized recipe, so the canonical serializer emits one complete block.

### 23.5 Unknown future schema and malformed existing block

Before authorizing, the coordinator decodes the current raw block:

- an opaque unknown future schema fails closed (`unknown_future_schema`) and is
  never overwritten, dropped, reinterpreted, or downgraded;
- a malformed recognized schema-v1 block fails closed (`invalid_existing_block`)
  and is never silently replaced or "repaired".

No write occurs in either case.

### 23.6 Existing writer reuse

The actual persistence is injected as a `write` port. The browser shell supplies
the SAME authoritative recipe write path the editor uses
(`saveRecipeWithVaultAdapter` when a vault is connected; the established
disconnected download fallback otherwise). Phase 5B does not create a parallel
file-writing subsystem and never touches File System Access, IndexedDB, or the
vault directly. Path identity, Markdown serialization, YAML/frontmatter
handling, live vault sync, and error handling all remain owned by that path.

### 23.7 Atomic / fail-closed semantics

- The updated recipe is serialized BEFORE the write; a serialization failure
  (`serialization_failed`) never reaches the writer.
- The in-memory recipe is committed ONLY after the canonical write succeeds.
- A writer failure returns `write_failed`; the prior canonical state is intact.
- There is no intentional multi-step partial mutation and no partial nutrient
  merge. Browser File System Access does not provide true filesystem atomicity;
  the repository's established write pattern (serialize fully, then
  create-writable/write/close, with best-effort abort) is preserved, and this
  limitation is documented honestly.

### 23.8 Post-write success behavior

When a vault is connected, the coordinator re-reads the persisted Markdown and
verifies it decodes as recognized schema v1 whose canonical encoding matches the
just-authorized candidate digest (`post_write_verification_failed` otherwise).
After success the shell commits the updated recipe through the existing canonical
recipe update/sync mechanism (no second source of truth). The UI reports a
bounded success message and the recipe reflects the persisted block. A missing or
unwritable target fails closed (`unavailable_write_target`) without a partial
write.

### 23.9 Apply result (closed, bounded)

`applyAdvancedNutrition` never throws and returns either
`{ ok: true, result: { mode, candidate_digest, authorization_version, recipe_key } }`
or `{ ok: false, failure: { code, message } }` with a closed code from
`not_authorized`, `stale_authorization`, `unknown_future_schema`,
`invalid_existing_block`, `serialization_failed`, `write_failed`,
`post_write_verification_failed`, `unsafe_request`, `unavailable_write_target`.
Messages are fixed, bounded, and never echo caller/exception content. The result
makes create/replace, the written candidate digest, the authorization version,
and the recipe identity auditable; no separate audit log, telemetry, or network
reporting is added.

### 23.10 UI behavior

The Apply control is a real accessible button inside the Advanced Nutrition
review surface. It is enabled only when the current reviewed result is eligible;
it is disabled while ineligible or in flight; it requires an explicit
confirmation that distinguishes create from replace ("add a saved block" vs
"replace the existing saved block"); and it shows bounded success/failure
feedback. It is not visually dominant and does not submit unrelated forms. The
control is absent when no write handler is wired (e.g. plugin mode).

### 23.11 `user_mass` limitation preserved

Phase 5B writes the Phase 5A candidate EXACTLY. It does not reinterpret a missing
`conversion_basis` (the accepted user-mass limitation from §22.11) as
`direct_mass` or `source_portion`, does not add schema-v1 `user_mass`, and does
not silently upgrade the schema.

### 23.12 Phase 5A purity retained / plugin mode

The Phase 5A core remains pure and write-free; all write authority lives in the
application coordinator and the existing vault writer. The Obsidian plugin shell
renders `RecipeWorkspace`, which does not include Advanced Nutrition, so no Apply
control is exposed there (write integration for the plugin is intentionally
deferred, not broken). No USDA dataset payload is bundled into the plugin.

### 23.13 Deferred Phase 5C responsibilities

Phase 5C remains out of scope: the existing simple Nutrition & Macros / AI
estimator is NOT consolidated, legacy/simple nutrition is NOT removed or
migrated, schema v1 is NOT redesigned, and Vault Intelligence behavior is NOT
added. An independent audit/release review is still required.

**Phase 5B persists ONLY on an explicit user Apply, re-proves Phase 5A authority
immediately before the write, and performs a whole-block vault-safe update.**
