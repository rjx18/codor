# Six-Lane Combined Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Combine the six independently accepted reliability/collaboration lanes into one traceable, verified integration branch without duplicating dependency lanes or publishing any result.

**Architecture:** Start from the shared coordination commit `2d5cbbc`, merge the accepted aggregate lane heads in dependency-aware order, and preserve each lane head as an exact second parent. Lane E already contains A; Lane C contains a patch-identical Q1 commit from B, so A and B are verified rather than merged again. Resolve only the four forecast C/F conflicts additively, then use one clean-locked Harn reconciliation plan to add cross-lane regression coverage for the shared protocol, connector, store, and browser-wire seams.

**Tech Stack:** Git no-ff merges, Harn plans/assumptions, TypeScript, Vitest, Playwright, pnpm workspaces.

---

## Accepted inputs

- Shared base: `2d5cbbcbd4c40196eb774df252b652ce02c26c74`
- Lane A: `3164948cd83bb31e3c20fd2ecc8920e060abb41d` (already an ancestor of E)
- Lane B: `ade86564c3cb7774b6dd1e421f56c4e7d6e7bb34` (patch-identical Q1 is in C as `52cc30c`)
- Lane C: `03e5cf3773c2f0954ac7c4095447add2095aaf55`
- Lane D: `42ecb90461332fd38e0883ed29f798dea37599c7`
- Lane E: `0e01e5582aa859a2ee4a94064a212ada4a87aeda`
- Lane F: `a857d4f03ef001c7dfb4314e2f06e8a5ea2df55f`

## Explicit boundaries

- Do not merge A separately because E contains its exact ancestry.
- Do not merge B separately because C carries a stable-patch-id-equivalent Q1 commit.
- Do not rebase, squash, cherry-pick, or rewrite accepted lane histories.
- Do not push, merge to `main`, deploy, publish, release, or update a real host.
- Do not redesign scheduled delivery, context reset, transcript ordering, prose semantics, or collaboration briefing while resolving overlaps.

### Task 1: Record provenance and clean baseline

**Files:**
- Create: `docs/superpowers/plans/2026-08-13-six-lane-combined-integration.md`

- [ ] Verify the integration worktree starts clean at the shared base.
- [ ] Verify A is an ancestor of E.
- [ ] Verify B and C's `52cc30c` have the same stable patch ID.
- [ ] Build the shared base, then run the serialized workspace tests.
- [ ] Commit this integration plan as a plan-only checkpoint.

### Task 2: Merge the independent accepted aggregates traceably

**Files:**
- Merge all accepted files already owned by Lane E, then C, then D.

- [ ] Merge Lane E with `--no-ff`; verify its exact second parent and A ancestry.
- [ ] Merge Lane C with `--no-ff`; verify its exact second parent and B patch equivalence.
- [ ] Merge Lane D with `--no-ff`; verify its exact second parent.
- [ ] Confirm every imported Harn plan is applied, none is locked, and the tree is clean.

### Task 3: Merge Lane F and preserve both sides of four genuine overlaps

**Files:**
- Reconcile: `packages/protocol/src/ws.ts`
- Reconcile: `packages/web-next/src/app/connector.ts`
- Reconcile: `packages/web-next/src/app/store.ts`
- Reconcile: `packages/web-next/src/runtime/ws.ts`

- [ ] Begin a no-ff Lane F merge and confirm only the four forecast files conflict.
- [ ] In protocol/browser wire schemas, preserve both scheduled-message frames and correlated context-reset frames.
- [ ] In the connector, preserve scheduled-state reconciliation and context-reset request/result correlation without changing generation or warm-resync behavior.
- [ ] In the store, preserve both scheduled-card state and member-local context-reset progress/settlement.
- [ ] Complete the merge with Lane F as the exact second parent and audit every auto-merged overlap listed by the dry-run forecast.

### Task 4: Clean-lock post-merge Harn reconciliation

**Files:**
- Create: `.harn/plans/six-lane-combined-integration-reconciliation.yaml`
- Create via Harn apply: `.harn/assumptions/combined-scheduling-reset-transcript-briefing-contracts-coexist.yaml`
- Modify only tests needed to cover actual cross-lane seams.

- [ ] From the clean merge commit, inspect every assumption anchored in the four conflict files and the auto-merged overlap files.
- [ ] Draft a narrow Harn plan that reviews imported assumptions unchanged and creates one integration-level coexistence assumption.
- [ ] Add focused regressions proving scheduled frames and correlated reset frames coexist on the protocol/browser wire.
- [ ] Add focused connector/store regressions proving schedule reconciliation cannot settle/reset member-local progress and reset results cannot duplicate/remove scheduled cards.
- [ ] Add one browser journey covering a pending schedule while a member context reset completes, followed by transcript refresh with explicit prose/interjection order intact.
- [ ] Run `harn plan check`, clean-lock with `dirty_at_lock: false`, implement tests only unless a regression exposes a genuine integration defect, then apply and commit once.

### Task 5: Combined verification

**Files:**
- No planned product changes; verification only.

- [ ] Run recursive workspace build.
- [ ] Run serialized workspace tests.
- [ ] Run complete isolated Playwright.
- [ ] Run focused cross-feature journeys for scheduling, composer acknowledgement, prose ordering, compaction briefing, and context reset.
- [ ] Run release/license audits and packed/fresh install proofs.
- [ ] Run Harn provenance, exact-parent assertions, active-assumption validation, and `git diff --check`.
- [ ] Leave the integration worktree and branch clean and unpublished for Richard's decision.
