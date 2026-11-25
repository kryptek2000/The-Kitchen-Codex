# SINC-2 — USDA Branded Foods Intelligence

Status: **IMPLEMENTED IN AN ISOLATED WORKTREE / NOT MERGED / NOT DEPLOYED**

This document describes the explicit USDA Branded Foods lookup added to Advanced
Nutrition. It is not a second nutrition engine and does not change the pinned
Foundation / SR Legacy / FNDDS bundle.

## Product behavior

An entitled Advanced Nutrition user can select one unresolved ingredient, click
**Search USDA Branded Foods**, review up to three validated manufacturer-supplied
USDA records, inspect brand/serving/nutrients/publication metadata, explicitly
select one product, acknowledge the representative-brand assumption when the
recipe does not name a brand, and then explicitly use it in the existing working
review.

Nothing is searched automatically. Nothing is selected automatically. Using a
product adds a source-backed contribution to the working review; Apply and Save
remain separate explicit actions.

## API integration

- Official origin only: `https://api.nal.usda.gov`.
- Search: `GET /fdc/v1/foods/search` with `dataType=Branded`, bounded `pageSize`.
- Detail: `GET /fdc/v1/food/{fdcId}` for at most three matching FDC ids.
- No redirects, no retries, fixed origin, bounded query length, bounded response
  bytes, timeout, cancellation, and SSRF-pinned transport through the existing
  `safeFetchJson` boundary.
- No recipe, Vault content, or recipe quantity is sent to USDA. Only the selected
  food term and an opaque line reference reach the app server; the line reference
  is used to bind the response and is not sent to USDA.

## Credential handling

`USDA_FDC_API_KEY` is read server-side only. It is never placed in a `VITE_*`
variable, browser bundle, log, error, telemetry, or response. When unset, the
route returns a bounded `USDA_BRANDED_LOOKUP_NOT_CONFIGURED` state and the UI
leaves the ingredient unresolved.

Obtain a key at <https://fdc.nal.usda.gov/api-key-signup> and set it in the
server environment. Do not commit it.

## Record validation and basis

The branded adapter accepts only `dataType: "Branded"` records and validates the
FDC id, description, brand identity, GTIN when present, dates, serving amount and
unit, label nutrients, nutrient units, and numeric bounds.

The calculation basis is explicit:

- label nutrients are per the published label serving;
- a mass serving (`g`/`kg`/`mg`/`oz`/`lb`) is converted to grams;
- a volume serving (`ml`/`l`/`fl oz`) remains volume;
- a volume-authored recipe line may use the product's **own declared household
  serving relationship** (for example, a label that declares `2 tbsp = 30 g`)
  when the recipe uses that household measure;
- no generic density, household-text-only gram weight, or per-100-mL-as-grams
  conversion is invented;
- missing nutrients stay absent, explicit zero stays zero, and label rounding is
  preserved;
- a record with no usable serving basis remains visible but cannot be applied.

## Provenance

Every accepted contribution preserves:

- `source_kind: "usda_branded"`;
- FDC id and product description;
- brand owner/name when published;
- serving amount/unit and nutrient basis;
- publication date when published;
- the exact source snapshot digest (`sha256:...`);
- a server-held `evidence_id` and the exact local `target` used for scaling;
- a server-signed `verification` assertion bound to the canonical contribution digest,
  recipe digest, review/session identity, and short expiry.

## Server-authenticated Apply verification (SINC-2R4)

A public SHA-256 digest, a UUID, or a browser-maintained registry entry is not
proof of source authenticity. A contribution shown in the working review is only
a proposal. At the explicit Apply boundary:

1. the client sends the selected `evidence_id`, exact local target, canonical
   digest of the proposed contribution, the current recipe digest, and the
   review/session identity to the app server;
2. the server looks up its OWN verified source snapshot, deterministically
   recomputes the contribution with the existing builder, and rejects any
   mismatch;
3. only on an exact match does it sign an ECDSA P-256 assertion over the exact
   contribution digest, branded source identity (`evidence_id`, FDC id, snapshot
   digest), serving/scaling target, recipe digest, review/session identity, and
   a short expiry;
4. the browser verifies that signature against the IMMUTABLE BUILD-TIME public
   key anchor (`VITE_USDA_BRANDED_SIGNING_PUBLIC_KEY` /
   `VITE_USDA_BRANDED_SIGNING_KEY_ID`). A lookup response cannot register or
   replace that anchor. A verified proposal may enter the working review, but
   listing it there is not authority to Apply;
