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
recipe write path), plus Phase 5C (a consolidated, non-destructive Nutrition
presentation that makes a recognized saved Advanced result the preferred display
authority and the legacy simple/AI estimator the fallback, without merging,
migrating, or rewriting either representation)**. No network route or live API is
used. Phase 5A remains pure/build-only (it writes nothing). Phase 5B is the ONLY
Advanced Nutrition surface permitted to persist, and only on an explicit user
Apply: there is no automatic, background, or on-open persistence. Phase 4.5E
still performs no persistence, no Apply, and never invents a count-to-mass
conversion (it uses only authenticated USDA source portions).

**Phase 5 implementation is complete (5A authorization, 5B explicit Apply, 5C
consolidation), pending independent Phase 5C audit and the full smoke-test /
release-control checkpoint.** Phase 6 (Vault Intelligence) has NOT started.

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
candidate without writing it. Phase 5B (explicit Apply/safe vault writes) is
implemented: a single explicit user Apply re-proves the authorization at the
write boundary and performs a vault-safe whole-block `codex_nutrition`
create/replace through the existing recipe write path. Phase 6 (Vault
Intelligence integration) remains unimplemented and requires separate approval.

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

**`status: complete`** requires:

- `nutrient_scope` is nonempty;
- there are **no unresolved entries** (every measurable ingredient line
  resolved);
- the provenance coherence rules below hold;
- an empty nutrient map can never claim complete.

**Completeness is INGREDIENT-LINE resolution, not nutrient-list breadth.** Zero
unresolved measurable ingredient lines means the whole-recipe result is COMPLETE
even when an individual USDA record does not enumerate every nutrient in scope.
Each nutrient independently reports its own `status`/`coverage` (it may be
`partial` or absent), so a COMPLETE recipe can legitimately carry a partial
nutrient. An absent scoped nutrient is never synthesized as zero.

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
  tests, and a full-archive compatibility census. The adapter itself downloads
  nothing; the audited acquisition/generation step (Phase 4.5A) has since been
  implemented and its manifest-bound canonical bundle IS committed under
  `data/advanced-nutrition/usda/` (release
  `usda_fdc_87c5408a3e98838944a87be74824761e`). Audit gate: source license +
  privacy review.
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
  DONE (presentation/workflow consolidation, non-destructive): a single pure
  precedence selector makes a recognized saved Advanced result the preferred
  display authority, keeps the legacy simple/AI estimator as the fallback for
  legacy-only recipes, marks a stale saved result without substituting legacy
  values, and reports unknown/malformed saved blocks while preserving them.
  Nothing is merged, migrated, or rewritten. Audit gate: presentation +
  non-destruction review.
- **Phase 6 — verified household-portion authority.** DONE (offline, isolated):
  a lock-verified Kitchen Codex household-portion registry (31 USDA-derived
  records), an exact-key deterministic resolver, a fully digest-bound household
  selection, lowest-authority effective-mass precedence, truthful schema-v2
  persistence/reopen, and full fail-closed guarding. See §37.
- **Phase 7 — AI interpretation alignment with verified household portions.**
  DONE (offline, isolated, advisory-only): AI may interpret a closed
  unit/size/state household wording hint, but only the local deterministic core
  may resolve it against the authenticated registry. See §38.
- **Phase 8 — broader final migration, staleness, round-trip, production-browser,
  corpus, and release-exit program.** [NOT STARTED]

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

The pinned production USDA bundle IS committed under
`data/advanced-nutrition/usda/` (Phase 4.5A); no raw upstream archive is
committed.

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
bundle. A recipe's SAVED Advanced report renders from the validated persisted
block alone (no bundle load); only the explicit Edit / Re-analyze or Generate
Nutrition action initializes the working analyzer, which then loads the bundle
lazily. The React controller owns exactly one in-flight load at a time, installs
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
`canApplyNutritionEstimate` remains disabled (historical Phase 4.5B scope; a
later Phase 5B added the explicit user Apply described in §22–§23). Phase 4.5B adds no Apply or
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

### 20.10 Phase 0A — primary-food identity vs secondary component

USDA descriptions name the primary food first and may then introduce a secondary
component, medium, coating, flavor, or accompaniment after a relational marker
(`Fish, sardine, Pacific, canned in tomato sauce, drained solids with bone`;
`Cereals, QUAKER, Instant Grits, Country Bacon flavor, dry`). A query that
identifies only that secondary component (`canned tomato sauce`, `bacon`) does
not prove the candidate's primary food identity and therefore must not receive
automatic authority.

**Deterministic guard.** `secondaryComponentOnlyMatchCount` in
`src/core/nutritionV2/matching/query.ts` scans the candidate's normalized tokens
once with a closed marker vocabulary (relational `in`, `with`, `filled`,
`stuffed`, `containing`, `contains`, `coated`, `topped`; flavor `flavor(s)`,
`flavored`, `flavour(s)`, `flavoured`). The query's identity tokens are its
`food_tokens` minus state qualifiers (`canned`, `frozen`, ...), so a state word
inside the candidate's primary segment cannot mask a secondary-only match, while
a query that genuinely names the primary category (`cereal`) keeps its
candidate. When every matched identity token lies outside the primary segment,
the guard contributes one FAMILY MISMATCH, which removes the candidate from
automatic authority through the existing zero-condition confidence contract.
The candidate remains visible and reviewable; ranking may demote it.

**Not recipe-specific, and candidate-relative.** There is no literal food, brand,
or FDC blocklist and no AI involvement: the rule is marker-driven, bounded, and
deterministic for every description. Whether it triggers depends on the
candidate. A query such as `tomato sauce` or `bacon` does not trigger against
candidates where tomato sauce or bacon is the primary identity (`Tomato
products, canned, sauce`; `Pork, cured, bacon, unprepared`), but the same query
does trigger against fish/cereal candidates where those tokens appear only as
secondary sauce/flavor components (`Fish, sardine, ... canned in tomato sauce`;
`Cereals, ... Country Bacon flavor`). When the query names the candidate's
primary food (`sardines in tomato sauce`, `canned sardines in tomato sauce`,
`fish in tomato sauce`), existing identity evidence decides exactly as before.
An explicit exact-phrase/token-multiset query remains independently authorized.

**Unchanged behavior.** Eligibility, the rank tuple, the zero-condition
confidence contract, runner-up ambiguity, review outcomes, digest binding, the
USDA nutrient authority, the AI interpretation-only boundary, live-row
authority, and the explicit Apply boundary are all unchanged. The guard can only
reduce unsafe automatic authority or improve safe candidate ordering; it never
manufactures authority.

**Identity safety corpus.** `tests/fixtures/advancedNutritionIdentityCorpus.ts`
plus `tests/unit/advancedNutritionIdentityCorpus.test.ts` run a bounded corpus
of ordinary ingredients against the real pinned bundle and assert explicit
invariants: zero incorrect automatic identities, the confirmed
`canned tomato sauce` → sardine defect can never recur, known-correct automatic
identities are unchanged, untouched candidate order is unchanged, and repeated
runs are content-identical. Lines with known identity/amount limitations are
marked `knownIssue` and only forbid a NEW automatic identity; they do not bless
the current one. The corpus is a diagnostic baseline for later phases, not an
approval of any household-portion or parsing design.

### 20.11 Phase 0B — effective-mass authority + count-hint projection parity

Phase 0B removes two authority/presentation inconsistencies that let a row display
one mass source while the calculator used another, or display a count-portion
candidate set the calculator would not authenticate. No new mass source, no
threshold, ranking, parsing, amount, persistence, or AI-authority change is made.

**ONE effective-mass authority.** `resolveEffectiveMassDecision` in
`src/core/nutritionV2/calculation/effectiveMass.ts` is the single decision used by
BOTH the calculator and the live projection. The effective source is exactly one
of: the declared direct recipe mass (g/kg/oz/lb, highest), an explicit
user-entered total mass, an authenticated USDA source portion, or an
authenticated USDA count portion. More than one non-direct selection is a
CONFLICT (`multiple_sources`), and a direct recipe mass is EXCLUSIVE with EVERY
alternate mass choice: direct + user total
(`direct_mass_with_user_mass`), direct + source portion
(`direct_mass_with_source_portion`), direct + count portion
(`direct_mass_with_count_portion`), and direct + several alternates
(`direct_mass_with_multiple_alternates`) are all conflicts. A conflicting state
yields NO authoritative mass: the calculation request fails closed
(`invalid_portion_selection`), the live row reports no mass and no source, and
Apply is refused, so the UI can never display one source while the calculator
uses another. A direct-mass line therefore offers NO alternate mass choice at
all: the ONE shared creation gate (`hasDirectRecipeMass`) makes
`buildUserMassChoice`, `buildPortionChoice`, and `buildCountPortionChoice` refuse
to create any alternate choice for such a line, and the working review renders
only the bounded informational note that the recipe-declared mass is used (no
selectable source/count portion radio, no manual total weight, no `selected`
chip for an ignored alternate). Re-analysis clears stale invalid alternates,
after which the direct mass becomes authoritative again.

**ONE canonical count-hint context.**
`src/core/nutritionV2/phase4/countContext.ts` owns the bounded advisory
count-identity hint for one working line: the sanitized hint bound to its stored
count-portion choice. Candidate review (modal), the calculation request, the
calculator's independent re-derivation, the live projection, and AI-assisted
deterministic resolution all use this same context, so the normalized
requirement, candidate set, deterministic ordering, candidate-set digest, and
selected portion binding are identical across consumers. A selection built
through `buildCountPortionChoice` preserves its hint. A malformed stored hint is
ignored fail-closed for display and dropped by the canonical context; a hint for
one line, quantity, or food never binds another (the reducer clears the count
choice on a food change, and the calculator rejects stale-digest, cross-line, and
cross-quantity selections). Hydration's canonical context is the no-hint context
(schema v1 does not persist a hint) and the deterministic analyzer runs before any
hint exists; neither invents one.

**Full live-display binding verification.** For every explicit non-direct mass
choice the live projection derives its displayed grams and source from the ONE
calculation engine itself: a bounded per-line calculation dry-run built from the
SAME shared per-line input (`lineCalculationInput`) the calculation request uses.
The calculator independently re-verifies the full binding contract (ingredient
identity digest, line reference, FDC id, bundle release, catalog digest where the
contract carries one, record digest, candidate-set digest, canonical hint,
portion binding, quantity, and the selection digest), so the display can never
claim a mass, source, or provenance the calculator rejects; a stale, forged,
cross-bound, or hand-built selection fails closed identically on both surfaces.
Source-portion selections deliberately carry no `catalog_digest` today (the
calculator does not verify one either); closing that gap is recorded as a later
contract revision, not done here.

**Truthful Apply→reopen provenance.** Apply persists the calculator's own
evidence, and the persisted schema-v1 block remains numerically and historically
truthful at Apply time. On reopen, a saved line whose basis is OMITTED (the
schema-v1 user-mass contract) hydrates as `user_mass`; a saved line whose basis
declares a USDA portion basis (`source_portion`) that the current context cannot
re-authenticate (for example a hint-dependent count portion, since schema v1
cannot persist the hint) restores only the reviewed FOOD identity: no user mass
is fabricated, no `user-entered` label is shown, the line stays NEEDS AMOUNT,
and the saved applied report is preserved unchanged. A replace-mode re-Apply
whose result would leave a previously applied line unresolved is REFUSED
(`applied_line_unresolved`) until that mass is resolved again, so no provenance
downgrade is ever written. Schema v2 (preserving hint-dependent count
provenance) remains future work and does not exist.

**Hint authority.** The hint remains interpretation-only: it may fill a missing
count unit/size from the closed vocabulary and never supplies an amount, FDC id,
gram weight, portion index, or digest. Local deterministic code regenerates and
authenticates every candidate.

**No household registry.** Phase 0B adds no household-portion registry, no
household gram values, no new mass source, and no parsing or amount vocabulary. A
vetted household-portion registry remains future work and is not implemented.

### 20.12 Phase 1 — canonical ingredient parsing completeness

Phase 1 makes deterministic parsing understand the quantity and household-unit
language real recipes use, WITHOUT adding any mass authority. It introduces no
household gram registry, no guessed grams, no new AI authority, no schema v2, no
saved-hint persistence, and no automatic persistence. `parseCanonicalIngredientParts`
(`src/utils/measurements.ts`) is the ONE canonical parse, and
`parseRawIngredientMeasurementParts` is its legacy projection (there is no second
parser).

**Canonical quantity (exact vs range).** The parse exposes
`quantity.kind ∈ {exact, range, absent, invalid}`, an exact `amount` populated
ONLY for an exact quantity, and `lower`/`upper` endpoints for a true range
(`1-2`, `1–2`, `1—2`, `1 to 2`, `1/4-1/2`, `1 1/2-2`). A range is NEVER collapsed
to one endpoint: `amount` stays null, no grams are derived from a bound, and the
complete range (including its unit) is removed from the food phrase with no
fragments. Malformed ranges are unresolved (`invalid`): missing endpoints,
reversed or non-positive endpoints, chained ranges (`1-2-3`), mixed-unit ranges
(`1 cup-2 tbsp`), excessive endpoints (`MAX_CANONICAL_RANGE_QUANTITY`), dates
(`2024-01-02`), negative signs, model numbers, and hyphenated food words. The
pre-existing closed mixed-fraction contract is preserved: `2-1/2` is the mixed
number `2 1/2`, never a reversed range. The canonical parse contract is versioned
(`CANONICAL_INGREDIENT_PARSE_VERSION`, currently `canonical_ingredient_parse_v2`);
v2 exists solely because leading spelled-out cardinals (`one cup flour`) now
classify as exact quantities, which changes the canonical classification of
already-valid inputs. `originalText` always preserves the bounded, trimmed source
wording the user authored; the expanded numeral is an internal working form used
only for quantity parsing, so provenance (`line_ref`, `original_text`), food-text
fallbacks, hydration, and Apply bindings never expose a rewritten numeral. The
query-normalization and projection version ids are unchanged because
normalized-query semantics did not change — only the parsed food phrase does, and
every digest binds the phrase it actually used, so stale selections fail closed.
`parse_version` is currently informational: it is exposed on the parsed review
view but is not part of any digest and is not persisted in any nutrition schema.

**Word cardinals (closed set).** A leading spelled-out cardinal `one` … `twelve`
(case-insensitive) is recognized only when it directly precedes an already
supported mass, volume, count, or container unit (`one cup flour`,
`two cloves garlic`, `three tbsp olive oil`, `one tin chopped tomatoes`). The
numeral expands into an internal working form handled by the existing amount
parser; no new unit vocabulary, generic mass, guessed grams, or default amount is
added. `a`, `half`, `quarter`, ordinals (`first`), compound word numbers
(`twenty one cups`), and word numbers not followed by a supported unit
(`one pot chicken`) remain unrecognized, and the path never bypasses the
compound-food collision policy (`one bottle gourd`, `one head cheese`,
`one leaf lettuce` keep their full food identity and original wording). The
`tin`/`tins` alias remains authority-identical to `can`/`cans` and never implies
mass.

**Household count vocabulary (one owner).** `src/utils/householdUnits.ts` is the
ONE canonical owner of the Phase 1 classifications: count nouns (clove, slice,
piece, stick, head, stalk, sprig, bunch, leaf, fillet, breast, thigh, rib, strip,
link, scoop, item) and containers (can, package, jar, box, bag, bottle), with
closed singular/plural aliases. The legacy unit map and the calculation
count-portion vocabulary derive from it (there is no fifth vocabulary). Count
nouns are classified as count metadata and NEVER assigned mass. Newly recognized
count units may enter the existing authenticated USDA count-portion path only
when a compatible authenticated USDA portion exists and every existing
digest/session binding passes; ambiguity still fails to review and otherwise the
line stays `NEEDS AMOUNT`. No fallback gram table exists, and `jar`/`box`/`bag`/
`bottle` are deliberately NOT count conversion units.

**Count nouns after the food.** A trailing count noun whose grammatical role is
unambiguous becomes amount metadata (`2 garlic cloves, minced` → unit `clove`,
food `garlic, minced`; `2 celery stalks` → `celery`; `4 bacon slices` → `bacon`).
Identity-bearing count nouns (`3 chicken breasts`, `4 spare ribs`, `2 bay
leaves`, `2 salmon fillets`, `2 fish sticks`, `2 sausage links`, `2 lemon strips`)
are still recorded as amount metadata but are deliberately RETAINED in the food
phrase, because removing them would erase a true food head. Classification
requires an explicit quantity and uses token-boundary/grammatical-position logic
only: `bottle gourd`, `head cheese`, `spare ribs`, `bagel`, `breadstick`, and
`chicken-fried` are never split by substring replacement.

**Compound-food collision policy.** A leading household unit must never erase a
true food head. `src/utils/householdUnits.ts` owns a closed, bounded collision
map of unit nouns that also begin a legitimate compound food name —
`bottle gourd`, `head cheese`, `leaf lettuce` (singular and plural heads) — with
each entry documented. A collision head immediately after the unit (without an
explicit `of` separator) leaves the unit token in the food identity: `1 bottle
gourd` / `2 bottle gourds` keep food `bottle gourd(s)` with no container
classification and no mass, and `1 head cheese` keeps `head cheese`. An explicit
separator is unambiguous container grammar (`1 bottle of hot sauce` classifies
`bottle`), and ordinary container lines are unaffected (`1 bottle hot sauce`,
`1 jar marinara sauce`, `1 box pasta`, `1 bag spinach`, `1 can black beans`,
`1 head cabbage`). This is deliberately NOT a broad food lexicon, and collision
detection is token-boundary based. Substring safety is unchanged: `bagel`,
`breadstick`, `chicken-fried`, `spring roll`, `fish sticks`, `spare ribs`,
`sausage links`, `bay leaves`, and `lemon strips` are never split.

**Container/state cleanup never widens authority.** Cleaning a package or
container expression may only restore an identity that the equivalent ordinary
line already has. `chickpeas`, `1 can chickpeas`, `drained chickpeas`, and
`1 can drained chickpeas` share the established automatic identity
`Chickpeas, NFS` (a state-neutral record that asserts no raw/cooked/canned/
drained claim); the package forms `1 400 g can chickpeas`, `1 can (400 g)
chickpeas`, and `1 (400 g) can chickpeas` bind exactly that same identity and
never a stronger one. State-ambiguous or non-matching wording withholds
automatic authority and stays reviewable: `canned chickpeas`, `garbanzo beans`,
and `1 can garbanzo beans` bind nothing automatically, and `canned` is retained
in the food phrase. No package net mass is calculation authority, and no false
state claim is ever produced.

**Package net mass.** An explicit package net mass is extracted and represented
truthfully and separately from the outer count: `(15 oz) can`, `400 g can`,
`can (15 ounces)`, with `per_container` vs `total` scope only where the grammar
is deterministic. The outer count quantity, container, net-mass quantity/unit,
scope, core food phrase, and original text are retained independently. The parse
NEVER multiplies package count by package mass, never converts the net mass into
mass authority, and never treats it as a generic container mass; no manufacturer
lookup, web lookup, AI interpretation, or package-size table is involved.

