---
name: tkc-visual-acceptance
description: >
  Use when changing UI, reviewing responsive layouts, accepting redesigned
  components, or verifying browser functionality in The Kitchen Codex. Requires
  using the real affected application screen, verifying the correct running source
  and port, testing desktop, tablet, and mobile widths, measuring overflow,
  clipping, contrast, and interactive targets, checking keyboard and accessibility
  behavior, preserving approved Signature Edition styling, and separating
  automated test evidence from owner acceptance.
---

# TKC Visual Acceptance

Use this skill for browser-visible acceptance work. Do not claim acceptance from
unrelated screenshots or from automated tests alone.

## Repository and worktree portability

- Do not assume `/home/bandit/The-Kitchen-Codex` is the only valid checkout.
  That path is the canonical local checkout, not every legitimate Git worktree.
- Identify the repository top-level and common Git directory.
- Confirm intended project identity before interpreting results.
- Record the current branch and HEAD.
- Distinguish canonical-checkout operations from valid linked worktrees.
- Confirm source provenance before reconciling worktrees.
- Do not create, switch, delete, or modify worktrees during this assignment unless
  explicitly authorized.

## Concurrent agent safety

- Before browser verification, identify the running server, port, and source
  checkout.
- Never silently restart or replace another agent's server.
- Preserve unrelated tracked and untracked changes.
- Recheck Git status before and after acceptance work.
- Auditors operate read-only.
- Do not assume access to Herdr's internal state unless actual tooling supports it.

## Preflight

- Confirm repository top-level, branch, HEAD, and working-tree status.
- Verify the correct running source and port before inspecting any screen.
- Confirm application identity/version and which build or dev server is active.
- Use the real affected application screen, not a substitute or stale capture.

## Required checks

- Test appropriate desktop, tablet, and mobile widths.
- Measure overflow, clipping, contrast, and interactive target sizes.
- Check keyboard navigation and accessibility behavior.
- Preserve approved Signature Edition styling and Botanical Precision design
  language.
- Verify responsive behavior for the specific changed component or surface.

## Evidence rules

- Automated test evidence is not owner acceptance.
- Owner acceptance requires the intended environment and affected screen.
- Separate automated results from manual/browser evidence in reports.
- Report limitations, unsupported widths, missing assets, or blocked checks
  honestly.
- Never manufacture successful visual results.

## Safety

- Do not modify application source during a read-only acceptance pass.
- Do not claim visual acceptance from unrelated screenshots.
- Do not weaken security, accessibility, or responsive-layout requirements.
- State-changing Git operations require explicit owner authorization; approval
  for one operation does not automatically authorize another.
