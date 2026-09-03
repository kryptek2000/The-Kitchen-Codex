# The Kitchen Codex v0.3.1 — Serving-Calorie Display Fix

## Fix

The Recipe Detail Quick Metrics bar now updates calories when the selected serving count changes.

Previously, the Servings value updated but the Calories value could continue displaying the stored/base value.

The header now uses the same deterministic serving-scaling path as the Nutrition Card.

## Behavior

- No nutrition re-estimation when servings change
- No Gemini request
- No server request
- No Markdown write
- No stored nutrition mutation
- Existing nutrition serving denominator semantics preserved

## Verification

- 424/424 tests across 27 files
- TypeScript clean
- Production build clean
- GitHub Actions green

## Scope

This is a focused patch release with no new product features.