**State / size / variety preservation.** Preparation, state, size, variety, and
preparation words are retained for later projection (`2 medium potatoes`, `1 red
bell pepper`, `1 can diced tomatoes`, `1 lb ground beef`, `2 cups cooked rice`,
`1 cup dry rice`, `fresh thyme`, `dried thyme`). Classifying a count/container
token never discards them.

**Matching and calculation boundaries (unchanged authority).** Parsing cleanup
may improve the food text used by matching, but automatic-match safety
thresholds, the Phase 0A secondary-component veto, the Phase 0B effective-mass
authority, direct recipe mass, and the authenticated-only mass rules are all
unchanged. Ranges do not calculate from an endpoint; package net mass is not
generic mass; newly recognized household units derive grams only from
authenticated USDA portions; otherwise a line remains reviewable or
`NEEDS AMOUNT`. AI still cannot supply range endpoints, package mass, FDC ids,
grams, portion indices, digests, or authorization.

**Count-vocabulary differential (measured).** Against the real pinned bundle
(13,559 eligible records), the Phase 1 count vocabulary adds 648 newly
classified portions (fillet 169, breast 114, thigh 107, scoop 78, leaf 48,
link 46, strip 39, rib 21, sprig 11, stalk 10, bunch 5) and reclassifies 339
portions from a bare-size or compound wording to the correct unit (for example
`strip large`, `breast medium`, `bun-size … link`); no portion lost a
classification, and 669 records changed count-candidate membership for the
closed probe set (571 gained a new-unit candidate, 150 narrowed their
size-only candidates). Every change is a candidate-membership change; there
were zero digest-only changes, no lost authenticated match, and no generic
weight. `3 large carrots` now resolves only the authenticated whole-large-carrot
portion (72 g) because the record's `strip large (3" long)` portion is
correctly a strip (verified as a 7 g strip candidate under a strip
requirement), and calculation and live projection agree at 3 x 72 g.

**Not implemented.** A ranking-policy redesign, a household gram registry,
density conversions, generic package weights, AI-authored grams or ids, schema
v2, saved-hint persistence, and the source-portion catalog-digest revision remain
future work and do not exist.

---

### 20.13 Phase 2 — deterministic query + food-class projection

Phase 2 adds ONE canonical, bounded, versioned query projection
(`projectQueryText` in `src/core/nutritionV2/matching/query.ts`) that turns the
Phase 1 parsed food phrase and amount metadata into deterministic identity
evidence. It adds no second parser, no household gram values, no AI authority, no
persistence change, and no general ranking-policy redesign.

**Owner and version.** `projectQueryText` remains the single projection owner
(`QUERY_PROJECTION_VERSION = 'usda_query_projection_v10'`). The projection version
is part of the review-catalog digest, so a review/confirmation produced under an
older projection fails closed (`stale_review`). `MATCH_CONFIDENCE_VERSION` is
`usda_match_confidence_v12` because the automatic-authority contract gained
state-contradiction, container-state-compatibility, and preparation-form
contradiction evidence. That phase changed no persisted nutrition schema
(`CODEX_NUTRITION_SCHEMA_V1` remained 1 then; Phase 6 later introduces the
versioned v1/v2 contract described in §37.5).

**Descriptor roles.** The projection exposes explicit, bounded roles:
`core_tokens` (food-name tokens), `primary_identity_tokens` (the required head —
the accepted tokens of the directional alias anchor, else the last core token,
else the last identity token; the anchor groups are BUILT from these tokens, so
production matching authority consumes this field directly), `state_tokens`
(closed physical states: raw/cooked/canned/dried/dehydrated/frozen/fresh/drained/
undrained/ground/whole/...), `preparation_qualifiers`, `size_qualifiers`,
`variety_tokens` (closed cultivar/color vocabulary), `form_tokens`,
`count_noun`/`container` (Phase 1 amount metadata), and
`secondary_component_tokens` (relational/flavor evidence only). Unknown words
are NEVER discarded: an unrecognized descriptor stays in `core_tokens` as
identity evidence. There is no stemming, fuzzy matching, external NLP, or AI.
Qualitative cues are owned earlier (`ingredientSemantics`/Phase 1) and are NOT
carried by the projection.

**Phase 1 consumption (one authority path).** `projectQueryText(text, context?)`
accepts an optional bounded Phase 1 context (`count_noun`, `container`) and copies
validated values verbatim; it never re-detects ranges, package net mass, count
nouns, or containers with a second grammar. The canonical automatic-authority path
(`reviewIngredient` → review snapshot → `explainCandidate`/`selectAutomaticMatch`/
`selectBestEffortMatch`) consumes the Phase 1 count/container metadata; the
ranking/search path remains a documented text-only fallback because count and
container are amount metadata and never change membership or order.

**State contradiction and container-implied canned.** A closed, symmetric
opposition table withholds automatic authority when the query declares a physical
state and the candidate explicitly declares the opposite: raw/uncooked vs cooked,
fresh vs dried (equivalence covers powdered/dry), fresh vs frozen, canned vs
raw/fresh, drained vs undrained, ground vs whole. A candidate that is silent about
state is NOT a contradiction (`whole almonds` stays eligible). A `can`/`tin` line
supplies the `canned` state from Phase 1 container metadata (no other container
implies any state): a raw/fresh candidate is contradicted, and a state-silent
named variety (`Tomato, roma`) is withheld because canning is a strong
preservation claim, while an explicit canned token or a generic family record
(`NFS`/`NS`/`unspecified`) stays compatible.

**Preparation-form contradiction.** A closed form vocabulary
(`PREPARATION_FORM_CANONICAL`) maps explicit preparation/product forms to
canonical ids: diced, crushed, sliced, chopped, minced, mashed, pureed/purée,
shredded, grated, whole, halved, quartered (with closed surface aliases for
plurals and accents). When the query explicitly requests a recognized form and
the candidate explicitly declares a DIFFERENT canonical form, automatic authority
is withheld (`preparation_form_contradiction`, reason
`preparation_form_contradiction`) because the substitution would materially
misrepresent the named ingredient (`1 can diced tomatoes` must never be silently
satisfied by `Tomatoes, crushed, canned`). A candidate SILENT about preparation
form is neutral; an explicit matching form is compatible; form agreement can
never GRANT authority (missing core identity still fails). Words that legitimately
coexist with a cut form (`peeled`, `trimmed`, `cooked`, `drained`, `seasoned`,
`unprepared`, `crumbled`, ...) are deliberately not in the vocabulary. The rule
is negative-only, feeds both strict and best-effort contracts (and therefore the
analyzer and AI-assisted deterministic verification, which validate against the
same contracts), does not participate in the ranking comparator, and never
removes a candidate from review.

All Phase 2 evidence is negative only: it can withhold/demote automatic
authority but can never manufacture a match, never grants positive authority, and
never removes a candidate from ranking or review. Phase 0A's secondary-component
guard remains the sole owner of the secondary-component veto and is reused, not
duplicated; `family_mismatch` (product/dish head, derived component, foreign
head, secondary-only) and `missing_core_identity` remain the head/class safety
surfaces. Candidate explanations expose bounded reason enums:
`state_contradiction`, `container_state_incompatible`,
`preparation_form_contradiction`, `secondary_component_only`,
`food_family_mismatch`, `missing_core_identity`.

**Reviewed corpus changes.** On the real pinned bundle, the corrected Phase 2
result for `1 can diced tomatoes` and `2 (14.5 oz) cans diced tomatoes` is NO
automatic identity on any path: the raw tomato record is state-contradicted, the
canned crushed sibling is a preparation-form contradiction, and the catalog's
correct canned diced record (333281) ranks outside the bounded candidate set.
Both lines stay truthfully review-required/review-suggested with no grams and no
nutrients, and canned tomato candidates stay visible for explicit review. The
same explicit form remains legitimate (`1 can crushed tomatoes` selects the
canned crushed sibling 170501). `1 can sliced mushrooms` selects no whole/
chopped/minced/crushed mushroom record. For `1 can black beans` and `1 can tuna`
the strict automatic selection is withheld (the state-neutral NFS record ties the
requested canned sibling on the auto-authority key); best-effort/analyzer keep
`Black beans, NFS` (2707359) for the beans line, while the tuna line's pipeline
identity remains the authenticated portion-bearing canned sibling (2706311) with
the audited 115 g can portion. Every other measured line keeps its identity,
mass, and status; direct mass (`1 lb ground beef (80/20)`), bacon count mass (4/8
slices), range no-grams, word-cardinal, tin-alias, package net mass,
cooked-vs-dry rice, and Phase 0A sardine/tomato-sauce safety are unchanged.

**Not implemented (registry work).** NFS/default preference, penne shape
fallback, duplicate-record collapsing, a household portion registry, generic
produce masses, package/container mass conversion, and density conversion remain
future work and do not exist. Container-derived state is limited to `can`;
`jar`/`box`/`bag`/`bottle`/`package` remain amount metadata only.

---

### 20.14 Phase 3 — smarter ranking + automatic-match authority

Phase 3 improves deterministic ordering and authority evidence for ordinary
ingredients without lowering a single existing authority threshold. The safety
rule is unchanged: **a safely unresolved ingredient is better than a confidently
wrong food**, and withholding authority is an acceptable outcome.

**Plain before unrequested specialty.** A new closed specialty vocabulary
(`SPECIALTY_VARIANT_TOKENS`: flavored/flavour spellings, fortified, seasoned,
colored/coloured, spinach, chili, and unrequested plant-part `seed`/`seeds`)
introduces `unrequestedSpecialtyCount`. An unrequested specialty is demoted in
the ranking tuple after composed product FORMS (so a frozen dinner can never
outrank a same-food specialty) and before material-state/compound dimensions,
and it blocks automatic authority (strict and best-effort) with the bounded
reason `unrequested_specialty`. An explicitly requested specialty (`spinach
spaghetti`, `dill seed`, `seasoned salt`, `chili sauce`) is in the requested set
and is unaffected. Botanical dry-legume wording (`Beans, black, mature seeds`)
is exempted. This is deliberately NOT a food taxonomy: only tokens observed to
outrank a plain sibling are listed. Plain-before-specialty also uses the
existing conflict-qualifier, subtype, unrequested-form, prepared-product, and
compound penalties; `product`/`products` joined the benign descriptor set so the
plain `Tomato products, canned, sauce` record is no longer compound-penalized
below `Tomato chili sauce`.

**Explicit variety constraints.** `varietyContradictionCount` withholds
automatic authority (reason `variety_contradiction`) when the query names a
variety/color/cultivar and the candidate explicitly names a DIFFERENT one
(`white rice` vs `Rice, red`; `red bell pepper` vs a green pepper). A candidate
silent about variety is NOT a contradiction (a less-specific record may rank as a
safe fallback), and a generic `NFS`/`NS` record enumerating options is exempt.
Ranking demotes a contradiction below matching and silent candidates. The AI
source-constraint path (`resolveFoodsFromAiSuggestions`) applies the same veto
against the authenticated source line, so an AI suggestion can never erase a
source variety (`1 cup dry white rice` + AI `dry rice` no longer binds red rice).

**Late data-type tie-break (bounded equivalence).** `sr_legacy > foundation >
fndds` is applied ONLY after every semantic dimension has tied (identity
coverage, family, prepared product, specialty, state/form, variety, compound,
subtype, extra tokens, generic marker, order agreement). Two records that tie on
all of those dimensions are equivalent under the existing comparator contract
(identical normalized descriptions in the measured cases), so the tie-break
cannot outrank food identity and never participates in automatic authority (the
runner-up ambiguity contract still decides). SR Legacy is preferred because its
authenticated household portions remain the source of the existing count-portion
mass authority (Foundation records often carry only a RACC portion — switching
`Garlic, raw` to its Foundation sibling would have silently removed the
authenticated 3 g/9 g clove portions); Foundation precedes FNDDS survey dishes.
If equivalence cannot be proven, both candidates are retained and the normal
ambiguity/review contract withholds authority. `MATCHING_RANKING_VERSION` is
`usda_match_rank_v11`; `MATCH_CONFIDENCE_VERSION` is
`usda_match_confidence_v13`; `AI_RESOLUTION_VERSION` is
`nutrition_ai_resolution_v3` (the source-variety veto extends the AI
verification contract). `QUERY_PROJECTION_VERSION` stays v10 (no projection
shape/semantics change). Review digests bind the ranking version, so stale
reviews fail closed; no persisted schema changed.

**Measured Phase 3 corpus (28 lines, real pinned bundle).** Automatic identity
changes are exactly one: `canned tomato sauce` (and `3 cans tomato sauce`)
review-required -> 170054 `Tomato products, canned, sauce` (the plain canned
tomato product; fish/sardine/dish descriptions remain forbidden). Every
other line keeps its audited automatic identity and grams, including
`1 lb ground beef (80/20)` 174036, `3 garlic cloves` / `2 garlic cloves,
minced` 169230 (the SR Legacy records whose authenticated portions back the
count-portion authority), `1 can tuna` 2706311 with 115 g, `4 slices bacon`
168277 with 112 g, and `1 cup white rice` 168879 with 195 g. Ordering
improvements with unchanged identity: `fresh dill` / `fresh dill for garnish`
top 170925 (dill seed) -> 172233 (Dill weed, fresh); `tomato sauce` top 2709735
(Tomato chili sauce) -> 170054 (Tomato products, canned, sauce); `spinach
spaghetti` keeps the requested spinach record top while `2 cups penne pasta`
demotes spinach pasta below plain pasta; `1 jar marinara sauce`/`low sodium
marinara sauce`/`1 red bell pepper` reorder only by the late tie-break. Safety
metrics: incorrect automatic identities 0; explicit variety/state/form
contradictions granted authority 0; primary/secondary false automatic matches 0;
direct mass, source-portion, count-portion, and user-mass behavior unchanged.
`2 cups penne pasta` remains `NEEDS MATCH` (no authentic penne identity);
`fresh dill for garnish` remains reviewable; `2 medium potatoes`, `1 can tuna`,
and `1 can black beans` are not improved by guessing state.

**Boundaries unchanged.** USDA remains the only nutrient authority; AI remains
interpretation-only (no FDC id, grams, portion, digest, or authorization; the
resolver re-verifies everything locally against the session-bound source line);
explicit user choices remain final; Apply remains the only persistence boundary.
No household registry, density conversion, package/container mass conversion,
schema v2, saved-hint persistence, provider-catalog change, or unrelated UI work
is implemented.

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
is implemented (5A authorization + 5B explicit Apply + 5C consolidation), while
Phase 6 (Vault Intelligence) remains unimplemented.

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

Phase 5C is implemented in §24. Phase 5B itself does not consolidate the legacy
estimator, does not remove or migrate legacy/simple nutrition, and does not
redesign schema v1.

**Phase 5B persists ONLY on an explicit user Apply, re-proves Phase 5A authority
immediately before the write, and performs a whole-block vault-safe update.**

---

## 24. Phase 5C — consolidated Nutrition experience

Phase 5C is PRESENTATION / WORKFLOW consolidation only. The application still
contains two storage representations for backward compatibility — the legacy
simple `nutrition` / top-level `calories`, and the schema-v1 `codex_nutrition`
block — but a recognized Advanced block is the single numeric authority.

**TWO SEPARATE EXPERIENCES (hands-on smoke repair).** The ordinary compact
`Nutrition & Macros` card is ALWAYS visible. Advanced Nutrition is a SEPARATE
secondary card for the reviewed USDA match/portion/Apply workflow. A saved
Advanced result NEVER hides or replaces the normal card; instead the normal card
DERIVES its compact calories/protein/carbs/fat/fiber/sodium from the saved
Advanced block (`deriveAdvancedCompactNutrition`). There is no second competing
stored dataset, and a nutrient absent from the Advanced block is never "topped
up" from legacy values.

Module: `src/core/nutritionV2/phase5c/` (pure selector) +
`src/components/RecipeNutritionSection.tsx` (two-card surface) +
`src/components/RecipeNutritionCard.tsx` (normal compact card) +
`src/components/AdvancedNutritionCard.tsx` / `AdvancedNutritionModal.tsx`
(separate Advanced workflow).

### 24.1 Precedence rule

The single pure selector `resolveRecipeNutritionPresentation(recipe)` returns a
closed kind:

| kind | meaning | normal card values | Advanced card |
| --- | --- | --- | --- |
| `advanced_saved` | valid recognized schema-v1 block, basis matches the recipe | derived from Advanced | shown separately |
| `advanced_stale` | valid block whose serving/ingredient basis no longer matches | derived from Advanced + stale notice | shown separately |
| `advanced_unsupported` | opaque unknown FUTURE schema | labelled legacy fallback | notice + preserved |
| `advanced_invalid` | malformed recognized schema-v1 block | labelled legacy fallback | notice + preserved |
| `legacy` | no recognized block, but legacy nutrition / calories exist | legacy values | upgrade affordance |
| `none` | neither representation exists | empty/legacy fallback state | upgrade affordance |

When a valid recognized Advanced block exists, **Advanced is the preferred
numeric authority** for the compact normal card. Legacy/simple nutrition remains
stored untouched for backward compatibility but never overrides a displayed
Advanced nutrient. The Advanced card is always separately reachable.

### 24.2 Non-destructive by construction

Phase 5C does NOT delete legacy `nutrition` or top-level `calories`, does NOT
rewrite legacy nutrition, does NOT migrate legacy values into `codex_nutrition`
(or the reverse), does NOT merge or average conflicting values, and does NOT
change the schema. The selector is pure, deterministic, read-only, and never
mutates its input (proven by mutation-sensitive tests). Merely viewing a recipe,
toggling details, or running a review causes ZERO writes.

### 24.3 Saved Advanced behavior

A recognized saved block feeds the normal compact card (derived) AND remains
available in the separate Advanced card. Per-serving values are DERIVED at
display time from the stored whole-recipe totals and the block's stored serving
denominator (`total / storedServings × requestedServings`); no second nutrient
map is persisted. Partial status and unresolved evidence are displayed honestly —
a partial Advanced result is never "topped up" from legacy values.

**Single-authority normal calories.** While a recognized Advanced block is
preferred, the normal card's calories are derived ONLY from that block. If the
block contains no `calories` nutrient, the card shows no value — it NEVER falls
back to legacy/top-level `calories`. Legacy calorie fallback applies only when
Advanced is not the preferred authority (`legacy` / `none` /
`advanced_unsupported` / `advanced_invalid`). The header calories use the same
centralized resolver.

