# The Kitchen Codex v0.4.1 — Ask My Kitchen Reliability & Culinary Relevance

## Highlights

- Ask My Kitchen interpretation reliability — fewer conversational false positives, honest failure signalling
- Culinary Similar Recipes — dish-family-first relevance instead of raw ingredient-overlap ranking
- Safe failure semantics — ambiguous questions fail safely instead of silently broadening
- Distinct 422 vs 503 — question-understanding failures are separated from AI service failures
- One deterministic similarity authority shared by Similar Recipes and Ask My Kitchen

This is a focused hardening release on top of v0.4.0's Ask My Kitchen. It is NOT
the v0.5.0 intelligence/discovery release: Ask My Kitchen remains vault-only,
read-only, and grounded — no web discovery, no online recipe search, and no new
import behavior in this version.

## Ask My Kitchen Reliability

The deterministic fallback interpreter is now far more conservative about what
counts as an ingredient request:

- Possession leads ("I have chicken and rice") and use/contain leads ("recipes
  using eggs", "what recipes contain garlic?") keep working exactly as before.
- Reference phrases ("recipes like this", "anything similar") never become
  bogus ingredient filters.
- Generic non-food nouns ("I have time for dinner", "I have an idea for
  dinner") and meta-object nouns ("contains instructions/notes/steps/photos")
  are no longer mistaken for ingredients.
- Dangling conjunctions are stripped ("contains tomatoes and takes 30 minutes"
  → tomatoes + 30 minutes, never "tomatoes and").
- Compound intent is preserved: "What chicken recipes can I make in under 30
  minutes?" keeps BOTH the chicken ingredient filter and the 30-minute bound;
  "beef recipes under 1 hour" now correctly parses hours (60 minutes), and
  "half an hour" parses as 30 minutes.
- Unsupported dish-family subjects ("salad recipes under 30 minutes", "soup
  recipes under 30 minutes") fail safely instead of silently degrading to a
  time-only query that would match every recipe in the vault.

## Culinary Similarity Improvements

The Similar Recipes panel and Ask My Kitchen's "similar to this" retrieval are
now powered by a single deterministic culinary-relevance authority:

- Dish family first: salads recommend salads; tacos favor tacos, burritos,
  enchiladas, quesadillas, and fajitas.
- Known-family mismatch gate: a known salad never recommends a known pasta
  merely because both share chicken, parmesan, cuisine, or course.
- Related dish families (Tex-Mex, soup/stew/chili, bread/pizza,
  burger/sandwich, cake/cookie/pie/dessert) still recommend one another.
- Ingredient overlap is now a bonus signal, capped well below any genuine
  culinary relationship, and generic pantry ingredients (garlic powder, olive
  oil, kosher salt, …) plus generic tags (easy, quick, dinner, …) can never
  establish similarity on their own.
- Results are explained with human-readable culinary reasons ("Same type ·
  Taco") instead of raw overlap numbers.

## Safety & Trust

- Read-only: no recipe edits, Markdown writes, or mutations of any kind.
- Vault-only: no web search, no external recipe discovery in this release.
- No recipe fabrication: deterministic retrieval remains the sole authority on
  recipe membership; the model never chooses recipes or widens filters.
- Trusted similar-recipe context: the model can never inject a
  `similarToRecipeId` — it is seeded only from the trusted current-recipe
  identity.
- Interpretation requests send only the question text; answering sends only
  compact retrieved evidence. The full vault, raw Markdown, notes, and
  frontmatter never leave the client.
- Fixed, user-appropriate error messages; no raw provider/server error bodies,
  model IDs, or key/config details are ever surfaced.
- Security invariants unchanged: SSRF guard, AI key containment, endpoint
  auth, rate limiting, security headers.

## Verification

- 675/675 Vitest tests across 34 files
- TypeScript typecheck (`tsc --noEmit`) clean
- Production build clean
- Deterministic fallback-only mode verified with no Gemini key configured

## What's Next

The next major objective is **v0.5.0 — Ask My Kitchen Intelligence +
Discovery**: a richer AI-driven intent model, recommendations that go beyond
filters, and clearly-labeled, explicit web discovery with a trusted Grab
Recipe handoff. That work is designed, not shipped — this release contains
none of it.
