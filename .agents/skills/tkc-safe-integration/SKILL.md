---
name: tkc-safe-integration
description: >
  Use when integrating accepted development, preparing PRs, reconciling worktrees,
  updating canonical main, or reviewing potential regressions in The Kitchen Codex.
  Requires verifying Git identity and working-tree state, confirming the latest
  approved source, inspecting exact diffs, preserving functionality and security
  boundaries, and respecting commit, push, merge, and deployment authority.
---

# TKC Safe Integration

Apply this skill before integrating or publishing any Kitchen Codex change.

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

Before writing or integrating:

1. Identify the active repository/worktree, branch, HEAD, and working-tree state.
2. Identify which agent is authorized to edit.
3. Establish task-specific file ownership.
4. Check whether another Herdr agent is editing the same files.
5. Preserve unrelated tracked and untracked changes.
6. Recheck Git status immediately before editing and before integration.
7. Stop and report if ownership or concurrent modification cannot be established safely.

- Git status alone cannot prove the absence of other active agents.
- Only one agent may modify overlapping files at a time.
- Auditors operate read-only.
- Do not assume access to Herdr's internal state unless actual tooling supports it.
- For browser verification, identify the running server, port, and source checkout
  before interpreting results.
- Never silently restart or replace another agent's server.

## Untracked file protection

- Inventory tracked modifications, staged changes, and untracked files.
- Use read-only commands such as
  `git status --porcelain=v1 --untracked-files=all` and
  `git ls-files --others --exclude-standard`.
- Inspect the contents of relevant untracked files before recommending integration.
- Ordinary `git diff` does not include untracked files.
- Never assume untracked files are disposable or approved.
- Never run destructive cleanup against unknown files.
- Never overwrite another agent's changes.
- Obtain explicit ownership and approval before integrating untracked work.
- Record which files belong to the current task and which are unrelated.

## Required preflight

- Confirm repository top-level, branch, HEAD, and working-tree status.
- Verify Git identity and that no unrelated or concurrent modifications are at risk.
- Reverify `origin/main` against the approved reference before integration.
- Confirm the intended source is the latest approved implementation, not a stale or
  historical variant.

## Diff discipline

- Inspect exact diffs before integration.
- Distinguish historical files, preserved archives, and missing approved work.
- Never substitute an older implementation for an approved one.
- Never silently reset, discard, stash, or overwrite work.
- Stop and report if concurrent source modifications make integration unsafe.

## Feature-specific preservation

When changes could affect accepted functionality, verify the relevant subset rather
than demanding irrelevant full-system testing for every small edit:

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

Owner authorization is required before state-changing Git operations, including:

- commit and push;
- merge, rebase, and cherry-pick;
- branch switching or checkout operations that change working-tree state;
- pull, reset, restore, and stash modifications;
- branch or tag creation/deletion;
- worktree creation/removal;
- release and deployment.

Read-only inspection remains permitted. Approval for one operation does not
automatically authorize another.

## Preservation requirements

- Preserve existing functionality and all security boundaries.
- Do not weaken SSRF guards, AI key containment, endpoint auth, WAF handling,
  zero-fabrication behavior, Canonical Schema v1, or rate limiting.
- Preserve Obsidian canonical-source-of-truth behavior and Markdown round-trip
  semantics.
- Keep `AGENTS.md` as the project guide; skills supplement it rather than
  override it.

## Application identity checks

- Verify relevant CI/typecheck/test status for changed areas.
- Verify running application identity and port when browser or integration checks
  are required.
- Report limitations and blockers with concrete file/line references instead of
  manufacturing success.