**Partial vs complete (whole-surface authority).** A recognized Advanced block
is projected into the normal card ONLY when it is COMPLETE
(`status === 'complete'` and no unresolved ingredient lines). A recognized but
INCOMPLETE block is NEVER shown as isolated partial nutrients (e.g. `Fat 91.3 g`
while calories/protein are `—`). Instead the normal card shows an explicit
incomplete state (`Advanced nutrition incomplete · N of M ingredient lines
resolved · Open Advanced Nutrition to finish review`) and the separate Advanced
card shows `Advanced Nutrition saved — partial` (or `saved · Complete coverage`
when complete). There is NO per-nutrient legacy top-up and NO merging — the
authority decision is whole-surface. Partial nutrient detail remains available
inside Advanced, which communicates coverage/unresolved/provenance explicitly.

### 24.4 Legacy fallback behavior

When no recognized saved Advanced block exists, the existing simple
Nutrition & Macros values continue to display as the legacy/quick-estimate
fallback, and the existing AI/simple estimator remains available (unchanged,
explicitly user-triggered). The hierarchy is explicit: the legacy estimate is a
fallback, not equivalent to an authenticated saved USDA result. The Advanced
review/apply affordance stays reachable for every recipe so a legacy/empty recipe
can still be upgraded.

### 24.5 AI / simple estimator role

The simple/AI estimator is NOT removed. When a valid saved Advanced block exists,
the legacy estimator is de-emphasized (its card is hidden) so it cannot compete
with or overwrite the Advanced result; it is not run automatically, its values
are never presented as the primary result, and its persistence remains isolated
to the existing legacy `nutrition` fields. For legacy-only recipes it remains the
supported workflow.

### 24.6 Stale saved result

If the recipe's servings or measurable-ingredient set changes after Advanced was
saved, the block is reported `advanced_stale` (with the reason). The saved block
is preserved and remains the display authority with an explicit "may be out of
date — recalculate and Apply" notice; stored totals are never silently adjusted,
and the legacy estimator never silently masks the stale state. Detecting
staleness writes nothing.

**Adaptation failure fails closed.** If the current recipe cannot be adapted
(empty/unreadable/malformed ingredient structure), the saved basis CANNOT be
verified, so the saved result is reported `advanced_stale` with the bounded
`ingredients_changed` reason rather than being silently trusted as current. The
saved block is never deleted or mutated, no nutrition value is fabricated, and
the stale/recalculate warning is shown.

### 24.7 Unknown / malformed saved block

An opaque unknown FUTURE schema is preserved untouched and reported
(`advanced_unsupported`); it is never interpreted, overwritten, migrated, or
downgraded, and the estimator cannot destroy or replace it. A malformed
recognized schema-v1 block is reported (`advanced_invalid`) and preserved; Apply
fails closed (Phase 5A/5B unchanged). In both cases the legacy fallback may be
shown only with an explicit "Legacy estimate" label so the user is never misled
into thinking the saved Advanced data disappeared.

### 24.8 Saved vs. unsaved review

A saved block remains the persisted display authority even when an unsaved
review/preview exists. The Advanced surface labels the saved summary
("Saved Advanced Nutrition") separately from the in-memory review ("Unsaved
review — not applied"). Only a successful explicit Apply replaces the saved
authority; a failed Apply leaves the previously saved result primary and never
mutates legacy nutrition.

### 24.9 Top-level calories

Existing top-level `calories` is never overwritten or deleted. For display, when
a valid recognized Advanced block is preferred the consolidated header calories
use ONLY the Advanced total (derived for the requested servings); a missing
Advanced calories nutrient shows no value rather than borrowing the top-level
value. Only when Advanced is not preferred does the existing legacy calorie
behavior apply. No synchronization write occurs.

### 24.10 Phase 5 completion boundary / Phase 6

Phase 5 implementation is complete: 5A (authorization), 5B (explicit Apply), and
5C (consolidation). Phase 5C is non-destructive and adds NO Vault Intelligence
behavior: it does not scan the vault for nutrition completeness, does not add
nutrition to Vault Intelligence health scores, does not auto-repair or
auto-recalculate recipes, does not build vault-wide nutrition indexes or graphs,
and has no bulk migration or bulk Apply. Phase 6 begins only after the independent
Phase 5C audit and the separate full smoke-test / release-control checkpoint.

**Phase 5C consolidates the nutrition EXPERIENCE without merging, migrating, or
rewriting either storage representation.**

## 25. Post-Phase-5 smoke-test remediation — automatic analyzer + exception-only review

This slice fixes real-user workflow problems found by smoke testing. It is NOT
Phase 6. It adds NO Vault Intelligence behavior, NO vault scan, NO bulk analysis,
NO bulk Apply, NO auto-repair, NO nutrition health scores, NO vault indexing, and
NO background migration. It does not redesign schema v1.

Core rule:

> `ANALYZE AUTOMATICALLY -> REVIEW EXCEPTIONS -> EDIT ANYTHING`

### 25.1 Problem

Phase 5A/5B/5C were safe but the workflow was too burdensome. Every ordinary
ingredient (`cottage cheese`, `unsalted butter`, `salt`, `ketchup`, ...) exposed
a long USDA candidate list and a source-portion list, so the user acted as a USDA
database curator. Smoke testing also exposed poor partial-match ranking: `flakes`
and prose tokens (`and`, `total`, `about`, `grams`) could become the required
matching anchor, so `0.5 cup unsalted butter, chilled and cubed` surfaced
peanut butter / bread-and-butter pickles and `3 to 4 slices provolone (about 75 to
100 grams in total)` surfaced quail / pheasant / salmon.

### 25.2 Root cause

The Phase 4.5D projection chose the required anchor as the LAST non-stopword
identity token. Preparation words (`chilled`), form words (`flakes`, `powder`),
and prose/conjunction words (`and`, `total`, `about`, `grams`) were not part of a
closed non-identity vocabulary, so they could become the anchor. Ranking also
counted `missing identity tokens` over the whole identity token list, so a
nutritionally significant qualifier (`unsalted`) penalised the correct plain food
and let a compound (`peanut butter`) win on a smaller extra-token count.

### 25.3 Core food identity (projection v2)

`projectQueryText` now separates:

- **core food identity** — the food-name tokens (the anchor is the last core
  token). This is what must match.
- **qualifiers** — nutritionally significant state/variant words (`unsalted`,
  `salted`, `raw`, `cooked`, `whole`, `skim`, `low`, `reduced`, `nonfat`,
  `sweetened`, `unsweetened`, `canned`, `dried`, ...). Preserved as
  agreement/opposition evidence, never the anchor.
- **forms** — food-FORM words (`powder`, `flakes`, `sauce`, `juice`, `paste`, ...).
  Preserved as requested-form evidence, never the anchor.
- **preparation / size / count-unit / noise** — `sliced`, `chilled`, `thinly`,
  `and`, `or`, `about`, `total`, `grams`, `to`, ... removed from identity.

Parenthetical asides (`(about 75 to 100 grams in total)`) and trailing
preparation clauses (`butter, chilled and cubed`, `onions, chopped`) are stripped
before tokenization. Preparation state words (`cold`, `chilled`, `room
temperature`, `softened`, `melted`, `cubed`, `diced`, `sliced`, `chopped`, ...)
never replace food identity. Punctuation is normalized BEFORE semantic-role
assignment, so a trailing comma can never attach to a token (`butter,` ->
`butter`) and a hyphenated word can never collapse into one token
(`gluten-free` -> `gluten free`). Generic non-identity words (`form`, `type`,
`style`, `variety`, `blend`, `product`, `food`, `item`, `include(s)`) are removed
from identity and, unlike descriptors, do NOT suppress compound demotion, so a
generic tail token cannot dominate (`Cheese, Mexican blend`).
`QUERY_PROJECTION_VERSION` is `usda_query_projection_v2`.

### 25.4 Ranking v6

The integer ordering tuple now includes, in order:

```
[class_rank,
 missing_core_identity_tokens,
 family_mismatch,
 qualifier_conflicts,
 qualifier_opposition,
 -qualifier_agreement,
 missing_qualifier_tokens,
 missing_form_tokens,
 unrequested_material_variants,
 unrequested_variety,
 compound_penalty,
 unrequested_subtype,            // level/type + zero-padded numeric subtypes
 contradiction,
 extra_candidate_tokens,
 -generic_marker,
 order_disagreement,
 fdc_id]
```

The display tuple is NOT the auto-authority key (see §25.5 and §25.13). The
presentation dimensions (`extra_candidate_tokens`, `order_disagreement`) and the
display-only `unrequested_subtype` demotion never convert a materially ambiguous
sibling into an automatic selection.

- **core-identity coverage** dominates: the plain food beats a candidate that
  merely shares the head noun as part of a different compound.
- **qualifier opposition** uses a closed opposite-pair table (`salted`/`unsalted`,
  `sweetened`/`unsweetened`, `enriched`/`unenriched`, `raw`/`cooked`,
  `whole`/`skim`).
- **compound penalty** counts candidate tokens that are not requested, are not
  recognised descriptors/qualifiers/forms, and are adjacent to the matched anchor
  (`peanut` in `peanut butter`), demoting compound foods without penalising
  `Butter, stick, unsalted`. A closed `COMPOUND_PREFIX_TOKENS` set overrides the
  category-head exemption so a category-looking prefix that is a real food
  (`Bread, rice`, `Flour, rice`, `Apple butter`) is still penalised.
- **unrequested material variants** demote a candidate carrying an unrequested
  preservation/state qualifier (`dried`, `canned`, `smoked`, ...), so `Apple,
  raw` ranks above `Apple, dried`.
- The stable FDC-id tie-break remains a presentation tie-break only; it can NEVER
  convert a semantic tie into an automatic selection.

`MATCHING_RANKING_VERSION` is `usda_match_rank_v7`. No network, no AI, no
nutrient values, and no floating-point ML-style scores are used. Determinism and
hostile-input guards are unchanged.

### 25.5 Deterministic confidence / automatic-selection contract

Module `src/core/nutritionV2/matching/confidence.ts` is the ONE authority for
auto-selection. Confidence is `high` / `review` / `unresolved`, derived ONLY from
explicit evidence (exact phrase, exact token multiset, full core-identity
coverage, qualifier agreement/opposition, form coverage, compound penalty,
unrequested material variants). A candidate is `high` (safe to auto-select) only
when it is an exact phrase / exact token multiset, or it contains every
core-identity token with no qualifier opposition, no qualifier/form conflict, no
absent requested qualifier/form, no compound demotion, and no unrequested
material variant. One-token partial overlaps among unrelated foods, FDC-id
tie-break winners, form mismatches, compound foods, and unrequested altered
variants are never auto-selected.

**Runner-up ambiguity (v4).** Before returning an automatic selection, the
runner-up set is inspected against the AUTO-AUTHORITY key (the identity and
requested-specificity tuple EXCLUDING the presentation-only FDC-id tie-break,
`extra_candidate_token_count`, `order_agreement`, and the display-only
`unrequested_subtype` demotion). If a runner-up ties the top on that key and
differs in an UNREQUESTED MATERIAL SUBTYPE (`whole`/`nonfat`/`heavy`/`half`/
`salted`/`dried`/`enriched`/zero-padded numeric grind, ...), NO automatic
selection is authorized. Benign descriptive differences (verbose USDA wording,
extra descriptors, cooking method, color, `whole` as the ordinary member, and
health-claim modifiers such as `lowfat`/`reduced`/`light`) do NOT make two
records ambiguous. FDC id, shard order, input order, and `data_type` never create
semantic authority.

**Fail-closed by construction.** `classifyReviewConfidence`,
`selectAutomaticMatch`, `isDeterministicAutomaticSelection`, and
`explainCandidate` return closed outcomes for null/undefined/malformed input
rather than throwing. If the contract does not authorize an automatic choice, the
row is `matched_check` (review suggested) when a credible candidate exists, or
`needs_match`/`unresolved` otherwise; the user reviews it.

### 25.6 Automatic authenticated portion resolution

After a food is safely selected, `analyzeRecipe` resolves a source portion
deterministically, in priority order:

1. an exact compatible requested unit identity (`tsp`, `cup`, ...);
2. within that, a requested preparation/qualifier descriptor (`tsp, ground` for
   `ground black pepper`);
3. otherwise a uniquely compatible set whose compatible portions all resolve to
   the SAME authoritative mass.

Differing authoritative gram weights are ambiguous and are NOT auto-chosen. No
averaging, no density guess, no invented conversion. Authenticated count portions
keep their existing Phase 4.5E deterministic resolution. A row whose mass cannot
be resolved fails closed to `Needs amount`. An explicit mass RANGE in the source
text (`about 75 to 100 grams in total`) suppresses automatic resolution and
requires review rather than inventing one number.

### 25.7 Compact analyzer UI + Edit

The modal now presents a compact per-ingredient analysis: original ingredient,
selected USDA food, resolved mass (when known), a concise status badge
(`Matched`, `Review suggested`, `Needs amount`, `Needs match`, `Qualitative`,
`Unresolved`), and an `Edit` control. Candidate lists and portion/weight tools
are hidden by default and appear ONLY for the row being edited. `Edit` exposes the
existing detailed review tools (USDA candidates, `None of these`, source
portions, count portions, manual total weight). `Analyze Nutrition` is the primary
one-click action: it applies the deterministic selections, auto-portions, and the
advisory preview atomically. Internal match-class jargon is not the primary UX.

### 25.8 Truthful automatic vs user semantics

An analyzer selection is recorded in the Phase 4 state with an `automatic: true`
marker. The calculation engine honours that marker ONLY when the deterministic
confidence contract independently confirms the chosen candidate is the automatic
choice. If a caller claims `automatic_selection: true` and the claim does not
validate, the calculation FAILS CLOSED (`invalid_ingredient_input`); an invalid
automatic claim is NEVER reinterpreted as a literal user confirmation. Manual
confirmation requires the genuine manual path (no `automatic` marker). In the LIVE
Phase 3 calculation evidence, an analyzer selection is `match_status:
'auto_confirmed'`
with `user_confirmed: false`; an explicit user choice is `user_confirmed` with
`user_confirmed: true`; a unique exact match is `unique_exact` with
`user_confirmed: false`. That is the truthful, in-memory distinction.

Persistence keeps the ESTABLISHED schema-v1 persisted-review semantics
(§22.2 / §22.12): a resolved evidence record is `match_status: 'confirmed'` +
`resolved: true` + `user_confirmed: true`, meaning "this evidence was part of the
explicit reviewed result the user authorized for Apply". The schema-v1 validator
requires exactly that shape for resolved evidence, and this slice does NOT
redesign schema v1. The automatic-vs-user distinction is not lost: it remains in
the live review state and the Phase 3 evidence the authorization is derived from;
it is simply not a separate persisted field, because schema v1 has no bounded
representation for "resolved but not user-confirmed" and inventing one would be a
schema redesign.

### 25.9 No persistence until Apply

Analysis, auto-selection, auto-portions, and the preview are all in-memory and
advisory. Nothing is written to the recipe or vault. Phase 5B Apply remains
explicit and whole-block, and Phase 5A recomputation / candidate digest / stale
authorization / unknown-future-schema protection are unchanged.

### 25.10 Not AI

This is deterministic offline matching. It does not call AI, does not use
nutrient values to choose a food, does not use the network, and does not expose
secrets. The same input plus the same authenticated USDA bundle produces the same
analysis.

### 25.11 Consolidated independent audit repair

A consolidated audit of the automatic analyzer found deterministic wrong-food
automatic selections. They are repaired in place; the one-click analyzer and the
explicit Apply architecture are unchanged.

| Finding | Repair |
| --- | --- |
| `1 cup rice` auto-selected `Bread, rice` | `COMPOUND_PREFIX_TOKENS` overrides the category-head exemption; `Bread, rice` is demoted and never auto-selected. |
| `1 cup cream` auto-selected cream-style corn | Generic `style`/`blend` no longer suppress compound demotion; corn is demoted below real cream. |
| `1 stick unsalted butter, cold` corrupted identity | Punctuation is normalized before role assignment; `cold`/`room`/`temperature` are preparation words; identity stays `unsalted butter`. |
| `1 cup butter` semantic tie became auto via FDC id | Runner-up ambiguity contract: a materially different semantic tie fails the whole auto-selection. |
| `1 apple` auto-selected `Apple, dried` | Unrequested material-variant penalty + HIGH eligibility requires zero unrequested variants; `Apple, raw` ranks first. |
| `2 eggs` auto-selected `Egg, whole, dried` | Same policy; `Egg, whole, raw` is preferred. |
| `1 cup milk whole` dry milk could win | Same policy; `Milk, whole` wins. |
| `200 g gluten-free flour blend` recommended `Cheese, Mexican blend` | `blend` is a generic non-identity token, so the anchor is `flour` and cheese-blend records are excluded. |
| Forged `automatic_selection: true` degraded to `user_confirmed` | Calculation fails closed (`invalid_ingredient_input`) when an automatic claim does not validate. |
| Confidence helpers could throw on null/malformed input | `classifyReviewConfidence` / `selectAutomaticMatch` / `isDeterministicAutomaticSelection` / `explainCandidate` return closed outcomes for null/undefined/malformed input. |

The compound-food policy is unchanged in spirit: a token inside a compound food
never implies identity (`rice != rice bread`, `cream != cream-style corn`,
`butter != peanut butter`, `pepper != pepper steak`, `tomato != tomato sauce`
unless sauce is requested). Explicitly requested forms remain valid
(`tomato sauce` -> tomato sauce, `peanut butter` -> peanut butter).

### 25.12 Generic-family / variety-bias repair

A final independent audit found a shared generic-vs-specific bias: the
extra-token count and benign treatment of variety tokens let a specific variety
outrank the generic/NFS family member, and material-state words such as
`powdered` could match unrelated literal descriptions outside the requested
family.

**Food family.** Family is derived from CORE IDENTITY tokens (the anchor is the
last core token). A candidate whose HEAD token is a composed PRODUCT/DISH head
(`PRODUCT_HEAD_TOKENS`: `dessert`, `candies`, `snacks`, `soup`, `salad`,
`dressing`, `granola`, `head`, `bar`, ...) is a `family_mismatch` and can never
be the automatic choice for a raw-food-family query (`Dessert topping, powdered,
... milk` for `powdered milk`, `Candies, SYMPHONY Milk Chocolate Bar` for
`milk chocolate`, `Head cheese` for `cheese`).

**Generic / NFS preference.** A closed `VARIETY_TOKENS` set (colors, cultivars,
cheese types, rice/flour types) marks a specific variety. An UNREQUESTED variety
token makes a candidate ineligible for automatic selection and demotes it below
the generic family member (`Cheese, blue` for `cheese`, `Tomato, roma` for
`tomato`, `Rice, black` for `raw rice`, `Flour, whole wheat` for `flour`).
`GENERIC_MARKER_TOKENS` (`nfs`, `ns`, `unspecified`) is a tie-break preference
for the plain family member, applied AFTER the extra-token count so it can never
override a state or variety preference (it never turns `Tomatoes, NS as to form,
cooked` into an auto choice over `Tomatoes, raw`).

**Requested specificity still wins.** An explicitly requested variety remains
authoritative: `blue cheese` -> `Cheese, blue`, `cheddar cheese` -> `Cheese,
cheddar`, `roma tomato` -> `Tomato, roma`, `black rice` -> `Rice, black`,
`whole wheat flour` -> `Flour, whole wheat`.

**Material state refines family.** `STATE_EQUIVALENCE_GROUPS` treats
`powdered`/`powder`/`dry`/`dried`/`dehydrated` as equivalent, so `powdered milk`
is satisfied by `Milk, dry, ...` (a milk-family record) and never by an
unrelated `... powdered ...` product. `evaporated milk` -> `Milk, evaporated,
...`; `condensed milk` -> `Milk, condensed, sweetened`.

**Brand / product specificity.** A brand/product record cannot become HIGH from a
generic query: the product-head family mismatch plus the unrequested-variety gate
exclude it, and a generic query with no safe generic family record fails closed
to review (`milk chocolate` -> review).

Ranking (`usda_match_rank_v5`) and the confidence contract
(`usda_match_confidence_v3`) add `family_mismatch` and `unrequested_variety` as
hard auto-eligibility gates, and `generic_marker` as a post-extra tie-break. The
projection version is `usda_query_projection_v4`. FDC id remains presentation-
only; input order remains irrelevant; no nutrient-value ranking, AI, ML, or
network is used. Explicitly requested variety and state always beat generic.

### 25.13 Final automatic-authority repair (food family vs derived component)

A final independent audit found one BLOCKING and four IMPORTANT systemic
automatic-authority defects. They are repaired structurally, not with one-off
foods. The core rule is:

> A candidate may be AUTO-selected only when it is clearly in the requested food
> family AND does not invent an unrequested material subtype. If either is
> uncertain: REVIEW > WRONG AUTO.

**Auto-authority key vs display ranking.** Display ranking may use
`extra_candidate_token_count` and `order_agreement`; auto authority MUST NOT. The
auto-authority equivalence key (§25.5) contains only identity and
requested-specificity dimensions, so verbose USDA siblings can no longer fail to
tie and let the lowest-FDC-id materially different candidate gain HIGH authority.

**Food family vs derived component.** A closed `DERIVED_COMPONENT_TOKENS` set
(`fat`, `tallow`, `suet`, `lard`, `dripping(s)`, `butterfat`, `skin`, `rind`,
`crackling(s)`) marks a component derived from a food. When the token is the
candidate HEAD (`Fat, chicken`) or immediately follows a requested food token
(`Chicken skin`) and the query did not request it, the candidate is a
`family_mismatch`. `chicken != chicken fat`; `pork != pork fat`; `beef != beef
tallow`; `milk != milk fat`. Explicit `chicken fat` still resolves. The token
`fat` is NOT globally banned: `Beef, ground, 80% lean meat / 20% fat` is a
composition descriptor, not a component.

**Composed / coated eligibility.** A candidate whose HEAD is a foreign food token
(`Chicken, ..., fried, flour` for `flour`, `Eggplant with cheese and tomato sauce`
for `tomato sauce`) or that is prepared `with <other food>` (`Rice, cooked, with
milk`, `Egg omelet with cheese and tomatoes`, `Cheese, cottage, with vegetables`)
is a `family_mismatch` and can never be the automatic choice for a bare family
query. Explicit compound queries still work because an exact token-multiset match
is authorized independently (`chicken soup`, `cream cheese`, `tomato sauce`,
`egg noodles`).

**Unrequested material subtype.** `MATERIAL_QUALIFIER_TOKENS` now also carries
`heavy`/`half`/`whipping`/`whipped`. `unrequestedSubtypeCount` demotes a
candidate carrying an unrequested level/type subtype (`whole wheat`, `00`,
`heavy`) below the ordinary generic/all-purpose family record, so a specific
sibling can no longer be crowned merely because its USDA description is short.

**Generic preference.** `genericMarkerCount` is now applied BEFORE the
presentation-only extra-token/order dimensions, and an explicit `NS`/`NFS`
candidate is never penalised for the variant options it enumerates (`Cream, NS
as to light, heavy, or half and half`) — the "conflict qualifier bookkeeping"
repair. `all`, `purpose`, and `wheat` are no longer variety tokens, so
all-purpose flour is no longer pushed below floured-chicken dishes.

**Version bumps.** `QUERY_PROJECTION_VERSION` = `usda_query_projection_v5`,
`MATCHING_RANKING_VERSION` = `usda_match_rank_v8` (later bumped from v7 by the
prepared-product demotion below), `MATCH_CONFIDENCE_VERSION` =
`usda_match_confidence_v7` (later bumped from v6 by the same repair).

Permanent regression tests cover `1 cup chicken` (never rendered fat / fried /
soup), `1 cup flour` (never `00`/whole wheat), `1 cup cream` (no invented fat
class), `1 cup powdered milk` (milk family, no invented fat class),
`whole`/`nonfat`/`heavy`/`light` explicit variants, `all-purpose`/`00` flour,
`chicken fat`, and `chicken soup`. FDC id remains presentation-only; input order
remains irrelevant; no nutrient-value ranking, AI, ML, or network is used.

### Final authority edge-case repair (egg state / derived component / cultivar)

Three remaining authority edge cases were repaired without redesigning the
matcher. The core rule is unchanged: AUTO only when the correct family is
matched, every requested state/form/subtype is honored, no unrequested material
state/subtype/cultivar is invented, and no materially plausible runner-up remains
ambiguous. REVIEW is always preferred to a wrong AUTO.

**Bare egg must not invent a cooking state.** `COOKING_METHOD_TOKENS` is a closed
set of cooking/preparation states (`fried`, `baked`, `boiled`, `scrambled`,
`poached`, `roasted`, `grilled`, `steamed`, `sauteed`, `braised`, `stewed`,
`microwaved`, `toasted`, and the generic `cooked`).
`unrequestedCookingMethodCount` disqualifies a candidate that names an
unrequested method, so a bare `egg`/`eggs` can never auto-select `Egg, whole,
fried, NS as to fat` merely because the record carries NS/NFS wording. An
explicitly requested specific method also satisfies the generic `cooked` state
(`2 boiled eggs` -> `Egg, whole, cooked, hard-boiled`); explicit `raw`/`cooked`
and specific-method queries remain authoritative. This is what makes `fried`
visible to authority instead of being an invisible descriptor.

**Explicit derived components are core identity.** When the query requests a
derived component (`beef fat`, `pork fat`, `chicken skin`, `beef tallow`), the
component is satisfied ONLY by a structural component — the candidate HEAD
(`Fat, chicken`, `Fat, beef tallow`) or a token immediately after the requested
food (`Chicken skin`). A composition descriptor (`Beef, steak, ribeye, lean and
fat eaten`, `... / 20% fat`) is a `family_mismatch` and can never auto-satisfy
`beef fat`. The token `fat` is still NOT globally banned: `80/20 ground beef`
and composition descriptions containing `% fat` remain valid, and explicit
`chicken fat`/`chicken skin` still resolve.

**Bare/dry beans must not invent a cultivar.** The pinned USDA dry-bean records
are ALL named cultivars and there is NO generic dry-bean record. The bounded
`VARIETY_TOKENS` vocabulary now carries a representative bean-cultivar set
(`tan`, `carioca`, `cranberry`, `navy`, `pinto`, `cannellini`, `kidney`,
`northern`, `flor`, `mayo`; the color/size cultivars are already covered), so a
bare or `dry beans` query cannot auto-select `Beans, Dry, Tan` purely from
rank/FDC order. Explicit cultivar queries still resolve (`pinto beans` ->
`Pinto beans, NFS`, `dry pinto beans` -> `Beans, Dry, Pinto`).

Mutation-sensitive tests prove that removing the cooking-state authority, the
derived-component request identity, or the cultivar ambiguity handling each
causes a failing test.

### Scrambled-egg material prepared/storage-state repair

An explicit `scrambled eggs` query auto-selected `Eggs, scrambled, frozen
mixture` over the ordinary `Egg, whole, cooked, scrambled`. The unrequested
`frozen` storage state and `mixture` prepared-product form were not authority
dimensions, so the two candidates tied on the semantic authority key and
display/FDC ordering crowned the frozen product.

**Fix.** `MATERIAL_STATE_TOKENS` now also carries the unrequested material
prepared/storage/prepared-product states `frozen`, `mixture`, and `omelet`/
`omelette`. `unrequestedMaterialVariantCount` (which is NOT exempted by an
`NS`/`NFS` generic marker, unlike `FORM_TOKENS`) therefore disqualifies such a
candidate from automatic authority and demotes it in ranking. Consequently:

- `scrambled eggs`, `2 scrambled eggs`, and `egg, scrambled` auto-select the
  ordinary `Egg, whole, cooked, scrambled` and never the frozen mixture (the
  frozen mixture remains a review candidate only);
- `frozen scrambled eggs` surfaces the frozen mixture as the suggested top and
  never auto-selects the plain non-frozen egg;
- `1 apple` now auto-selects the generic `Apple, raw` instead of a frozen apple
  record, and no dried variant is ever auto-selected.

This is a bounded, vocabulary-level expansion of an existing authority
dimension, not an egg-only string special-case and not a global penalty on
benign descriptive prose. Because it changes the `unrequested material
variants` ranking dimension, `MATCHING_RANKING_VERSION` was bumped to
`usda_match_rank_v7` and `MATCH_CONFIDENCE_VERSION` to
`usda_match_confidence_v6` (both superseded by the prepared-product demotion
below). Mutation-sensitive tests prove that removing the prepared/storage-state
rule lets a lone frozen mixture regain AUTO authority.

### Hands-on smoke integration repair (amount/unit UX, two-card presentation, Analyze)

Real-user smoke testing found integration defects that were repaired without
weakening any authority or security invariant:

**Amount/unit binding.** The recipe's parsed quantity/unit flows into Advanced
Nutrition through the Phase 4 boundary (`ingredientMeasurement`, so the UI never
imports the Phase 2 parser directly). The Edit surface shows the recipe amount
(`1.5 cup`) and, for every compatible authenticated USDA portion, the
deterministic total grams for that amount (`1 cup = 122 g → 183 g for 1.5 cup`).
Selecting a portion binds it and the calculator derives the mass by exact
canonical volume (no density invention, no averaging, no guessed conversion).
When multiple materially different compatible portions exist the amount stays
review-required and the user chooses; when the selected food has no
authenticated portion the UI says so and the manual total weight remains a
fallback. `tsp`/`tbsp`/`cup`/`slice`/count bindings are regression-covered.

**Two-card presentation.** The ordinary compact `Nutrition & Macros` card is
always visible; a saved Advanced block feeds its values
(`deriveAdvancedCompactNutrition`) while Advanced Nutrition remains a separate
secondary card. Applying Advanced never hides or replaces the normal card, and a
page refresh/reopen restores both.

**Analyze control.** `Analyze Nutrition` always executes a fresh deterministic
analysis (falling back to an on-demand computation if the memoized analysis is
unavailable) and provides a visible run state; it never becomes a dead button
after a saved-state reopen, and it never persists.

### Final hands-on integration repair: central live row state + staple/prepared matching

A second hands-on pass found that automatic analyzer suggestions, explicit user
food confirmations, authenticated source portions, authenticated count portions,
manual total weights, and calculation readiness were not always projected into
ONE coherent CURRENT row state. The collapsed row could keep showing a stale
`Review suggested` (or `Needs match`) after the user had explicitly resolved the
row, and the preview could disagree with the row.

**Central live row-state projection.** `src/core/nutritionV2/phase4/liveRow.ts`
is the ONE authority for the current effective state of an Advanced Nutrition
ingredient row. `projectLiveRow`/`projectLiveRows` derive the row status and mass
ONLY from current authoritative live session state:

- the current authoritative Phase 2 review row (candidate identities/outcome);
- the current food selection (`state.matches`, automatic OR user-confirmed);
- the current authenticated source-portion selection (`state.portions`);
- the current authenticated count-portion selection (`state.countPortions`);
- the current user-entered total weight (`state.userMasses`);
- the current advisory-preview evidence for the SAME food.

The analyzer's recomputed suggestion is used ONLY as a fallback before anything
is applied/confirmed; a live resolution always wins. The explicit status
contract is `needs_match` / `review_suggested` / `needs_amount` / `matched` /
`qualitative`:

```
REVIEW SUGGESTED -> user confirms food        -> NEEDS AMOUNT
NEEDS AMOUNT     -> authenticated portion     -> MATCHED
NEEDS AMOUNT     -> authenticated count        -> MATCHED
NEEDS AMOUNT     -> valid manual total weight  -> MATCHED
MATCHED          -> food selection changes     -> amount invalidated -> NEEDS AMOUNT
re-analysis      -> clears stale live overrides -> fresh analyzer state
```

A user-selected authenticated volume portion scales by exact canonical volume
(`recipe volume / USDA portion volume × USDA gram weight`, e.g. `0.25 cup ×
150 g/cup = 37.5 g`); a manual total weight uses the existing deterministic mass
conversion (`g`/`oz`/`lb`); an automatic count resolves deterministically
(`count / portion_amount × gram_weight`, e.g. `5 slices × 8.1 g = 40.5 g`). No
density, no averaging, no guessed conversion. The calculator remains the final
numerical authority; the projection is display-only and never persists. Portion
provenance is tracked with a display-only `automatic` flag, and food authority
(`automatic` / `unique_exact` / `user_confirmed`) is shown SEPARATELY from the
mass source, so a user-entered weight is never conflated with a USDA portion.

**Edit hierarchy.** When a food is resolved the Edit surface leads with the
current food and an explicit `Change food` control; the full candidate list is
revealed only when the user asks to change it. While a row is still
`Review suggested`, food-choice review is primary. Amount resolution (compatible
USDA portions, then the manual total-weight fallback) is primary once the food is
confirmed.

**Staple vs prepared-product matching.** For a bare staple query (`1 cup
Cornmeal`) a SURVEY (FNDDS) prepared dish built from the staple (`Cornmeal
stick, Puerto Rican style`, `Cornmeal mush, fat added`) could outrank the plain
staple records because it carried no color/variety token while every plain
record did. `preparedProductFormCount` is a bounded, structural ranking signal:
an unrequested prepared-dish form modifier (`stick`, `mush`, `fritter`,
`porridge`, `cake`, `pudding`, `loaf`) adjacent to a matched anchor demotes a
SURVEY (FNDDS) record. Foundational/SR-Legacy forms are unaffected, so
`Butter, stick, unsalted` remains the ordinary form of butter. Explicit requests
(`cornmeal stick`, `cornmeal mush`, `1 stick butter`) are honored because the
form word is part of the query. Because this changes ranking and automatic
eligibility, `MATCHING_RANKING_VERSION` is bumped to `usda_match_rank_v8` and
`MATCH_CONFIDENCE_VERSION` to `usda_match_confidence_v7`. The bare `1 cup
Cornmeal` query now surfaces plain cornmeal records (`Cornmeal, whole-grain,
yellow` binding `1 cup = 122 g`) and never auto-selects a prepared stick/mush.

### One-click best-effort auto-selection policy

The analyzer's original posture was "review ordinary ambiguity before
calculating": any unrequested variety (yellow vs white cornmeal, ordinary
jalapeno color/variant records) made a row `REVIEW SUGGESTED`, so an ordinary
home recipe could return `0 matched / 8 review suggested / 5 need amount` and
force the user to perform USDA taxonomy review.

