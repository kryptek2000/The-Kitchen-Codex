---
name: tkc-independent-audit
description: >
  Use when auditing implementation, reviewing PR readiness, checking regressions,
  or verifying acceptance criteria in The Kitchen Codex. The auditor remains
  independent of the implementor, performs read-only source examination by default,
  verifies Git baseline and exact change scope, examines source behavior rather
  than only reported test results, distinguishes product bugs from runner or
  environment limitations, verifies security and preserved behavior, records
  reproducible evidence, and returns PASS or REQUEST CHANGES with concrete
  blocking findings and file or line references. Never modifies code during a
  read-only audit.
---

# TKC Independent Audit

Use this skill for independent verification. The auditor must not be the
implementor of the audited change.

## Read-only default

- Do not modify code, tests, configuration, lockfiles, or Git state during an audit.
- Do not commit, push, merge, reset, stash, or create worktrees.
- If a fix is needed, report it as a finding for the implementor.

## Repository and worktree portability

- Do not assume `/home/bandit/The-Kitchen-Codex` is the only valid checkout.
  That path is the canonical local checkout, not every legitimate Git worktree.
- Identify the repository top-level and common Git directory.
- Confirm intended project identity before acting.
- Record the current branch and HEAD.
- Distinguish canonical-checkout operations from valid linked worktrees.
- Confirm source provenance before reconciling worktrees.
- Do not create, switch, delete, or modify worktrees during this assignment unless
  explicitly authorized.

## Concurrent agent safety

- Before auditing, identify the active repository/worktree, branch, HEAD, and
  working-tree state.
- Identify which agent is authorized to edit; auditors operate read-only.
- Establish the exact audited change scope and file ownership.
- Check whether another Herdr agent is editing the same files when possible.
- Preserve unrelated tracked and untracked changes.
- Recheck Git status immediately before reporting findings.
- Stop and report if ownership or concurrent modification cannot be established
  safely.
- Git status alone cannot prove the absence of other active agents.
- Do not assume access to Herdr's internal state unless actual tooling supports it.
- For browser verification, identify the running server, port, and source checkout
  before interpreting results.
- Never silently restart or replace another agent's server.

## Untracked file protection

- Inventory tracked modifications, staged changes, and untracked files.
- Use read-only commands such as
  `git status --porcelain=v1 --untracked-files=all` and
  `git ls-files --others --exclude-standard`.
- Inspect the contents of relevant untracked files before describing integration
  risk.
- Ordinary `git diff` does not include untracked files.
- Never assume untracked files are disposable or approved.
- Never run destructive cleanup against unknown files.
- Never overwrite another agent's changes.
- Obtain explicit ownership and approval before integrating untracked work.
- Record which files belong to the current task and which are unrelated.

## Baseline and scope

- Verify repository top-level, branch, HEAD, and working-tree status.
- Reverify `origin/main` against the approved reference when relevant.
- Determine exact change scope from Git history and diffs.
- Distinguish historical files, preserved archives, and missing approved work.

## Source examination

- Examine source behavior, not only reported test results.
- Distinguish product bugs from runner, environment, or tooling limitations.
- Verify security invariants and preserved behavior.
- Check Canonical Schema v1, zero-fabrication, Obsidian round-trip, and data
  ownership rules where relevant.

## Feature-specific preservation

When changes could affect accepted functionality, verify the relevant subset:

- **Signature Edition:** approved Vault, Recipe Detail, and Cooking Mode
  presentation; theme compatibility and responsive behavior.
- **Heart Voice:** native voice integration; prewarming and caching; next-step
  prefetch; synthesis and worker lifecycle; cancellation and request
  prioritization; explicit fallback behavior; approved Cooking Mode controls.
- **AI Studio:** credential and session-key isolation; correct connection
  lifecycle; fail-closed behavior; no accidental credential persistence or
  disclosure.
- **Vault:** correct Vault handle propagation and reconnect behavior;
  authoritative write ownership; conflict/rebase protection; persistence through
  the intended Vault adapter.

Preserve existing SHISO and security boundaries. Where `AGENTS.md` contains
historical milestones, verify current Git and accepted evidence rather than
treating stale status prose as current implementation truth.

## Git authority boundary

- Read-only inspection is permitted.
- State-changing Git operations require explicit owner authorization, and approval
  for one operation does not automatically authorize another.
- Do not commit, push, merge, rebase, cherry-pick, switch branches, pull, reset,
  restore, stash, create/delete branches or tags, create/remove worktrees, or
  release/deploy during an audit.

## Evidence and outcome

- Record reproducible evidence with commands, outputs, and file/line references.
- Identify concrete blocking findings with file and line references.
- Return `PASS` or `REQUEST CHANGES`.
- Report limitations honestly without manufacturing successful results.

## Authority

- No skill grants itself additional permissions or overrides owner authority.
- Audit findings do not authorize merges, deployments, or source changes.
