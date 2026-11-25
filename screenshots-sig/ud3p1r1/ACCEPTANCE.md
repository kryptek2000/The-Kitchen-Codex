# UD-3P.1R-F1 — Final Recipe Detail contrast repair (appendix)

## F1 Preflight

- Worktree preserved; no reset/rebase/overwrite.
- Baseline remained `cd05036767d5941a31ec5a0c2d6f9c4715b37ee1`.
- Approved Signature Vault changes preserved.

## F1 Root cause

`RecipeDetailView.tsx` placed the recipe title and rating text over a dark photographic gradient using `text-white`. In Warm Parchment, `[data-theme="parchment"] .text-white` applies `#1C1917 !important`, producing dark text on the dark gradient. GLM reproduced the computed style.

The secondary low-contrast callout body was `text-amber-200`, remapped in Parchment to terracotta on a light terracotta surface; measured ratio ~1.02.

## F1 Changed files

- `src/components/RecipeDetailView.tsx` — hero title and rating use `kc-photo-overlay-text`; callout title and body use `text-[var(--text-primary,#F3F4F6)]`.
- `src/index.css` — added `html[data-theme] .kc-photo-overlay-text { color: #FFFFFF !important; }`, scoped to the overlay class and more specific than the Parchment remap.
- `tests/unit/signatureThemeScope.test.ts` — regression coverage for the overlay rule and callout semantic foreground.

## F1 Repair

- Photographic overlay text is now explicitly white in every approved theme, independent of page foreground remaps.
- The rule uses higher specificity than `[data-theme="parchment"] .text-white` and is scoped to `.kc-photo-overlay-text`, so ordinary page content is unaffected.
- Approved photography, gradient, typography, responsiveness, accessibility, and actions are unchanged.
- Callout body/title now use the semantic `--text-primary` role. Measured Parchment callout body/title ratio improved to **13.72:1**.

## F1 Computed styles before/after

Before (Parchment):
- hero title: `#1C1917` on a dark gradient, ratio ~1.10
- rating: `#1C1917`
- callout title/body: terracotta on light terracotta, ratio ~1.02

After (Parchment):
- hero title: `#FFFFFF`, sampled adjacent gradient luminance ratios 19.33–20.22
- rating: `#FFFFFF`
- callout title/body: `#1C1917` on `rgba(194,65,12,0.1)` over `#F6F3EB`, ratio 13.72

The same white overlay text remains correct in Obsidian, Nordic Sage, and Blood Moon because the hero gradient is unchanged.

## F1 Four-theme verification

- Desktop 1440 and mobile 390 Recipe Detail captures:
  - `after/detail-obsidian-1440.png`, `after/detail-obsidian-390.png`
  - `after/detail-parchment-1440.png`, `after/detail-parchment-390.png`
  - `after/detail-nordic-1440.png`, `after/detail-nordic-390.png`
  - `after/detail-blood-moon-1440.png`, `after/detail-blood-moon-390.png`
- Sampled actual gradient pixels behind/beside the title; all measured ratios are ≥18.42:1.
- Callout body/title ratio: 13.72:1 in Parchment; dark themes retain light text on dark callout surfaces.
- No horizontal overflow; responsive layout unchanged.

## F1 Regression coverage

- `signatureThemeScope.test.ts` now asserts:
  - `html[data-theme] .kc-photo-overlay-text { color: #FFFFFF !important; }`
  - RecipeDetailView uses `kc-photo-overlay-text` on the hero title and rating
  - callout title and body use `text-[var(--text-primary,#F3F4F6)]`

## F1 Test, typecheck, build results

- Relevant focused tests: **105/105 passed**.
- Typecheck: passed.
- Production build: passed.
- `git diff --check`: passed.
- Production smoke: HTTP 200, health OK, self-hosted font 200 `font/woff2`, no console errors.

## F1 Remaining risks

- Mixed-luminance photographs are handled by the existing dark bottom gradient; the title sits in the bottom 64px of the 384px hero, where sampled gradient luminance remains very low. Extremely bright bottom-edge photographs could still need a stronger scrim in a future pass, but no current starter photograph exposes that.
- Cooking Mode finished-state contrast remains explicitly deferred to UD-3P.2.
- Advanced Nutrition Apply and Phase 5B browser-proof maintenance remain separate obligations.
- The low-priority "sample recipes" wording, first-paint dark flash, and text-only resize limitations remain documented backlog items and were not changed here.