The policy is now:

> BEST REASONABLE SAME-FAMILY DEFAULT beats UNNECESSARY USER REVIEW, but
> FOOD-FAMILY SAFETY beats FORCED AUTO-SELECTION.

**Three levels of ambiguity.**

- **Level 1 — trivial same-food variation** (yellow/white cornmeal, ordinary
  jalapeno records, close generic records, generic duplicates, unstated variety):
  auto-select the best default, calculate, let the user edit.
- **Level 2 — same family, nutritionally material subtype** (whole vs skim milk,
  salted vs unsalted butter, whole vs nonfat powdered milk, heavy vs light cream,
  enriched vs unenriched flour): explicit recipe wording first; otherwise review.
  No hidden arbitrary default is created.
- **Level 3 — different food / preparation / product** (cornmeal vs mush/stick,
  chicken meat vs chicken fat, plain food vs composed dish, plain rice vs a
  prepared rice dish): never cross; review or need-match.

**Implementation.** `confidence.ts` gains a second, bounded authority beside the
strict `selectAutomaticMatch`:

- `explainCandidate(...).same_family_default_eligible` — identical to the strict
  contract except it tolerates benign ordinary variety/level variation; it still
  requires full core identity, same family, no requested qualifier/form missing,
  no contradiction, and no unrequested material state / cooking / prepared /
  composed product / unrequested FORM.
- `bestEffortDefaultCandidates(review)` — the ranked same-family default set.
  It returns empty when a named MATERIAL cultivar is present among the otherwise
  benign candidates (`Beans, Dry, Tan` for `dry beans`) or when a materially
  different subtype sibling ties the best candidate (`milk` whole/skim, `cream`
  heavy/light, `butter` salted/unsalted).
- `selectBestEffortMatch(review)` — a STRICT automatic selection is always
  preferred and never relaxed; best-effort only fills the gap where ordinary
  variation would otherwise force review.
- `isDeterministicAutomaticSelection(review, fdcId)` — accepts the strict choice
  OR any bounded same-family default, so the calculation engine can validate the
  analyzer's automatic marker without accepting a materially different food.

**Portion-aware tie-breaking.** `analyzer.ts` may prefer an otherwise-equivalent
same-family sibling that can satisfy the recipe measurement with an authenticated
volume/count portion (`chooseBestEffortFood`), but only within
`bestEffortPortionTieCandidates` (no unrequested FORM) and never for a strict
selection. This is what makes bare `1 cup Cornmeal` choose the portion-bearing
`Cornmeal, whole-grain, yellow` (`1 cup = 122 g`) over an equally-plain sibling
with no usable portion. Portion availability can never promote a different food
family or a composed product.

**Freshness.** `fresh` moved from the nutritionally-significant `QUALIFIER_TOKENS`
to the ordinary `PREPARATION_QUALIFIERS` (freshness is the default state, not a
required state). `chopped fresh jalapeno` therefore no longer fails with
`missing_requested_qualifier`; fresh vs frozen/canned is still enforced by the
material-state vocabulary on the candidate.

**Result.** Bare `1 cup Cornmeal` auto-selects a plain cornmeal record and
resolves `122 g` (`183 g` for `1.5 cup`); `0.25 cup chopped fresh jalapeno`
auto-selects `Peppers, jalapenos` and resolves `37.5 g`; celery/green onions
auto-select the plain raw record and remain `NEEDS AMOUNT` (manual fallback);
cheddar/bacon/honey/buttermilk/chicken keep their prior behavior. Material
boundaries remain review: milk/cream/butter/powdered-milk subtype ambiguity, dry
beans cultivars, rice-with-gravy / cheese-sandwich composed forms, milk
chocolate, and bare-egg cooked preparations.

