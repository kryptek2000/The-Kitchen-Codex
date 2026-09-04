# The Kitchen Codex v0.4.0 — Ask My Kitchen

## Highlights

- Ask My Kitchen — natural-language kitchen questions answered from the recipes already in your Obsidian vault
- Grounded Vault Search — deterministic, vault-only retrieval
- Natural-Language Query Interpretation — question → structured `KitchenQuery`
- Trusted Similar-Recipe Context — "what is similar to this?" from a recipe detail
- Privacy-First Evidence Flow — only compact retrieved evidence leaves the client

## What shipped

Ask My Kitchen makes your own recipe vault directly answerable.

### Deterministic local retrieval

A question is interpreted into a structured `KitchenQuery`, then a deterministic engine (`searchKitchenRecipes`) decides exactly which recipes match. The model never chooses recipes, never widens filters, and never invents results.

### Grounded conversational answers

A compact evidence set (retrieved recipes + deterministic Step 1 reasons) feeds a grounded answer layer that explains the results without inventing recipes, metadata, times, or ratings.

### Natural-language interpretation

A thin interpretation boundary maps questions like "What can I make with chicken and rice?", "Which recipes use black beans?", and "what desserts take under 30 minutes?" into structured query constraints, with a conservative deterministic fallback when AI is unavailable.

### Privacy-first evidence flow

Only the compact retrieved evidence for matching recipes is sent to the server. The full vault, raw Markdown, notes, frontmatter, and unrelated recipes never leave the client. No full-vault data is transmitted. Interpretation sends only the question, and answering sends only the compact retrieved evidence for matching recipes.

### Trusted similar-recipe context

Opened from a Recipe Detail, Ask My Kitchen can answer "what is similar to this?" using the trusted current recipe identity — no model-invented identity is ever used.

## Behavior

- Vault-only: Ask My Kitchen never searches the web or discovers external recipes
- Read-only: no recipe edits, Markdown writes, or mutations of any kind
- No recipe fabrication: retrieved membership is authoritative
- Deterministic fallback and grounded no-match behavior when nothing matches
- AI does not own the final visible answer prose (deterministic, evidence-backed in v0.4.0)

## Verification

- 593/593 tests across 33 files
- TypeScript clean
- Production build clean
- GitHub Actions green on commit d0799b5

## Scope

A focused, privacy-preserving feature release. No breaking vault-format changes; security, SSRF, rate-limiting, and header invariants preserved. Web recipe discovery (Find New Recipes) remains a separate, future capability and is intentionally not part of Ask My Kitchen.
