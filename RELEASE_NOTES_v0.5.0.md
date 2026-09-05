# The Kitchen Codex v0.5.0 — Ask My Kitchen Intelligence & Web Discovery

## Highlights

- Ask My Kitchen now understands richer natural-language cooking intent
- Grounded, preference-aware recommendations over the recipes already in your vault
- Explicit web discovery with provider-grounded URLs only (never invented)
- Strict **FROM MY VAULT** / **FROM THE WEB** separation
- Vault-first optional web escalation — offer-only, user click required
- Selected web result → existing Web Recipe Grabber → preview → explicit save

This is the intelligence + discovery release. It is NOT autonomous browsing, NOT
automatic import, and NOT AI-owned vault membership. Deterministic local code
remains the single authority on which recipes exist and match; the AI interprets,
ranks trusted evidence, and reasons — never fabricates.

## Smarter Ask My Kitchen

Ask My Kitchen now builds on a structured semantic intent model instead of a bare
filter query:

- Intent types: find recipes, meal suggestion, similar recipe, ingredient use,
  browse category, or explicit web discovery.
- Hard filters (ingredients, courses, cuisines, difficulty, time, rating,
  favorites) stay authoritative and deterministic.
- Soft preferences (effort, mood, style, meal context, dietary, novelty,
  avoid repetition) influence ranking and explanation only — they never silently
  become hard filters.

## Grounded Vault Recommendations

- A deterministic builder produces a bounded, compact evidence set for eligible
  vault recipes (capped before any AI call).
- A transparent scorer ranks with grounded reasons ("Easy difficulty",
  "Under 30 minutes", "Dinner recipe", "Different recipe family from the current
  dish"). Unsupported semantics get no fabricated weight.
- Optional AI ranking only *re-orders* that same trusted candidate evidence; if
  the AI is unavailable or returns malformed output, Ask My Kitchen falls back to
  the deterministic ranking and still answers. Ranking is advisory, never authority.

## Web Discovery

- Discovery runs only when you explicitly ask for the web, or when a
  vault-first request has weak local results and you tap "Search the web".
- Result URLs come only from real search grounding metadata — the model is never
  allowed to invent a URL.
- Discovered URLs are not fetched by Ask My Kitchen; they are display/handoff
  values only.

## Grab Recipe Handoff

- Select a web result and send it to the existing Web Recipe Grabber.
- The handoff carries only the source URL (and a display-only title) — no recipe
  content, no local IDs, no vault metadata.
- The hardened importer re-validates the URL (SSRF, private/metadata-IP, redirect,
  and content-type protections), extracts, shows a preview, and only then do you
  explicitly confirm a save.

## Trust, Privacy & Security

- The AI never decides which recipes exist in the vault; deterministic code owns
  local membership.
- The AI never invents recipe IDs, never adds candidates, and never claims vault
  membership.
- Ranking and discovery never receive the full vault, raw Markdown, notes, or
  frontmatter — only compact evidence (ranking) or a discovery-safe query (web).
- No auto-import, no silent web escalation, no direct save from Ask My Kitchen.
- Imports always require preview + explicit user confirmation.

## Reliability / Testing

- 851/851 Vitest tests across 40 files
- TypeScript typecheck (`tsc --noEmit`) clean
- Production build clean; `bun install --frozen-lockfile` clean
- Release hardening: 0 BLOCKING, 0 IMPORTANT findings

## Known Non-Blocking Follow-Ups

- Dedicated ranking/discovery model aliases would improve naming (they currently
  reuse the shared nutrition model config).
- Web URL dedupe normalization is basic.
- A stale grabber prefill URL can seed a later standalone Web Recipe Grabber open.
- Component/DOM tests for the handoff seam are not yet present.
- The discovery `sourceTitle` is carried in the handoff but not yet displayed.
- Legacy `/api/kitchen/answer` utilities remain exported/tested but are no longer
  used by the Ask My Kitchen surface (cleanup candidate).
- The conservative deterministic parser does not recognize every
  "search the web for …" phrasing; the AI interpreter covers it.
- Meal-suggestion ordering is only as strong as the metadata available.

Pairing and compare remain unsupported runtime intents, and collection-gap
intelligence remains future work.