**Version bumps.** `QUERY_PROJECTION_VERSION` = `usda_query_projection_v6`,
`MATCH_CONFIDENCE_VERSION` = `usda_match_confidence_v8`,
`ANALYZER_VERSION` = `usda_auto_analyzer_v2` (ranking tuple unchanged at
`usda_match_rank_v8`). The live row projection, manual/source/count mass binding,
stale invalidation, Phase 5 Apply authorization, and the canonical
`codex_nutrition` schema are untouched.

### Final one-click completeness + Apply-state repair

Hands-on use found that the analyzer was still too conservative for ordinary
Level-2 ingredients, that a one-line fully-resolved recipe was mislabeled
PARTIAL, and that after Apply the just-saved result was duplicated as an
"UNSAVED REVIEW".

**Level-2 defaults auto-select.** `same_family_default_eligible` no longer
blocks on a material subtype/variety; a normal ingredient whose leading
candidates are the same food gets a deterministic, editable default
(all-purpose flour, generic rice, common milk, cream, generic butter, dry beans,
powdered milk). `fresh` was moved to the ordinary preparation vocabulary.
`compound` (a non-food modifier such as `double-acting`) still demotes but no
longer blocks a same-family default, while a genuine FOOD compound (`Rice milk`,
`Rice pilaf`) and an unrequested FORM (`Rice, white, with gravy`) still block.
A named MATERIAL cultivar (`Rice, black`, `Wild rice`, `Beans, Dry, Tan`) is
never the ordinary default (explicit `black rice` / `pinto beans` are honored).

**One-food coherence + portion-aware selection.** `bestEffortDefaultCandidates`
now keeps only candidates whose head noun mutually overlaps the best candidate's
tokens (`Flour, wheat, ...` / `Wheat flour, ...`; `Yogurt, ... milk` is not
`milk`). When the default cannot satisfy the recipe measurement,
`chooseBestEffortFood` prefers the same-food sibling with a compatible
authenticated portion that is MOST SIMILAR to the default's description, so
`2.5 cups all-purpose flour` chooses another all-purpose record (125 g/cup ->
312.5 g) rather than a whole-grain one. Portion availability is a tie-breaker
inside the safe food family and can never override identity.

**Generic-first ranking.** An unrequested cooking/preparation state and a FOOD
compound are demoted before variety, and a named material cultivar after variety,
so plain/raw/white members outrank cooked/composed/cultivar records.

**Eggs / count size.** `countIdentityCompatible` lets a generic (size-null)
authenticated count portion satisfy an explicit size request when no
size-specific portion exists (`2 large eggs` -> `1 egg = 50 g`), while an
unspecified size still never binds a size-specific portion.

**Single completeness authority.** The whole-recipe `status` is now derived from
INGREDIENT-LINE resolution, not nutrient-list breadth: zero unresolved measurable
ingredient lines means COMPLETE even when a USDA record does not enumerate every
nutrient in scope (each nutrient still reports its own status/coverage). This
invariant is enforced by the calculation engine, Phase 5 Apply, the persisted
`codex_nutrition` block, and both nutrition surfaces. A block with an unresolved
line is PARTIAL. The schema v1 structure/version is unchanged; only the
status-coherence rule is aligned to the invariant.

**Post-Apply reconciliation.** `readStoredBlock` now exposes the saved
`ingredient_digest`; the Advanced card suppresses the
`UNSAVED REVIEW — NOT APPLIED` panel when the live review's canonical
`ingredient_digest` equals the saved block's (a deterministic digest comparison,
never a formatted-string comparison). A genuine change re-surfaces the panel.

**Version bumps.** `QUERY_PROJECTION_VERSION` = `usda_query_projection_v8`,
`MATCHING_RANKING_VERSION` = `usda_match_rank_v10`,
`MATCH_CONFIDENCE_VERSION` = `usda_match_confidence_v10`,
`COUNT_PORTION_VERSION` = `usda_count_portion_v2`,
`ANALYZER_VERSION` = `usda_auto_analyzer_v4`. The live row projection, manual
mass binding, source/count portion binding, stale invalidation, Phase 5 Apply
authorization, and the canonical `codex_nutrition` schema are otherwise
untouched.

---

## 30. Real-world ingredient understanding, manual USDA search, and recipe-route persistence

This pass stays upstream of the calculation engine: parsing, candidate
generation, ranking, manual search, and navigation persistence. It does not
change calculation semantics, the complete/partial rule, Phase 5 persistence, the
compact presentation, Apply authorization, the nutrient schema, or the USDA
bundle.

### 30.1 Ingredient canonicalization (query projection v8)

`projectQueryText` separates four roles before candidate generation: FOOD
IDENTITY, meaningful SUBTYPE/MATERIAL modifiers, MEASUREMENT tokens, and
PREPARATION/INSTRUCTION noise.

- **Parenthetical numeric ratios** (`(80/20)`, `(85 / 15)`) are preserved as two
  numeric qualifier tokens; other parentheticals remain asides.
- **Preparation/procedural noise** (`kept`, `cold`, `loose`, `four`, `freshly`,
  `divided into`, `plus more`, ...) is removed from identity, and trailing
  procedural clauses (`kept cold and divided into four loose 4-ounce balls`) are
  trimmed. Nutritionally significant state (`fried`, `cooked`, `baked`, `raw`)
  is deliberately NOT noise: it remains required identity.
- **Optional culinary refinements** (`kosher`, `sea`, `fine`, `coarse`) are
  recorded as `refinement_tokens`. They are a ranking PREFERENCE, never required
  identity, because the pinned bundle has no `Salt, sea`/`Salt, kosher` record.
  A real refinement record (e.g. `Spices, pepper, black`) is surfaced ahead of
  the generic sibling; otherwise the deterministic generic same-food fallback is
  used. The modifier is never treated as absent.
- **OR alternatives** (`brioche or potato burger buns`) are decomposed into
  `alternative_groups` branches with a shared head. The shared head is the
  required identity, so a generic fallback (`Roll, white, hamburger bun`) remains
  reachable when no subtype record exists; a real subtype record is preferred by
  the `alternativeAgreement` ranking dimension.
- **Bounded culinary aliases** now include `neutral oil` -> the bounded neutral
  family (`Vegetable oil, NFS`), and aliases are re-projected onto the
  qualifier/form roles so `burger buns` -> `hamburger bun` matches `hamburger`.

### 30.2 Ranking v10

`rankCandidates` adds `refinementAgreement` and `alternativeAgreement`
preferences and an `unrequestedForms` demotion, so a composed product
(`Double hamburger, ..., 2 patties`) ranks below the plain component
(`Roll, ..., hamburger bun`) for a `burger buns` query.

### 30.3 Direct recipe mass authority

`projectLiveRow` resolves a direct recipe mass (`g`/`kg`/`oz`/`lb`) as
`direct_mass` BEFORE any source/count portion, so `1 lb ground beef` resolves to
453.6 g with no USDA portion. A food change preserves direct recipe mass (only
food-dependent portion/count state is invalidated).

### 30.4 Manual USDA search

`AdvancedNutritionSession.searchFoods(query, limit)` performs a deterministic,
local, bounded search over the SAME pinned bundle (no network, no AI). It returns
bounded discovery results (FDC id, data type, description, record digest, portion
availability). A selection built from a result is a `kind: 'manual'` match choice
carrying the record digest and catalog digest.

The calculation engine authenticates a manual selection against the pinned
bundle: the FDC id must exist, the record digest and catalog digest must match,
the line ref must match, and the selection must bind the CURRENT review digest.
A forged/stale/wrong-bundle selection fails closed (it is never granted
authority). Manual search is available on matched, review-suggested, needs-amount,
and needs-match rows.

### 30.4a TRUE full-catalog manual search (`usda_manual_search_v1`)

Manual search is a **full-database discovery tool**, deliberately SEPARATE from
the automatic candidate generator. It does NOT use anchors, food-family
authority, confidence, eligibility reasoning, or review status. It searches
every eligible record in the pinned catalog (12,924 eligible records at the
current pinned release; 13,559 authenticated source records).

`matching/manualSearch.ts` owns the deterministic ranking:

1. exact FDC id (`169697` / `fdc 169697`) — ranked first;
2. exact normalized description;
3. phrase/prefix agreement;
4. plain/common food preference (a bounded composed/dish-token penalty);
5. compactness (fewer extra tokens);
6. token-order agreement;
7. stable `fdc_id` tie-breaker.

A query matches a record only when EVERY query token is present (morphologically
tolerant, token-order independent) — honest AND semantics, so manual search never
silently substitutes a different food. A small bounded synonym map (`burger` ->
`hamburger`) improves recall. When no record matches, the UI states
"No matching USDA record found in this pinned dataset."

An inverted token index is built ONCE per catalog (lazily, in the catalog
closure in `review.ts`, never exported) and reused for every search, so
interactive searches do not rebuild structures. The pure `searchManualCatalog`
receives the index; it holds no authority and no global state. Results are
bounded (`MANUAL_SEARCH_DEFAULT_LIMIT` 20, `MANUAL_SEARCH_MAX_LIMIT` 100) with a
`total` count and a `Load more` continuation. Discovery hits expose safe fields
only (no nutrients, no authority, no selection).

### 30.5 Recipe-detail route persistence

`src/utils/recipeRoute.ts` defines the stable route grammar
(`#/` gallery, `#/recipe/<encoded-id>` recipe). `App` resolves the routed
canonical recipe id once the recipe collection is loaded (waiting for the vault
loading state), restores the same detail view on hard refresh, fails safely to
the gallery for an invalid/missing route, and supports browser back/forward.


---

## 31. Persistent saved report + re-analyze workflow + per-serving presentation

This pass separates Advanced Nutrition into three layers and closes the
saved/working lifecycle: the recipe-facing compact card, the persistent saved
report, and the temporary working analyzer/editor.

### 31.1 Saved Advanced report (no analyzer required)

`phase5c/savedReport.ts` (`usda_phase5c_saved_report_v1`) projects an
already-validated canonical schema-v1 block into the detailed saved report
WITHOUT any Phase 2/3/4 session, catalog authentication, USDA bundle
reconstruction, candidate generation, or re-calculation. `AdvancedNutritionSavedReport`
renders it read-only with the three display bases (entire recipe / per serving /
selected servings), nutrient groups, per-nutrient partial markers, resolved vs
unresolved line counts, provenance, and the USDA bundle release.

`AdvancedNutritionCard` receives the validated block as `savedAdvancedBlock`
(passed by `RecipeNutritionSection`) and opens the SAVED REPORT first when one
exists. Only the explicit `Edit / Re-analyze Nutrition` action initializes the
USDA analyzer (lazily, through the existing bundle loader). Viewing persisted
nutrition therefore never waits on catalog authentication.

### 31.2 Working-review hydration

`phase4/hydrate.ts` reconstructs the previously reviewed working state for an
UNCHANGED recipe. Binding is per canonical `line_ref` (index + content digest), so
a changed line never reuses stale evidence. The canonical block stores the FDC id,
bundle release, resolved grams, and optional `conversion_basis`
(`direct_mass` | `source_portion`); it does NOT persist record/catalog/review
digests, the portion index, the count identity, or the manual mass unit. Those are
RE-DERIVED from the genuine current session (the FDC id is looked up through the
full-catalog manual search to obtain the authenticated record digest). Every mass
binding is rebuilt through the genuine session builders
(`buildPortionChoice` / `buildCountPortionChoice` / `buildUserMassChoice`), which
independently re-authenticate the manual food selection. When a saved
`source_portion` cannot be reproduced exactly, the reviewed grams are recovered as
an explicit user-entered total weight; if that fails, the row stays unresolved and
no authority is invented. No schema change was made or required.

### 31.3 Saved vs working state

The working editor is a temporary draft: it shows a "Working Advanced Nutrition
review" banner and distinguishes hydrated-but-clean from "Unsaved changes"
(deterministic: a genuine user edit, a stale preview, or a preview whose
`ingredient_digest` differs from the saved block). `Close without saving`
discards the draft and the saved report is untouched; Apply rebases the working
state cleanly against the newly saved digest.

### 31.4 Serving-scaled recipe-facing presentation

The canonical saved block remains ENTIRE-RECIPE totals for its own base serving
denominator. The compact `Nutrition & Macros` card and the recipe header Calories
follow the CURRENT recipe serving scale:

    displayed = savedEntireRecipeTotals × (currentServings / savedBaseServings)

so at the base count they show the base entire-recipe totals, at 4/8 they show
0.5×, and at 16/8 they show 2×. All six compact fields (calories, protein, carbs,
fat, fiber, sodium) use the same basis and the existing shared serving contract
(`nutritionForRequestedServings`), so there is no cumulative drift and macro
percentages are scale-invariant. Changing servings is presentation scaling only:
the canonical `codex_nutrition` block is never rewritten. A PARTIAL saved result
still shows the incomplete state at every scale. The saved report retains its
three explicit display bases (entire recipe / per serving / selected servings)
over the canonical saved denominator.

### 31.5 Post-Apply live sync

A successful Apply immediately makes the newly applied result THE saved Advanced
result on every surface (Advanced summary card, saved report, compact card, and
recipe header) with no reload/reopen. The application write callback commits the
updated recipe to the authoritative in-memory collection + selected recipe, and
then invalidates any vault scan that started BEFORE the write, so a later-
resolving stale scan can never overwrite the new saved result with the old one.


---

## 32. Manual review persistence + partial compact display

### 32.1 Re-analysis preserves reviewed decisions

Re-analysis is a GAP-FILLING pass, never a destructive reset. `apply_analysis`
accepts optional preserved `userMasses`, and the card's Re-analyze merges the
fresh analyzer result with every explicit user decision:

- a manual / USDA-search selection (`kind: 'manual'`),
- a user-confirmed candidate (`automatic !== true`),
- a selected authenticated source/count portion,
- a user-entered total weight.

For each such line the reviewed choice and its mass binding are carried through,
and the advisory preview is RECOMPUTED from the merged state. The analyzer only
supplies the lines the user has not already decided. This is what makes a
manually reviewed `4 cup broccoli florets` / `2 g garlic, minced` survive
reopen + Re-analyze instead of reverting to NEEDS MATCH / NEEDS AMOUNT.

Hydration already reconstructs reviewed evidence for an unchanged recipe:
per-line `line_ref` binding, the FDC re-derived from the pinned catalog, and the
mass rebuilt through the genuine session builders. For a resolved row, schema v1
already stores the FDC id, bundle release, resolved grams, and optional
`conversion_basis`. A manual selection whose mass never resolved is now preserved
by the backward-compatible unresolved-food extension (§33).

### 32.2 Partial compact nutrition display

A recognized PARTIAL saved Advanced result is now surfaced in the standard
Nutrition & Macros card instead of being hidden:

- `deriveAdvancedCompactNutrition` returns the partial values (the sum over the
  RESOLVED ingredient lines only);
- the card shows the values with the same current-recipe serving-scale projection
  as a complete result;
- the card always renders a prominent "Partial estimate" badge plus
  "Advanced nutrition incomplete — N of M ingredient lines resolved" and states
  that unresolved lines are excluded;
- the values are never labelled complete, and no legacy value is topped up.

The recipe-header Calories stays deliberately BLANK for a partial Advanced
result (`resolveNutritionDisplayCalories` returns undefined while Advanced is
preferred but incomplete), so a partial total is never headlined as complete.
The detailed saved report continues to show partial values with partial-coverage
markers.


---

## 33. Independent food-identity persistence for unresolved-mass rows

Food identity and mass resolution are independent concerns. A user-confirmed USDA
food must survive Apply even when the line's mass is still unresolved, while the
line contributes ZERO nutrients.

### 33.1 Schema extension (backward-compatible; schema stays 1)

`UnresolvedIngredientRef` gains two OPTIONAL fields:

```
source_food_id?: string;   // the user-confirmed USDA FDC id
source_release?: string;   // must equal the declared `usda_fdc` release
```

- Both are present together or absent together; a lone field fails validation.
- They are written ONLY for a user-confirmed selection (never an automatic
  candidate) and only when the line is unresolved.
- They carry NO amount and NO nutrient contribution.
- Legacy blocks that omit them remain valid and hydrate as NEEDS MATCH.
- A new block carrying them is rejected as `malformed` (preserved, never
  interpreted) by an older reader that predates the fields — the documented
  fail-closed behavior for forward-added fields.
- That phase made no schema version bump: the two unresolved-food fields remain
  valid schema-v1 fields (`CODEX_NUTRITION_SCHEMA_V1` = 1); totals, nutrients,
  serving denominator, and Apply authorization are unchanged. Phase 6 later
  introduces the genuine schema v2 household extension (§37.5) rather than
  expanding v1 in place.

### 33.2 Persistence and hydration

`phase5/authorize.ts` attaches the FDC + bundle release to an `unresolved` entry
when the reviewed preview shows a user-confirmed match with no resolved mass.
`phase4/hydrate.ts` restores that entry as a `kind: 'manual'` reviewed choice
(re-derived record/catalog/review digests) WITHOUT any mass binding, so the row
projects NEEDS AMOUNT (never NEEDS MATCH). The FDC is re-authenticated against the
active pinned catalog; an absent/forged id fails closed and does not bind.

### 33.3 Manual selection on an unmatched row

`buildCalculationRequest` now supplies an explicit user selection for ANY row with
a user choice, not only `review_required` rows. A manual full-catalog selection on
an `unmatched` (or `matched_exact`) line therefore reaches the calculation (and
persistence); the calculator independently re-authenticates it and fails closed if
invalid.


---

## 34. AI-assisted USDA resolution

The nutrition system is ONE system:

    USDA = numeric authority
    deterministic Kitchen Codex logic = calculation authority
    AI = interpretation / resolution assistant
    user = final authority for ambiguous choices

AI may understand language and suggest a canonical food meaning and useful USDA
search phrases. AI NEVER owns FDC existence, nutrient values, record/catalog
digests, portions, masses, calculated totals, or Apply authorization.

### 34.1 Unified entry and deterministic-first flow

`Generate Nutrition` is the single recipe-facing entry (when no saved Advanced
result exists) and is an EXPLICIT user action that authorizes the deterministic
analysis: one click loads the USDA analyzer lazily, opens the working review, and
IMMEDIATELY runs the EXISTING deterministic analyzer. Viewing/opening a recipe
still calculates nothing; the Generate click is the authorization. AI is NOT
called by Generate. When a saved Advanced result exists, the entry is
`View Advanced Nutrition` (the saved report, no bundle load, no analysis) with
`Edit / Re-analyze` as the secondary working action (it opens without running
analysis). The legacy `Estimate Nutrition (AI)` contribution to the compact card
is hidden; the legacy `/api/estimate-nutrition` route is retained dormant for
compatibility but is no longer a competing nutrition system.

