# Release Notes — The Kitchen Codex v0.2.6

**Release Date:** August 31, 2026  
**Tag / Version:** `v0.2.6`  
**License:** MIT

---

## 🌟 Overview

The Kitchen Codex `v0.2.6` is a focused release following `v0.2.5` that fixes a significant nutrition serving-size bug. Previously, changing the serving selector could cause displayed nutrition values to decrease as the requested serving count increased, and nutrition estimation was repeated for each serving count — allowing AI estimation variance to affect the result. This release makes serving arithmetic deterministic and disconnects it from the AI estimate.

---

## 🚀 Key Highlights & Changes

### 1. 🎯 Deterministic Nutrition Serving Math
- **Fixed incorrect nutrition scaling** when changing recipe serving counts.
- **Nutrition is now estimated once** for the recipe's complete ingredient batch.
- **Serving calculations are performed deterministically by the application** (no AI involvement).
- **Increasing servings now correctly increases nutrition values proportionally.**
- **Changing the serving selector no longer triggers another AI nutrition estimation.**
- **Calories, protein, carbohydrates, fat, fiber, and sodium all use the same scaling factor.**
- **Added a persistent nutrition serving denominator**, so saved nutrition data is self-describing and re-scalable.

### 2. 🔄 Backward Compatibility
- Existing recipes with **legacy per-serving nutrition** (without a stored serving denominator) are **preserved**.
- Legacy data is **not re-estimated** and **not rewritten**; it is interpreted under the legacy per-serving contract.
- Recipe nutrition display and **exported recipe cards** use the same deterministic serving calculations.

---

## 🧪 Verification & Test Results

- **Vitest Suite**: 107 / 107 tests passing across 13 test files (`100% green`).
- **New Regression Tests**: 15 nutrition serving-math tests covering proportional scaling, chain scaling, uniform factor, invariance, serving denominator, invalid servings, offline fallback stability, no double-scaling, persistence round-trip, and no re-estimation.
- **TypeScript Typecheck**: `tsc --noEmit` passed with 0 errors.
- **Production Build**: `vite build` + `esbuild` server bundle generated cleanly into `dist/server.cjs`.
- **Production Tests**: 6 / 6 production-serve regression checks passing.
- **Security Verification**: 33 / 33 checks passing.
- **SSRF Rebinding Verification**: 48 / 48 checks passing.
- **Image Content-Type Security**: 38 / 38 checks passing.
- **Vault Lifecycle E2E**: 49 / 49 checks passing.
- **Nutrition Serving Validation**: 23 / 23 checks passing.
- **`bun audit`**: No known vulnerabilities.

---

## 🔧 Technical

The nutrition contract is now:

```
Recipe ingredients (as written)
  → Total recipe nutrition
  → Total ÷ original servings = per-serving nutrition
  → Per-serving nutrition × requested servings
```

This makes serving changes deterministic and prevents the same recipe from being reinterpreted by the AI simply because the user changes the serving selector.

---

## 📦 Release

`v0.2.6` is a focused release following `v0.2.5`, based on commit `32c47114963092b47127e79bac614ba19fcd2d84`. The previous `v0.2.5` release tag remains unchanged.