5. at explicit Apply, Phase 5 first builds a structurally valid candidate and
   then re-verifies the EXACT assertion attached to each branded contribution:
   ECDSA signature, build-time trusted public key, key id, issue/expiry,
   canonical digest, recipe digest, review/session identity, source evidence,
   and target. Only then does it mint a one-shot capability bound to that exact
   line, signature, digest, key, recipe, review, and expiry;
6. the synchronous Phase 5 authorization accepts a branded contribution only
   when it matches that per-Apply capability. There is NO session trust memo and
   NO digest-only authorization. A direct call to the synchronous authorization
   without the capability fails closed for branded evidence;
7. tampering, a replaced signature, a forged local contribution with a matching
   public digest, key rotation, a replayed recipe-A assertion under recipe B
   (even with identical ingredient text and line reference), modified
   quantities/units, expired server evidence, or an invalidated trust context
   fails closed before any recipe or Vault mutation.

The signing private key is server-only (`USDA_BRANDED_SIGNING_PRIVATE_KEY`). It
is never delivered to the browser. The browser contains only the public
build-time anchor. There is no ephemeral-key fallback and no runtime key
registration. Rotation is explicit: generate a new P-256 key pair, update the
server private key and both client anchor values, and rebuild the client. Old
assertions fail closed after a key change.

A browser-created registry entry or capability cannot be constructed by callers;
the capability data lives in a module-private WeakMap and the exported class has
no public factory or mutable authorization method. Browser state cannot promote
nutrition to authenticated `usda_branded` provenance.

No client-supplied nutrient value is trusted at this boundary. The server never
calls USDA during verification; it uses the source snapshot it already held.
The server-held evidence is bounded and expires after one hour, so a very old
review requires a fresh search. Generic USDA and non-branded recipes remain
fully local/offline through Apply.

The existing v5 `ai_contributions` persistence block carries this evidence. It is
distinct from generic USDA composition evidence, externally researched evidence,
and AI estimates. USDA Branded records are never injected into the pinned generic
catalog and never overwrite generic records.

## Entitlement and Basic Nutrition

The route is server-gated by endpoint authentication and the existing
server-owned Advanced Nutrition product authority. Basic callers receive a
bounded `403 NUTRITION_ADVANCED_NOT_ENTITLED` before any upstream request.
Basic Nutrition remains free, offline, deterministic, read-only for nutrition
editing, and AI-free. No branded API call is reachable from Basic Nutrition or
Generate Nutrition.

## Caching

Process-local, bounded, TTL-based caches store only validated source snapshots:

- search results: 10 minutes, max 32 queries;
- verified details: 60 minutes, max 128 FDC ids.

The response tells the UI whether the result was newly retrieved or came from the
cache. An accepted contribution carries its snapshot digest, so a later cache
change cannot silently alter the persisted evidence.

## Known limitations

- No live USDA verification was performed because no `USDA_FDC_API_KEY` was
  configured in this worktree. All regression evidence is deterministic and
  mocked/synthetic, clearly labeled as such.
- Branded lookups resolve a representative product, not an exact brand match
  unless the authored ingredient names the brand.
- Gochujang and rice vinegar remain unresolved in the pinned **generic** catalog;
  the branded lookup is an explicit optional path, not an automatic completion.
- Server-held branded source evidence expires after one hour (and on server
  restart), so an old review must search again before Apply.
- Reopening a saved block trusts the persisted server-verification provenance
  written by the prior explicit Apply; arbitrary external tampering with the
  Markdown file is outside the Apply trust boundary. Read-only reopen does not
  require the session memo, but it still recomputes the canonical digest and
  checks the persisted recipe binding.
- Browser signature verification requires `crypto.subtle` (a secure context:
  HTTPS or localhost). If unavailable, branded Apply fails closed rather than
  accepting unauthenticated evidence.
- Without `USDA_BRANDED_SIGNING_PRIVATE_KEY`, branded lookup/verification
  reports `not configured` and branded Apply fails closed. Without the matching
  build-time `VITE_USDA_BRANDED_SIGNING_PUBLIC_KEY` / key id, the browser also
  fails closed. There is no ephemeral or first-caller key fallback.
- Signing-key rotation requires updating the server private key and rebuilding
  the client with the new public anchor. Old assertions fail closed.
- The existing native-addon limitation is separate from SINC-2.