The deterministic analyzer ALWAYS runs first (via the explicit Generate click).
AI assistance is a SECONDARY, explicit action offered for ANY actionable
exception row: `NEEDS MATCH`, `REVIEW SUGGESTED`, or `NEEDS AMOUNT`. A fully
resolved recipe never contacts AI at all, and the user never has to understand
the internal exception taxonomy to know whether AI can help. Watching a saved
recipe never calls AI.

#### 34.1a Single live status authority

The ingredient list, the analysis summary, and AI eligibility all derive from
the ONE pure live-row projection (`phase4/liveRow.ts`):
`projectLiveRows` -> `summarizeLiveRows` -> `actionableExceptionRows`. The
summary is never computed from the analyzer snapshot, from a memoized automatic
suggestion, or from a separately maintained mutable counter, so the rendered
rows and the counts can never disagree. `actionableExceptionRows` returns exactly
the current `needs_match` + `review_suggested` + `needs_amount` rows (in state
order) and is the only eligibility source for both the bulk and row-level AI
actions.

### 34.2 Server contract (`POST /api/nutrition/resolve-ingredients`)

- Server-side only, behind the existing `requireAiAccessToken`,
  `textPricingGuard`, and a dedicated `nutritionResolveRateLimiter`.
- Uses the existing provider abstraction (`runWithAiFallback` +
  `resolveRoleCandidates("nutrition")`) with `structuredOutput`, temperature 0.
- Request: bounded rows `{ line_ref, ingredient_text, normalized_text?, amount?,
  unit?, qualifiers?, reason?, issue_kind? }` (max 25 rows, 300-char text). The
  optional `issue_kind` is a CLOSED, TRUSTED application enum (`needs_match` |
  `review_suggested` | `needs_amount`) supplied from the live row projection — the
  model is never asked to infer internal application state from prose. A CLOSED
  request shape: any unknown field (including attempted FDC/nutrient/mass fields)
  rejects the whole request. Only currently actionable exception rows are sent.
- Response (advisory only): `{ version, suggestions: [{ line_ref,
  interpreted_food_name, suggested_usda_queries[], notes?, confidence?,
  normalized_food_query?, preparation_hint?, quantity_value?,
  quantity_unit_hint?, count_descriptor_hint?, portion_search_hint?,
  explanation? }] }`. `src/core/nutritionV2/aiResolution.ts` strictly sanitizes the
  model output: exact allowed keys, bounded strings/arrays/quantity (max 1e6),
  known line_refs, no duplicates. Any forbidden/unknown field (FDC id,
  `source_food_id`, nutrient amount, `grams`/`mass_g`, portion index/gram weight,
  record/catalog digest, `source_release`, Apply token) rejects the WHOLE
  response. The client re-sanitizes (defense in depth).
- The advisory amount fields are LANGUAGE interpretations, not authority:
  `quantity_value` must be consistent with the recipe's own parsed count (a
  material disagreement leaves the row unresolved), and the count/portion hints
  are restricted to the closed canonical count vocabulary. There is deliberately
  no field that can carry a gram weight.
- Prompt-injection resistance: the system prompt declares ingredient text as
  untrusted DATA; the strict output shape is enforced server-side regardless.

### 34.3 USDA verification chain

Food identity: AI suggestion -> `phase4/aiResolve.ts` ->
`session.reviewIngredient({ name: query })` (the genuine pinned catalog) ->
`selectAutomaticMatch` / `selectBestEffortMatch` (the SAME deterministic
confidence contract as the one-click analyzer) -> an ordinary `kind: 'manual'`
selection bound to the ORIGINAL row's review digest + the authenticated record
digest. AI grants no authority: if the deterministic matcher does not accept a
candidate, the row stays for user review / manual full-catalog search.

**AI source-constraint parity (Phase 2, extended in Phase 3).** AI wording may
improve positive lexical identity, aliases, or phrasing, but it can NEVER weaken
or erase an explicit constraint of the authenticated source line.
`resolveFoodsFromAiSuggestions` reconstructs the source constraints LOCALLY from
the session-bound row text through the canonical Phase 1 parse and the ONE query
projection (container-implied `can`/`tin -> canned` state, explicit physical
state, explicit preparation/product form, and explicit variety), then re-checks
every strict/best-effort candidate with the SAME closed Phase 2/3 counters
(`stateContradictionCount`, `impliedStateCompatibilityMismatchCount`,
`preparationFormContradictionCount`, `varietyContradictionCount`) before offering
it. A contradicting candidate is rejected (the row stays for review); candidate
silence stays neutral; source agreement never creates positive authority.
Provider-supplied hints/context are never trusted as source context, and a
line-ref/fingerprint mismatch (an edited or stale source line) fails closed.
The AI-resolution contract identifier is `nutrition_ai_resolution_v3`
(`AI_RESOLUTION_VERSION`); the wire request/response shape is unchanged,
responses are never persisted, and every response is freshly re-verified, so no
digest or persisted-schema change is required.

Amount/count identity: AI count-identity hint -> `phase4/aiAmountResolve.ts` ->
`session.reviewCountPortions(ingredient, fdcId, hint)` (the genuine authenticated
USDA portions) -> only when every compatible candidate yields the SAME resolved
mass for the recipe's OWN parsed count is a `CountPortionChoice` built and
offered; the Phase 3 calculator independently re-derives the mass from the
authenticated portion (`count_requirement_hint` rides alongside the digest-bound
selection). The AI never supplies the gram weight, and the hint may only FILL a
missing unit/size — it can never override an explicit recipe identity or supply
the amount.

### 34.3a Provenance: AI-assisted deterministic != user-confirmed

Three provenances are kept distinct:

- **automatic deterministic** — the original analyzer independently accepted the
  record (`match_status: unique_exact` / `auto_confirmed`; `user_confirmed: false`);
- **AI-assisted deterministic** — AI supplied an advisory search phrase or count
  identity, but the EXISTING deterministic matcher/portion contract independently
  authenticated the genuine pinned-USDA record (`match_status: auto_confirmed`;
  `user_confirmed: FALSE`). The working match carries `aiAssisted` (display badge
  "AI-assisted USDA match") and `aiAccepted`; an AI-assisted count resolution
  carries `aiAssisted` plus `countRequirementHint` on the working
  `CountPortionChoice`. Re-analyze does NOT preserve them as reviewed decisions;
- **explicit user choice** — a manual full-catalog selection, "Use this match" on
  an offered (below-threshold) AI candidate, or an explicitly chosen AI-offered
  authenticated count portion (`match_status: user_confirmed`;
  `user_confirmed: true`). Only this creates human-reviewed authority, and only
  this is preserved by Re-analyze.

AI assistance never elevates an automatic match into human-reviewed authority.
The provenance markers (`aiAssisted`/`aiAccepted`, `countRequirementHint`, and the
request-level `ai_assisted` selection marker) are working-state/display only:
they are NEVER persisted into `codex_nutrition` (no schema change), never part of
Apply authorization, and the existing Apply-level evidence semantics are
unchanged. `countRequirementHint` is a bounded working-state input to the
calculator (closed count vocabulary, no amount/gram field); it is not persisted
and a forged/unknown value fails the calculation closed. A saved block may carry
an ordinary automatic authority status for a food/portion AI helped discover;
that is normal automatic evidence, not human review. The calculator independently
re-authenticates the record, catalog, line, review, and portion bindings, so a
forged AI marker grants no authority.

### 34.4 Session, failure, cost, and lifecycle discipline

- One batched request for the actionable exception rows; no per-ingredient
  request storm. Row-level "Ask AI for help" reuses the same bounded request path.
- STALE-RESPONSE BINDING is not merely sequence-based. Every AI request captures
  and re-checks: the monotonic request `seq`, the monotonic AI lifecycle
  `generation` (bumped on any recipe-identity or session-authority change), the
  current `recipeKey`, the current `sessionIdentity`, and whether the analyzer is
  still open. A response is discarded BEFORE any state mutation when any binding
  changed; Re-analyze and recipe/session switches also clear all transient AI
  working state (messages, suggestions, amount offers).
- A synchronous re-entry guard ensures a rapid bulk or row-level double-click
  creates exactly ONE request (the server rate limiter is only a backstop).
- AI unavailable / provider error / timeout / malformed response: a bounded
  message is shown and the deterministic USDA + manual full-catalog search
  workflow continues untouched. No fake nutrition is generated, no data is lost.
- AI mass estimation is NOT part of this phase. The AI never supplies a gram
  weight; when the authenticated USDA portions are absent or materially differ
  (e.g. small/medium/large), the row remains NEEDS AMOUNT / REVIEW SUGGESTED and
  the authenticated candidates are shown to the user as an explicit choice.
  Accuracy beats completion theater.
- When an AI-assisted deterministic resolution changes live rows, the card
  recomputes the advisory preview in the SAME step and dispatches it through the
  ordinary reducer path; nothing is written to the vault.
- No schema change: AI assistance is working-state discovery only and is never
  persisted into `codex_nutrition` or used in Apply authorization.

---

## 35. Household-portion registry contract — registry-track Phase 4 (contract only)

**Naming.** This is Phase 4 of the *household-portion registry track*
(contract → curation → integration), not §16 (the advisory review/display
UI). The two tracks share nothing but the digest/materialization primitives.

**Status: contract only.** This phase defines the authenticated,
deterministic, versioned, digest-bound contract for a future household-portion
registry: record types, closed vocabularies, sanitization/materialization,
canonical normalization, per-record digests, a registry-level digest, release
lock/manifest verification, duplicate and ambiguity rejection, a deterministic
in-memory lookup structure, provenance metadata, and security/isolation
tests. It ships **zero real household-portion records** (all fixtures are
unmistakably synthetic) and has **zero effect on matching, calculation, live
rows, AI, Apply, persistence, or user-visible behavior**. No working
household registry, no new amount result, and no estimate feature exists yet.

### 35.1 Module boundary

`src/core/nutritionV2/household/` (not re-exported from any public barrel):

| Concern | Module |
| --- | --- |
| Public closed types, schema version, bounds, failure taxonomy | `types.ts` |
| Canonical bounded field normalization | `normalize.ts` |
| Canonical digest construction | `digest.ts` |
| Materialization, validation, lock verification, immutable lookup | `registry.ts` |
| Narrow public exports | `index.ts` |

Reuse (no duplicated namespaces): strict canonical serialization +
SHA-256 (`usda/digest.ts`), the inert materializer + byte accounting
(`schema.ts`: `toInertValue`, `serializedBlockBytes`, `utf8ByteLength`), the
Phase 1 count-unit owner (`utils/householdUnits.ts`), and the shared
positive-finite implementation (`units.ts`: `isValidNutrientAmount`). The size
and state vocabularies are owned locally because their natural homes live in
the calculation layer (`calculation/countPortion.ts`) and matching authority
(`matching/query.ts`), which this contract must not import.

### 35.2 Schema version vs. registry release

`HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION = 'household_portion_registry_v1'`
identifies the CONTRACT. It is distinct from the Advanced Nutrition persisted
schema v1, matching/calculation/AI versions, and from the concrete registry
release identifier (`registry_release`, e.g. a dated curation id), which
identifies the DATA. No schema v2 exists; no persisted recipe schema changed.

### 35.3 Record fields

A bounded semantic record: `schema_version`, `food_key` (canonical audit
label, grants no identity), `aliases` (sorted/deduped, never authority),
`usda_fdc_ids` (declared identity constraints, numerically sorted — no USDA
lookup in this phase), `household_unit` (Phase 1 **count** nouns only,
canonical singular; containers such as can/package/jar/box/bag/bottle and all
mass/volume units are rejected, never silently converted), `size_class`
(closed: small/medium/large/jumbo/mini/petite/xl/xxl, or null for
not-size-specific), `grams_per_unit` (positive finite, `<= 10_000`, no
coercion; the authored number is preserved exactly), `quantity_behavior`
(`'linear'` only), `requires_state` (closed: raw/cooked/canned/drained/
undrained/fresh/dried/frozen, or null for no requirement), `excluded_states`
(closed, sorted, never containing `requires_state`), `exclude_generic_identity`
(future NFS/NS rejection flag, no Phase 4 authority), `authority_class`,
`bounds`, `source` (closed kind, bounded citation, optional `https:` URL that
is parsed but never fetched, optional `YYYY-MM-DD` access date), `reviewed_at`
(real calendar `YYYY-MM-DD`), `supersedes` (null or a SHA-256 digest; no chain
resolution). The authenticated record adds a locally computed
`record_digest`; a declared digest, when present, must match exactly.

### 35.4 Provenance classes and bounded estimates

- `usda_derived`: source `usda_fdc`, FDC ids required, `bounds` null.
- `vetted_standard`: source `government_standard`/`standards_body`, `bounds`
  null.
- `bounded_estimate`: source `government_standard`/`standards_body`, `bounds`
  required with strict `min_grams < max_grams` and
  `min_grams <= grams_per_unit <= max_grams`.

Representing `bounded_estimate` does NOT authorize automatic use — whether it
becomes automatic, review-only, or unsupported is a later Sid-approved policy
decision.

### 35.5 Canonical digests and release lock

Record digests reuse the strict Phase 1 serializer: exact key order, exact
array ordering, exact null/number representation, NFC strings, no locale or
insertion-order dependence, digest field excluded. The registry digest binds
schema version + release + record count + ascendingly ordered record digests,
so it is input-order-independent and any record/release change alters it. The
lock (`schema_version`, `registry_release`, `record_count`,
`registry_digest`) is recomputed locally: wrong version/count/digest,
duplicate digests, duplicate lookup keys, alias collisions, food-key reuse
with incompatible FDC constraints, self-supersession, supersede cycles, and
unknown lock keys all fail closed with no partial registry.

### 35.6 Immutable loader and lookup

`loadHouseholdPortionRegistry(recordsRaw, lockRaw)` accepts inert unknown
input: guarded reads, closed exact key sets at every level, bounded depth/
keys/strings/arrays/records/total bytes, no coercion, no input mutation, and
closed input-redacted failure codes. Success returns a frozen registry
exposing only `metadata()`, `size()`, canonical-order `records()`, exact-key
`findByKey()`, and audit `findByDigest()` — no mutable maps, no
insert/update, no callbacks, no raw input. Lookup keys are
FDC × unit × size × required state; collisions fail at load, so lookup never
first-wins (a defensive multi-hit still returns `ambiguous_lookup`).

### 35.7 Authority boundary and non-goals

> Cryptographic integrity proves which reviewed record was loaded; it does
> not prove the real-world truth of the cited grams or authorize its use for
> a recipe.

The registry will eventually supply ONLY a mass conversion for an already
authenticated USDA identity plus a compatible household unit. It never
decides food identity, FDC selection, nutrients, totals, AI confidence,
automatic-match authority, user confirmation, or Apply authorization; a valid
record is not automatically authorized for calculation. Later phases must
separately bind record → authenticated FDC ID → parsed unit → size/state →
quantity → release → digest → calculation/session identity.

Explicitly unimplemented: Phase 6 integration
(matching/calculation/UI/AI/persistence wiring), which remains future work. The
Phase 5 data curation slice that followed this contract is documented in §36. A
before/after corpus run proves byte-identical authoritative behavior for the
established identity and amount corpora.

---

## 36. Household-portion registry — registry-track Phase 5 USDA-derived data (data only)

**Status: reviewed data slice, integrated by Phase 6 (§37) but otherwise
inert.** Phase 5 populates the Phase 4 contract with **31 authentic USDA-derived
household-portion records across 11 foods** under the registry release
`household_portion_initial_usda_v1`. The data itself adds no behavior; Phase 6
(§37) integrates it as the LOWEST mass authority through the verified loader,
while matching, AI, nutrients, and persistence semantics remain unchanged.

### 36.1 Source authority and derivation

Every record is derived EXCLUSIVELY from declared portions of the already pinned
USDA FoodData Central bundle
`usda_fdc_87c5408a3e98838944a87be74824761e` (source-locked in
`usda/releaseLock.ts`). The pinned canonical record and its declared portion are
the numerical authority. Derivation rules (reviewed, v1):

- only portions whose canonical `amount` and `gram_weight` are BOTH declared and
  positive are used; an omitted FNDDS `amount` is never invented;
- the source portion amount must equal EXACTLY `1` in this v1 slice, so
  `grams_per_unit === gram_weight` by construction; non-one amounts are rejected
  and require a future reviewed rational/canonical-decimal derivation contract
  (strict floating-point quotient equality is not claimed to be generally safe);
- a size-only whole-food portion (e.g. `medium (2-1/2" dia)`) is encoded as
  `household_unit: 'item'` plus the canonical size it declares; the one source
  size alias used (`extra large`) is canonicalized once to `xl`;
- `usda_fdc_ids` lists the derivation source first and may add additional
  eligible FDCs of the same ordinary food identity only with a positive,
  reviewable cross-FDC equivalence rationale for every pairing (species/family,
  state, color/variety, edible form, positive evidence, corroborating portion,
  data-type differences, nutrient-profile delta, bounded conclusion). The
  absence of a contradictory portion is never the primary rationale, and
  nutrients always come from the selected target FDC — mass transfer only.

The repaired slice covers: garlic clove; tomato, green/red bell pepper,
green/red cabbage, egg, white mushroom, peach, and zucchini item/head sizes; and
unsalted butter stick. **Removed in repair:** the generic yellow-onion, red-onion,
and lime item records. Foundation `1 Onion, Edible` is a sampled specimen mass
that conflicts with the broader same-food size landscape (SR 70/110/150 g; FNDDS
whole 148 g), and lime `fruit (2" dia)` carries explicit physical size evidence
that cannot truthfully become a `size_class: null` key; both remain rejected in
the census (`ambiguous_or_conflicting` and `state_or_size_mismatch`
respectively). Containers/packages (can/package/jar/box/bag/bottle), mass/volume
units, generic non-food-specific masses, density conversions, bounded estimates,
web tables, AI values, and guessed grams are NOT present.

### 36.2 Reviewed separate-module source-controlled lock

`src/core/nutritionV2/household/initialLock.ts` is a separate, source-controlled
lock that pins the schema version, registry release, exact record count (31),
the complete expected registry digest
`6ad593ef558ca9325197549f005da5b1eee822211f2ec6b5290f5c58fedc4ac4`, the complete
provenance/equivalence digest
`adba614327f9cb078ffd35d6abade50b25de180b43f4b373eea6ab8825694b31`, and the
aggregate release digest
`f8fed2230ac210c8dc2548f3a300134091c3a490ac6eb68add2766ac9b85b256` that
cryptographically commits to both. The verified loader recomputes every digest
from the data and fails closed unless all match. Because the lock is deliberately
kept in a separate module from `initialData.ts`, editing, adding, removing, or
substituting any record, provenance field, or equivalence rationale without a
reviewed lock update fails every test. Correcting or extending the data
therefore REQUIRES a deliberate review and an explicit lock change.

