# Release Notes — The Kitchen Codex v0.2.5

**Release Date:** August 30, 2026  
**Tag / Version:** `v0.2.5`  
**License:** MIT

---

## 🌟 Overview

The Kitchen Codex `v0.2.5` is a focused reliability release following `v0.2.4`, primarily improving Gemini response latency and eliminating nutrition/macro timeout failures (`504 DEADLINE_EXCEEDED`), while hardening the Gemini client lifecycle and CI lockfile integrity.

---

## 🚀 Key Highlights & Changes

### 1. 🧠 AI & Nutrition Reliability
- **Fixed Gemini `504 DEADLINE_EXCEEDED` timeouts** affecting nutrition and macro calculations.
- **Reduced Gemini thinking to `MINIMAL`** for fast, deterministic structured JSON extraction across nutrition estimation, metadata recovery, and recipe grabbing.
- **Increased the Gemini request timeout** from 15 seconds to 25 seconds in `server/modelConfig.ts`.
- **Dynamic Gemini client refresh** when `GEMINI_API_KEY` changes, so the AI pipeline stays in sync with key rotation.
- **Preserved the multi-tier Gemini fallback architecture**:
  - `gemini-3.7-flash` (primary)
  - `gemini-3.1-flash-lite` (fallback)
  - offline algorithmic fallback

---

### 2. 🛡️ Security & Reliability
- Preserved **SSRF DNS-pinning** and private/loopback/metadata blocking.
- Preserved **AI endpoint authentication** (optional shared bearer token).
- Preserved **security headers** and **rate limiting**.
- Preserved **zero-fabrication** recipe import behavior.
- Preserved **canonical Recipe Schema v1** and Obsidian data fidelity.

---

### 3. 🔧 CI & Build Reliability
- Added **Bun lockfile consistency verification** to `.github/workflows/build.yml`.
- **Synchronized `bun.lock`** with the actual dependency tree.
- Updated the project toolchain and dependency configuration.
- CI continues to verify typecheck, tests, build, security verification, and production checks.

---

## 🧪 Verification & Test Results

- **Vitest Suite**: 92 / 92 tests passing across 12 test files (`100% green`).
- **TypeScript Typecheck**: `tsc --noEmit` passed with 0 errors.
- **Production Build**: `vite build` + `esbuild` server bundle generated cleanly into `dist/server.cjs`.
- **Production Tests**: 6 / 6 production-serve regression checks passing.
- **Security Verification**: 33 / 33 checks passing.
- **SSRF Rebinding Verification**: 48 / 48 checks passing.
- **Image Content-Type Security**: 38 / 38 checks passing.
- **Vault Lifecycle E2E**: 49 / 49 checks passing.
- **Nutrition / Servings Audit**: passing.
- **`bun audit`**: No known vulnerabilities.

---

## 📦 Release

This release is a focused reliability release following `v0.2.4`, primarily improving Gemini response latency and eliminating nutrition/macro timeout failures.