This lock is a **repository-local reviewed constant set**, not an external
signature or external distribution trust service: **no external cryptographic
trust anchor or distribution authenticity system exists yet**, and that remains
future work.

### 36.3 Immutability, digest binding, and verified-loader-only access

Records and provenance are immutable and digest-bound: the Phase 4 loader
recomputes each `record_digest` over the canonical semantic payload and binds
the registry digest over the ordered record digests, and the Phase 5 provenance
digest binds the registry release, schema, record count, every authenticated
record (key, fields, sorted bound-FDC set, record digest), every provenance
entry (source release/FDC/record digest, portion index/id, amount, gram weight,
measure, modifier, derived grams, citation linkage), and every equivalence
rationale. The aggregate release digest commits to the registry and provenance
digests together.

Raw record, provenance, and rationale definitions are MODULE-PRIVATE. The only
public access path is the lock-verifying `loadHouseholdInitialRegistry()`, which
returns a fresh immutable registry plus a deeply frozen verified dataset
(provenance and rationales). No barrel re-exports the data. Exactly ONE runtime
module reaches it — the Phase 6 calculation-layer resolver
(`calculation/householdPortion.ts`), and only through the verified loader; the
raw data/lock/provenance modules are imported by no consumer. No mutable
registration/replacement/update API exists. Current
grams bounds: minimum 3 g, maximum 1248 g, all positive safe integers within the
10,000 g contract bound.

### 36.4 Runtime consumer (Phase 6 integration)

The Phase 6 resolver (§37) is the ONLY runtime consumer, and it reaches the data
exclusively through the verified loader. The data itself still contains no
matching, ranking, calculation, live-row, analyzer, AI, hydration, Apply,
persistence, schema, UI, or server authority: the resolver derives one household
MASS relationship for an already-authenticated USDA food identity, and no line
gains grams unless its exact key (FDC + canonical unit + size + state) matches.
The Phase 0/1 barrels do not re-export the data. The Phase 4 holder-freeze
defense-in-depth flag (the returned outer holder object is not itself
`Object.freeze`d although all authoritative content is immutable) remains
deferred and is not addressed here.

---

## 37. Household-portion registry — registry-track Phase 6 integration

**Status: integrated (uncommitted).** Phase 6 makes the verified Phase 5
household-portion dataset a deterministic mass source inside the existing
Advanced Nutrition pipeline. It adds no records, edits no gram values, and
changes no AI, nutrient-composition, matching, or schema authority beyond the
narrow, truthful persistence extension described below.

### 37.1 Authority position

Household portions are the LOWEST mass authority. The shared effective-mass
decision (`calculation/effectiveMass.ts`) now resolves ONE source in this order:

1. direct recipe mass;
2. explicit user-entered mass;
3. authenticated USDA source portion;
4. authenticated USDA count portion;
5. verified Kitchen Codex household portion;
6. no mass.

A household result never overrides direct mass, user mass, or a selected USDA
source/count portion. Multiple non-direct sources (including household) are a
conflict and fail closed; a direct recipe mass combined with any alternate
choice — household included — is a conflict and fails closed. The reducer and
the UI merge paths delete the household choice whenever a higher-authority
source is stored for the line, so ordinary operation cannot create a conflict
(conflicts remain the fail-closed backstop for forged/legacy state).

### 37.2 Authenticated lookup and exact binding

`calculation/householdPortion.ts` is the ONE resolver. It loads the registry
ONLY through the Phase 5 verified loader (registry + provenance + aggregate
digest locks must all verify; raw data stays module-private) and builds a
module-private immutable exact-key index:

```
bound FDC id | canonical household unit | size (or null) | required state (or null)
```

The recipe context (quantity, unit, size, state) is derived exclusively with the
existing canonical contracts — `parseIngredient`, `projectQueryText`, and
`deriveCountRequirement` — plus the Phase 1 household-unit owner. A named unit
must be a Phase 1 count noun; a size-only whole-food line has `item` semantics;
a unit that is neither is never coerced. Every declared dimension must match
exactly. No default size, midpoint, range endpoint, container mass, package
size, density, or "closest" record is ever used; a missing or ambiguous
dimension yields NO mass. A quantity range, a non-positive/non-exact quantity,
or more than one recognized physical state yields NO mass.

### 37.3 Selection binding and digest verification

A stored household choice is a closed `household_portion_selection_v1` object
binding the line, the ingredient identity digest, the USDA bundle release and
record digest, the registry release and registry/provenance/aggregate digests,
the household record key and digest, the canonical unit/size/state, the recipe
quantity, the resolved grams, and a deterministic SHA-256 selection digest. The
calculator NEVER trusts the working-state object: it sanitizes the selection,
independently re-derives the resolution from the verified registry plus the
authenticated USDA record, recomputes the selection digest locally, and requires
exact equality of every field. A stale, forged, cross-line, cross-food,
cross-quantity, or cross-release selection fails the whole calculation closed.
The live row obtains its household grams through the same bounded calculator
dry-run used for every other explicit selection, so the display can never claim
a mass the calculator rejects.

### 37.4 Live, UI, and summary evidence

`MassSource`/`LiveRowMassSource` gain `household_portion`. The collapsed row
shows `{grams} g · vetted household portion`; a `bounded_estimate` record would
be shown as `{grams} g · household estimate` and expanded evidence says
`Kitchen Codex household estimate`, so an estimate never looks like
authenticated USDA source-portion data. Expanded evidence names the Kitchen Codex
household portion, the canonical unit/size/state, and the authority class. It is
never labeled USDA portion, user-entered, or AI-provided, and an alternative
household control is not offered on a direct-mass line. Status and counts
continue to come from the ONE live-row projection and `summarizeLiveRows`; no
second status system exists.

### 37.5 Persistence: a true versioned schema (v1 restored, v2 added)

Household mass cannot be persisted with schema-v1 omission (omission means a
genuine `user_mass`) or as a USDA `source_portion` (that would lie about
provenance). The repair therefore introduces a GENUINE versioned contract
instead of silently expanding v1:

- **Schema v1 is unchanged and closed.** Its conversion bases remain exactly
  `direct_mass` and `source_portion`; there is no household evidence key; an
  unknown v1 field, an unknown v1 basis, or a household basis/evidence object
  marked `schema: 1` fails closed. Genuine v1 user mass keeps its existing
  omitted-basis representation. A parent-style v1 reader rejects every
  household-bearing block.
- **Schema v2 (`CODEX_NUTRITION_SCHEMA_V2 = 2`) is the smallest truthful
  extension.** It retains every valid v1 line/result meaning and adds ONLY the
  closed `household_portion` conversion basis plus the closed
  `IngredientEvidenceV2.household_portion` evidence object
  (`registry_release`, `record_key`, `record_digest`, `household_unit`,
  `size_class`, `requires_state`, `quantity`, `selection_digest`). Basis and
  evidence are coupled BIDIRECTIONALLY: basis without evidence, evidence
  without basis, conflicting mass evidence (an unresolved line or a
  missing/non-positive gram amount), unknown evidence fields, unknown bases,
  and unknown schema versions all fail closed.
- **Version-specific decoding.** `decodeCodexNutrition` selects the validator
  from the schema discriminator (`1` -> v1, `2` -> v2); an unknown future
  numeric schema remains bounded opaque data that is never interpreted and can
  never be overwritten. The schema version participates in the canonical
  encoded block, so the Phase 5 candidate digest differs between a v1 and a v2
  write.
- **Canonical conditional write policy.** If an applied result contains at
  least one `household_portion` line, the WHOLE block is serialized as schema
  v2. If no household line exists, the canonical write remains schema v1. New
  code reads both. Dropping the last household line and re-applying
  deterministically returns the block to canonical schema v1.
- **Old/new reader compatibility.** Older builds that only understand schema
  v1 fail a household-bearing v2 block closed (never interpreted) and never
  read it as user mass or a USDA portion. New readers accept valid historical
  v1 blocks and valid v2 household blocks. Old readers are NOT able to
  understand household data; honest fail-closed incompatibility is the
  contract.

### 37.6 Apply and reopen

Apply re-derives the preview through the genuine session before authorizing; a
household line is re-resolved from the current recipe text, food identity, USDA
bundle, verified registry release, record, and selection binding, so a stale
registry release, forged record digest, changed quantity/unit/size/state, changed
food/FDC, unresolved line, conflicting sources, or invalid grams refuses the
write before anything is persisted. Reopen independently re-authenticates the
registry and restores the household choice ONLY when the registry release, record
key/digest, unit, size, state, quantity, and grams all match; otherwise the row
stays NEEDS AMOUNT and is NEVER degraded into `user_mass`. Genuine schema-v1 user
masses, direct masses, and USDA source/count blocks keep their existing reopen
behavior.

Reader matrix (proven by tests):

| Stored block | Parent-style v1 reader | New reader |
| --- | --- | --- |
| schema 1, no household | valid v1 | valid v1 |
| schema 1 with household basis or evidence | fails closed | malformed v1 (fails closed) |
| schema 2, valid household provenance | fails closed (never user mass) | valid v2, household restored |
| schema 2, stale/forged household binding | fails closed | row stays NEEDS AMOUNT, never user mass |
| unknown future schema | opaque, never interpreted | opaque, never interpreted |
| schema 2 recomputed with no household line | — | canonical schema-v1 rewrite |

### 37.7 Unchanged boundaries and exclusions

- AI authority is unchanged: AI never supplies or selects grams, FDC IDs,
  registry record IDs, releases, digests, candidate indexes, portion masses,
  totals, or Apply authorization, and the planned household-unit AI hint
  remains future work.
- USDA nutrient-composition authority is unchanged: nutrients always come from
  the authenticated target FDC; the registry authorizes ONLY a household mass
  relationship and never transfers nutrients.
- Matching/ranking identity authority is unchanged; the household resolver
  never manufactures food identity.
- Excluded: new household records, value edits, fuzzy matching, density or
  volume-to-mass conversion, generic container/package weights, web/API lookups,
  provider catalog work, and any Phase 7 behavior.

### 37.8 Measured resolution (pinned bundle)

With the pinned bundle, three ordinary lines in the established corpus now
resolve through the verified household fallback where no higher source was
available: `3 cloves garlic` → 9 g (`garlic|clove|null|null`), `2 medium
tomatoes` → 246 g (`tomato|item|medium|null`), and `1 stick unsalted butter` →
113 g (`unsalted butter|stick|null|null`). Lines without a truthful exact
binding (e.g. `2 celery stalks`, `1 red bell pepper`, `1 medium head green
cabbage`, `2 medium potatoes`, `1 lemon`, `2 slices white bread`) remain
`NEEDS AMOUNT`. No automatic food identity changed.

### 37.9 Registry contract coverage vs natural reachability

The Phase 6 suite separates two different claims. The **registry binding
contract** group verifies all 31 published records against an independently
hardcoded oracle (authenticated key, unit, size/state, FDC binding, grams,
record digest, lock identities) using CONTROLLED resolver inputs; it makes NO
claim that ordinary recipe lines naturally reach every record. The **real
pipeline reachability** group runs ordinary lines through parse -> review ->
analyzer -> calculation -> live projection and records the real outcome:
household-reachable (`3 cloves garlic`, `3 garlic cloves, minced`, `2 medium
tomatoes, sliced`, `1 stick unsalted butter`, `1 medium peach`, `1 large red
bell pepper`, `1 large green bell pepper`); correctly SHADOWED by an
authenticated USDA count portion (`1 large egg`, `1 medium white mushroom`,
`1 head large red cabbage` — no household choice is created and the higher
authority remains effective); identity-review blocked (`1 medium zucchini`,
whose review is `review_required` with no deterministic selection, so no
identity authority exists to convert); and parser-limitation blocked
(`1 large head red cabbage`, see §37.13). Shadowing is correct authority
behavior; household resolution is never forced merely to exercise a record.

### 37.10 Estimate display is synthetic-tested only

Every production record is `usda_derived`; there is NO `bounded_estimate`
record in the Phase 5 slice and there is no end-to-end production estimate
path. The estimate display branch (`Kitchen Codex household estimate`) is
exercised only by a synthetic UI-evidence test. A future estimate record
requires its own data review, lock update, audit, and a production acceptance
test; it must not be implied to exist today.

### 37.11 `user_confirmed` semantics

The persisted `IngredientEvidence.user_confirmed` field keeps its established
Phase 5 meaning: "this evidence was part of the explicit reviewed result the
user authorized by clicking Apply" — it does NOT mean "the original match
required a manual click", and it is not a mass provenance. A unique-exact
match, a deterministic analyzer selection (`auto_confirmed`), an AI-assisted
deterministic acceptance (`ai_assisted`), and a manual user choice are all
persisted as `match_status: 'confirmed'` + `resolved: true` +
`user_confirmed: true` once the user Applies. The automatic-vs-user-vs-AI
distinction lives in the WORKING row: the live food authority remains
`unique_exact` / `automatic` / `ai_assisted` / `user_confirmed` before Apply,
and hydration restores the reviewed food through the genuine session.

Consequences enforced by tests: an automatic household resolution is never
displayed as manually entered or manually selected, never changes food-identity
authority to `user_confirmed` in the working row, and never becomes `user_mass`.
After Apply, the persisted `user_confirmed: true` carries the
Apply-authorization meaning above; the mass keeps
`conversion_basis: 'household_portion'` and its dedicated label. Reopen
restores the household MASS (never a user mass); the restored food identity
follows the pre-existing reviewed-reopen contract.

### 37.12 Garlic, the AI count path, and the Clear flow

`3 cloves garlic` and `3 garlic cloves, minced` resolve deterministically
through the verified household clove record (9 g) before any AI runs. Because
the production AI-count verifier needs a genuine `NEEDS AMOUNT` row to exercise
the AI-assisted count path, that verifier explicitly CLEARS the household
fallback through the UI ("Clear" in the household control), proves the row
becomes `NEEDS AMOUNT`, then runs AI. The AI count resolution itself is
unchanged and remains AI-assisted USDA count provenance, never household and
never user-confirmed. The verifier keeps `after <= beforeClear` (the cleared
household mass can only be recovered, never exceeded) and additionally requires
a STRICT drop versus the post-clear pre-AI state, so a no-op AI run still fails
the scenario.

### 37.13 Parser limitations and layered guards

`1 large head red cabbage` (size adjective BEFORE the named unit) is a parser
limitation, not a household gap: the parser classifies `head` as a preparation
qualifier, so no canonical count unit/size is derived; the size-only
item-mapping path then correctly REFUSES to reinterpret the named `head` unit
as one whole item (`head` is a recognized household count noun), and the line
stays `NEEDS AMOUNT`. The unit-first form (`1 head large red cabbage`) parses a
canonical `head` + `large` requirement and is resolved by the higher USDA count
authority (1134 g) before household is considered. No mass is ever invented for
the ambiguous ordering.

The outer container/range guards in `deriveHouseholdLookupContext` are
deliberate DEFENSE IN DEPTH. Mutation probes neutralizing either the explicit
container guard or the explicit non-exact/range guard do NOT produce a mass:
range lines parse with no amount (the amount guard fails closed) and size-first
container lines lose their container/unit token (the item-mapping token scan
fails closed). Both layers are retained and the behavioral tests pin the
no-mass outcome.

## 38. Phase 7 — AI household interpretation alignment (isolated)

Phase 7 aligns the optional AI interpretation layer with the completed Phase 6
verified household-portion system. AI interprets language only; deterministic
local code decides whether any authenticated household record applies. The
Phase 6 registry, records, digests, grammar, precedence, and schema are
unchanged.

### 38.1 Closed unit/size/state hint contract (`nutrition_ai_resolution_v4`)

One canonical, locally owned hint contract carries a bounded household
interpretation. The AI wire contract (`AiResolutionSuggestion`) adds exactly
three optional string fields — `household_unit_hint`, `household_size_hint`,
`household_state_hint` — and the AI resolution contract constant is bumped to
`nutrition_ai_resolution_v4`. The provider schema declares them and the strict
sanitizer enforces them field-by-field; an unknown, forbidden, or
authority-shaped field rejects the WHOLE response (fail closed), never a
partially trusted one.

The tokens are canonicalized locally through the project's existing single
owners: `canonicalHouseholdCountUnit` (`src/utils/householdUnits.ts`, count
nouns only), `canonicalSize` (`calculation/countPortion.ts`, whose canonical
outputs are exactly the registry size classes), and `canonicalHouseholdState`
(`calculation/householdPortion.ts`, reusing the ONE `HOUSEHOLD_STATES`
vocabulary exported by `household/normalize.ts`). Unknown tokens are reduced to
"no hint"; a known household CONTAINER unit (`can`, `jar`, `package`, `box`,
`bag`, `bottle`) rejects the hint whole; non-string/array/object/oversized
values and non-ASCII/confusable size wording never match. The sanitizer consumes
`isPlainObject` input, never mutates it, and prototype-shaped input is harmless.
The closed hint is interpretation-only: it contains no amount, mass, FDC id,
registry record id, portion index, nutrient, digest, confirmation, or
authorization.

### 38.2 Source constraints outrank AI suggestions

The household lookup context is derived from the session-bound original
ingredient text through the existing canonical parser and query projection
(`parseIngredient`, `projectQueryText`, `deriveCountRequirement`). Ai-provided
unit/size/state may only FILL a dimension the source line does not declare:

- an explicit source unit (including a non-household count noun such as
  `serving`) is authoritative and is never replaced;
- an explicit source size is authoritative; a contradictory hint is ignored;
- an explicit source state is authoritative; a contradictory hint is ignored
  and the source state still keys the lookup;
- a range quantity, a direct mass line, a container line, and a volume line are
  refused before any hint is considered;
- the recipe quantity remains the only quantity; the AI cannot change a range
  into an exact amount, a container into a count or household mass, or a size
  into a different size.

### 38.3 Local deterministic resolution

For a still-unresolved eligible `NEEDS AMOUNT` line with a resolved food
identity, `resolveHouseholdsFromAiSuggestions`
(`src/core/nutritionV2/phase4/aiHouseholdResolve.ts`) asks the genuine Phase 6
builder (`buildHouseholdPortionChoice`) for the exact-key registry record. The
builder performs the identity-binding dry run through the genuine session,
resolves the authenticated registry record, builds the closed digest-bound
selection, and re-verifies the whole binding through the calculation engine. The
resolver accepts only a genuine success; absent, incomplete, or ambiguous
records leave the line unresolved. It never picks the first/top/closest record,
never accepts an AI-authored gram/FDC/record value, and never marks the choice
`user_confirmed`.

`automatic` versus `aiAssisted` (audit repair). The two flags are independent
and truthful: `aiAssisted: true` means only that AI supplied accepted household
WORDING; `automatic` is derived by the genuine core builder from the
authenticated food/match authority already present in the working state and is
NEVER forced by AI assistance. An analyzer-automatic food yields
`automatic: true`; a user-confirmed/manual (or unique-exact) food yields
`automatic: false`. `automatic` is a working-state display marker with no
downstream authority: flipping it changes no selection, gram, provenance, or
persisted value.
The bounded hint travels with the working choice as
`household_requirement_hint`, is canonicalized again at the calculation
boundary, and is NOT persisted.

### 38.4 Authority, persistence, and reopen

Every accepted resolution flows through the existing calculation and Apply
authority chain. AI authors no FDC id, registry id, gram weight, package mass,
quantity override, USDA portion index, household record index, nutrient value,
conversion math, registry version, catalog/record/candidate/ingredient/selection
digest, confidence, user confirmation, application authorization, persistence,
or Apply eligibility. The preview stays advisory and unapplied
(`application_authorized: false`); closing without Apply writes nothing; only an
explicit Apply persists, using the unchanged schema-v2 household provenance.

Because the AI hint is not persisted, reopen retains only what the Phase 6
schema contract can truthfully re-authenticate: a household basis unlocked by AI
wording alone does not re-authenticate without the hint, so the working review
stays unresolved rather than inventing authority. The saved block itself remains
valid and readable. No schema change and no v3 format were introduced.

### 38.5 Stale / mid-flight protection

The per-line working-choice fingerprint covers the food match, the
authenticated source portion, the authenticated count portion, an explicit
user-entered mass, and the verified household choice (including an explicit
Clear). The snapshot is taken for EVERY current row (not only the rows the
request targets) because the response merge boundary applies entries per
`line_ref`; a newer user decision — including the Clear of an existing verified
household choice — is therefore final even when that line was not part of the
request. A response for a different recipe/session, an older generation, a
superseded request, or a closed editor is discarded before any state mutation;
a row whose working choice changed during the request is skipped per line so
unaffected lines still resolve. The independent household merge guard remains
the second layer: it refuses a verified household choice over a line that
already carries one, or any stored higher-authority mass source. AI results
never overwrite a manual food selection, a user-entered total mass, an
authenticated USDA source/count portion, a previously verified household
portion, a direct recipe mass, a newer match/amount decision, an edited
ingredient text, a changed quantity, or a changed serving context.

### 38.6 Truthful messaging

The AI copy states that AI interprets food wording, count language, and
household unit/size/state wording only, and that the pinned USDA catalog, the
deterministic matcher, authenticated USDA portions, and the verified Kitchen
Codex household registry decide every resolution; AI never supplies grams. A
resolved household row is labeled as a vetted (or bounded-estimate) household
portion, with an "AI-interpreted wording" marker only when the wording was
AI-assisted. Resolved/unresolved counts derive from the post-operation live
projection.

### 38.7 Phase 8 is not implemented

Phase 7 deliberately does not perform the broader final migration, staleness,
full round-trip, production-browser, corpus, or release-exit program; that
remains Phase 8. No household records, USDA bundle data, density tables,
container masses, package-size guessing, provider catalogs, fuzzy matching, or
persistence formats were added.

### 38.8 Phase 7 final audit findings repair (stale-verifier maintenance + contract hardening)

A narrow repair pass addressed the independent audit's findings without
reopening the cleared Phase 6 authority architecture and without starting
Phase 8. No authority source, registry record, USDA bundle datum, schema
definition, persisted selection version, matching/ranking threshold, parser
grammar, provider catalog, hosting, or billing contract changed.

- Repaired Phase 5C production verifier. The advanced hamburger recipe
  contains `2 medium tomatoes, sliced`, which Phase 6 legitimately resolves
  through the verified household registry (`tomato|item|medium|null`,
  2 × 123 g = 246 g), so the analyzer-driven Apply persists canonical schema v2
  with household provenance instead of schema v1. `scripts/verify_phase5c_prod.ts`
  now asserts schema v2 and the exact household provenance (registry release,
  record key, unit, size class, quantity binding, conversion basis, grams,
  selection/record digests) for that line, while continuing to assert canonical
  schema v1 for non-household persisted recipes. This is stale-verifier
  maintenance originating from Phase 6, not a Phase 7 behavior change; an
  ordinary unit regression in
  `tests/unit/advancedNutritionPhase7AiHouseholdAlignment.test.ts` pins the same
  behavior so it is not browser-only.
- `automatic` semantics. The AI household adapter no longer forces
  `automatic: true`; it preserves the value derived by the core builder from
  the authenticated food/match authority. A user-confirmed food therefore
  yields an AI-assisted household choice that is NOT analyzer-automatic, and
  the flag has no downstream authority effect.
- Builder mass-and-volume exclusion. `buildHouseholdPortionChoice` rejects a
  direct-volume line at its creation gate (reusing the canonical parsed
  `measurement_kind`, never a string heuristic), exactly as it already rejected
  a direct-mass line. Direct calls, analyzer calls, AI calls, the calculator,
  and the live projection fail closed consistently; valid USDA source-portion
  resolution for volume lines is preserved.
- Modal display authority. The Modal's household portion panel no longer
  renders the stored `choice.resolved_grams` claim. Displayed grams come from
  the SAME calculator/live-verified row projection used elsewhere; a
  forged/tampered stored gram field cannot alter any visible gram value, and a
  rejected choice shows no grams, no MATCHED state, and no household chip.
- Vocabulary drift and estimate policy. The test matrices are pinned by exact
  set equality to the canonical production vocabularies (household states, size
  classes, AI-eligible count nouns, authority classes), so a production
  vocabulary addition/removal requires an intentional test update. A synthetic
  (test-only) bounded-estimate registry proves the invariant that AI hints
  cannot promote a bounded estimate into stronger or more automatic authority
  than the ordinary Phase 6 household path permits; an estimate stays visibly
  an estimate and is never presented as an exact `usda_derived` conversion.
  Phase 6 defines no explicit-review-only rule for `bounded_estimate`, and no
  production estimate record exists; nothing was added to the registry.
- Truthful server prompt vocabulary. The server household prompt now renders
  its accepted unit/size/state lists directly from the canonical exported
  vocabulary constants (`householdCountNouns`, `HOUSEHOLD_SIZE_CLASSES`,
  `HOUSEHOLD_STATES`) and presents them as exact, so accepted tokens such as
  `petite` and `xxl` can never be silently omitted from an allegedly exhaustive
  list. A drift test binds the prompt list token-for-token to the canonical
  owner.
- Calculation-request fail mode. A malformed stored household hint (extra key,
  container unit, unsupported size/state, nested object, non-string value,
  prototype-shaped input, oversized token) fails the WHOLE calculation closed
  with a bounded classification rather than silently degrading to ordinary
  unresolved behavior; live projection claims no grams and no MATCHED state.

Phase 8 remains NOT STARTED.

## 39. Phase 7 resolution-coverage systemic repair (benchmark-driven)

Real-world smoke testing showed that Advanced Nutrition left too many ordinary
ingredients unresolved even when the pipeline held enough information. A
checked-in benchmark was added before any behavior change:

- corpus: `tests/fixtures/advancedNutritionResolutionCorpus.ts` (class lines plus
  the reused real-ingredient identity corpus);
- runner: `scripts/benchmark_resolution_coverage.ts` (real pinned bundle; prints
  per-line terminal state, authenticated mass source, and bounded failure reason
  codes; `--json` for before/after comparison).

Baseline on the corpus: 91 lines, 33 fully auto-resolved (36.3%); top reasons
`qualitative_or_absent_amount`, `selected_record_lacks_compatible_portion`,
`identity_needs_review`, `authenticated_count_absent`,
`compatible_candidate_exists_but_not_selected`, `mass_range_not_parsed`,
`container_mass_absent`. After the generalized repairs below: 42/91 (46.2%),
with **no line losing its previous resolution and no wrong-food resolution
added** (all newly resolved classes use an authenticated deterministic source).

### 39.1 Explicit mass ranges (documented midpoint policy)

`quantity_range` was parsed but never consumed, so `3-4 lb`, `75-100 grams`,
and `3 to 4 lb` stayed `NEEDS AMOUNT`. The review parse now derives a
representative grams value for a **direct MASS range** as the arithmetic
MIDPOINT of the recipe author's own endpoints
(`representativeMassGrams` in `matching/parse.ts`). Truthfulness is preserved:
`amount` stays `null`, `quantity_kind` stays `range`, and `quantity_range`
keeps both endpoints, so no endpoint is silently chosen and the range remains
visible to the working review. Count and volume ranges are deliberately NOT
converted (a midpoint count/volume would fake precision the recipe never
stated).

### 39.2 Explicit secondary (parenthetical) mass

A parenthetical explicit total mass is the same authority class as a direct mass
range: `3 to 4 slices provolone (about 75 to 100 grams in total)` and
`2 slices bacon (about 20 g)` resolve through the same midpoint policy, and the
measurement clause is stripped from the food query (`provolone`) so the
identity is never polluted. Container lines are excluded: the canonical parse
represents a declared package net mass (`1 (15 oz) can ...`) separately
(`package_net_mass`) and deliberately does NOT convert it into mass authority;
that remains a documented, non-converted representation (a candidate for a
future reviewed policy), not a silent conversion.

### 39.3 Measurement-aware candidate resolution

Food identity is the gate; measurement compatibility is a resolution criterion
inside valid identities. When a STRICT automatic selection exposes NO compatible
authenticated VOLUME portion at all, and another candidate carries the
IDENTICAL normalized description token set (an equivalent duplicate USDA record
of the same food, e.g. two `Cream, heavy` records), the analyzer prefers the
portion-bearing duplicate (`chooseDescriptionEquivalentPortionFood` in
`phase4/analyzer.ts`). Count/stalk-style interpretations are deliberately not
reordered: the Phase 1/4/5/6 contract keeps size-specific count portions from
binding an unsized requirement, and an ambiguous-but-present portion set stays
with the strict default. The identity gate is never crossed, and portion
availability never rescues a semantically different food (see §39.4).

### 39.4 Count identities and semantic guard

`extractCountIdentity` now strips parenthetical package descriptors before
tokenizing, so `1 slice (15 per 8 oz package)` is a slice (not a portion
discarded because the note contains `oz`); `6 slices mortadella` resolves to
90 g through the authenticated count portion. `shucked` joins the closed
preparation-qualifier vocabulary, so `24 pieces fresh shucked oysters` no
longer fails identity on a preparation action.

The semantic identity gate is unchanged and remains authoritative: for
`1/4 teaspoon crushed red pepper flakes` the requested `flakes` form is absent
from every candidate, so neither the fresh bell-pepper record nor any other
record is auto-selected; measurement compatibility cannot compensate for a
missing requested form. `X or Y` alternatives are never collapsed into a
fabricated single food identity.

### 39.5 Authority order and deferrals

Every newly covered class resolves through the strongest truthful
authenticated source available (direct mass for ranges/secondary mass,
authenticated source portion for volume, authenticated count portion where
available), never through a weaker estimate while a deterministic path exists.
No bounded-estimate path was added in this round: vague amounts (`pinch dried
basil`) remain truthfully unresolved rather than receiving fabricated grams or
USDA provenance; a defensible bounded-estimate contract (interpreted
measurement, bounds, category, explicit estimate provenance, and UI
separation) remains future work. Also deferred: container net-mass conversion,
size-specific count binding for unsized requirements, and deterministic
resolution of alternatives and missing-variety identities (AI semantic rescue
may interpret them; deterministic validation still decides authority).

### 39.6 Post-audit repair: nutrient annotations and range provenance

A final audit found two truthfulness gaps in the §39.2/§39.1 handling; both are
repaired without new authority.

**Nutrient annotations are never ingredient mass (BLOCKING repair).** The
secondary-mass reader is narrowed to a positive grammar plus fail-closed
exclusions. A parenthetical is accepted as a written total mass ONLY when,
after an optional approximation adverb (`about`, `approximately`, `~`, ...), it
is an explicit MASS quantity followed by nothing or a closed total-mass trailing
phrase (`total`, `in total`, `net`, `drained`, ...). Any parenthetical naming a
nutrient or nutrition-annotation syntax (`protein`, `fat`, `carbs`,
`carbohydrate`, `fiber`, `sugar`, `sodium`, `cholesterol`, `calories`, `kcal`,
`% DV`, `per serving`) is rejected BEFORE any mass interpretation, and the clause
is also stripped from the food query so it cannot pollute identity. Thus
`1 cup flour (20 g protein)` never gains 20 g of direct mass; its own `1 cup`
flows to the authenticated source portion (125 g) instead, and
`2 tbsp peanut butter (8 g protein per serving)` resolves 32 g from its own
tablespoons. Credible written totals (`(about 20 g)`, `(20 g)`,
`(75-100 g in total)`, `(approximately 250 g)`) still resolve through the
midpoint policy of §39.1.

**Written-range representative provenance (FLAG repair).** A mass derived from a
written range remains distinguishable downstream from an exact author-written
scalar. The review parse exposes a bounded `range_representative`
(`amount_source: 'written_mass_range'`, `policy: 'midpoint'`, `lower`, `upper`,
`unit`, `representative_grams`) ONLY when the representative came from a range;
the live row carries the same marker (`mass_representative`), and the UI mass
text renders the midpoint through the ordinary 1-decimal display rounding as
`... g · written range midpoint (lower–upper unit)`. An exact `3.5 lb` line has
no such marker and stays an exact scalar. `amount` stays `null` and
`quantity_kind` stays `range` for ranges; raw floating-point artifacts are never
rendered.

The same rule covers a credible SECONDARY parenthetical total-mass range
(`3 to 4 slices provolone (about 75 to 100 grams in total)`): the marker is
attached only to the source that actually supplied the resolved grams (a direct
range first, otherwise the secondary range), so an exact parenthetical scalar
and an exact base measurement never gain a range marker.

---

## 40. Persisted written-mass-range provenance (schema v3)

A focused re-audit (`FLAG-1`) found that the §39.6 written-range midpoint
provenance existed through parsing, review, live-row state, and UI but was LOST
in the persisted `codex_nutrition` block: a block-only consumer saw a scalar
gram amount and could not tell a range midpoint from an exact authored scalar.
This section documents the repair.

### 40.1 The persistence gap

`3-4 lb beef chuck roast` reviews as `quantity_kind: 'range'`, endpoints 3/4,
midpoint policy, representative grams 1587.573295. Phase 5A persisted only
`amount: { value: 1587.573295, unit: 'g' }` with `conversion_basis:
'direct_mass'` — identical in shape to `3.5 lb`. The authored range authority
(endpoints + unit + representative policy) was unrecoverable from the block.

### 40.2 Why a genuine schema version (v3) was required

- The persisted scalar `amount` changes MEANING for a range line (a
  deterministic representative of an authored range, not an authored scalar);
  that is a new authoritative persisted meaning, not merely an optional field.
- The established policy (§33.1 / §37.5) is to introduce a genuine versioned
  contract for a new provenance meaning rather than silently expanding an
  existing version in place. v1 and v2 remain byte-for-byte frozen.
- Forward compatibility: an older reader reports schema 3 as opaque and
  preserves it (§23.5), whereas an in-place v1/v2 field would make older readers
  treat the whole block as `malformed`.
- v3 is the SMALLEST versioned extension: it retains every v1/v2 meaning
  (household included) and adds exactly one closed optional evidence object.

### 40.3 Schema contract

`CODEX_NUTRITION_SCHEMA_V3 = 3`; `CodexNutritionV3` retains the v1 top-level
keys and v2 household meaning. The only addition is the per-line
`IngredientEvidenceV3.range_representative`:

```
range_representative = {
  amount_source: 'written_mass_range',
  policy: 'midpoint',
  lower, upper,            // the author's own endpoints
  unit,                    // the original authored mass unit
  representative_grams     // equals the stored canonical `amount.value`
}
```

Coupling (all fail the WHOLE block closed):

- present ONLY with `conversion_basis: 'direct_mass'` and `resolved: true`;
- `amount.unit` must be `g` and `amount.value === representative_grams`
  (byte-for-byte), so the two persisted scalars can never contradict;
- `lower`/`upper` bounded positive finite numbers with `lower <= upper`; `unit`
  bounded non-control text; `representative_grams` a bounded positive finite
  number;
- unknown marker fields, unknown amount sources, unknown policies, a marker in
  a v1/v2 block, and a marker on a source-portion/household/unresolved line all
  fail closed.

`decodeCodexNutrition` selects v1/v2/v3 by discriminator; schemas 4+ remain
bounded opaque data that is never interpreted and never overwritten.

### 40.4 Canonical conditional write policy

Phase 5A builds the block from the GENUINE re-derived preview only:

- any written-range marker (with or without household provenance) -> schema v3;
- household provenance only -> schema v2 (unchanged Phase 6 behavior);
- neither -> schema v1 (unchanged).

Dropping the last range/household line and re-applying deterministically
returns to the smallest truthful version. The marker's
`representative_grams` is written as the SAME canonical rounded scalar as the
line `amount`; the preview midpoint may differ only by the canonical 6-decimal
rounding. The marker participates in the preview `ingredient_digest` (via the
calculation `fullPayload`) and therefore in the canonical candidate digest,
Apply authorization, replace-mode regression gate, and post-write verification.

### 40.5 Authority and AI containment

The endpoints, unit, policy, and representative are deterministic
recipe-authored evidence. They are derived exclusively from the canonical parse
inside the genuine calculation and copied by Phase 5A; a caller-supplied
preview, an AI-assisted selection carrying forged provenance fields, and a
hostile existing v3 block can never contribute them. A divergent forged
selection fails Apply authorization (`calculation_mismatch`); an injected
marker on an otherwise-genuine selection is ignored because the recommendation
selection contract is closed and the provenance is re-derived from the recipe
text. No marker is ever fabricated for an exact scalar.

### 40.6 Reader matrix

| Stored block | Reader before this repair | Reader after |
| --- | --- | --- |
| schema 1, exact direct mass | valid v1 | valid v1 (no marker) |
| schema 2, valid household provenance | valid v2, household restored | valid v2, household restored |
| schema 3, valid written-range evidence | opaque, never interpreted | valid v3, marker available to block consumers |
| schema 3, malformed marker coupling | opaque | malformed (fail closed, never trusted) |
| schema 4+ (future) | opaque, never interpreted | opaque, never interpreted |

Legacy v1/v2 blocks without the marker remain fully readable; no legacy block
is migrated or rewritten without an explicit Apply.

### 40.7 Regression proof

`tests/unit/advancedNutritionPersistedRangeProvenance.test.ts` (real pinned
bundle) proves Analyze -> Review -> Apply -> serialize -> parse -> hydration for
`3-4 lb beef chuck roast` (original text preserved, schema v3, both endpoints,
unit, midpoint policy, canonical representative grams, unchanged totals, UI
still `written range midpoint (3–4 lb)`), the exact `3.5 lb` scalar remains
schema v1 with no marker and identical totals, household-only remains v2, a
household + range block is v3 retaining both, legacy blocks stay readable, the
conditional return to v1/v2, digest divergence, stale/TOCTOU and tampered-write
failures, and the closed v3 coupling matrix.
