# Parallel Reliability and Collaboration Program

## Purpose

This program addresses six independently deliverable areas from the accepted
`main` baseline. All six worktrees are created up front and may run at the same
time. There is no wave-wide completion barrier: each worktree's local
orchestrator reviews its own phase and immediately starts its next phase when
that phase's listed dependency is available.

This document is the shared program contract, not an implementation Harn plan.
Each implementation or review-fix commit receives its own narrowly scoped,
clean-locked Harn plan in the relevant worktree.

## Accepted baseline and worktrees

All worktrees start from the plan-only commit immediately above accepted base
`a2be0b6722b4d08dac5ac3550fee9362a3de3ba4`.

| Lane | Worktree | Branch | Local phases |
| --- | --- | --- | --- |
| A | `/home/richard/git/codor-hosted-transcript-reliability` | `fix/hosted-transcript-reliability` | H1 -> H2 |
| B | `/home/richard/git/codor-composer-send-acknowledgement` | `fix/composer-send-acknowledgement` | Q1 |
| C | `/home/richard/git/codor-scheduled-messages-v2` | `feat/scheduled-messages-v2` | S1 -> S2 |
| D | `/home/richard/git/codor-collaboration-briefing` | `fix/collaboration-briefing` | D1 |
| E | `/home/richard/git/codor-prose-event-semantics` | `fix/prose-event-semantics` | P1 -> P2 |
| F | `/home/richard/git/codor-context-reset-v2` | `fix/context-reset-v2` | C1 -> C2 |

The older unregistered worktrees and branches are not reused, reset, deleted,
or overwritten. They remain user-owned historical work.

## Parallel execution graph

The six first phases start independently:

```text
A: H1 -> H2 --------------------------> complete
B: Q1 --------------------------------> complete
C: S1 ---- wait only for accepted Q1 -> S2 -> complete
D: D1 --------------------------------> complete
E: P1 ---- wait only for accepted H2 -> P2 -> complete
F: C1 -> C2 --------------------------> complete
```

There is no requirement for A-F to finish together. H1 may advance to H2 while
S1, D1, P1, and C1 are still running. C1 may advance to C2 immediately after
its local review. The only cross-worktree dependencies are:

- S2 integrates the accepted Q1 composer acknowledgement contract before its
  Harn plan is locked.
- P2 integrates the accepted H2 transcript reconciliation contract before its
  Harn plan is locked.

The local orchestrator pauses only that dependent phase. The main integration
reviewer supplies the exact accepted dependency commit; the worktree rebases or
cherry-picks it, verifies a clean base, and only then creates the next Harn plan.
No other worktree waits.

## Required channel workflow in every worktree

Each child worktree contains two channel members:

- `@orchestrator`, model `gpt-5.6-sol`, full-access: plans, reviews, and
  orchestrates; it does not implement.
- `@sol`, model `gpt-5.6-sol`, full-access: implements the currently assigned
  phase; it does not orchestrate or delegate internally.

Communication is only through channel tagging:

1. The local orchestrator reads this entire program and inspects its worktree.
2. It writes one phase-specific Harn plan, resolves all real assumptions and
   anchors, and clean-locks it with `dirty_at_lock: false`.
3. It tags the local `@sol` once with the exact phase, locked plan, base, tests,
   exclusions, and stopping condition.
4. Sol first adds the specified reproduction/regression and observes it fail for
   the expected reason. It then implements the smallest fix, verifies it, runs
   Harn apply/staged checks, makes one implementation commit, tags the local
   orchestrator once, and stops.
5. Neither participant polls, monitors, repeatedly status-checks, or reminds an
   active participant. After tagging, it waits for the tagged participant to
   return.
6. `codor post` is used only for a necessary nonterminal update while continuing
   work or when posting outside the normal response path. A completion/blocker
   is a single tagged final handoff. `codor post --wait` is only for one genuinely
   blocking direct answer, never for monitoring.
7. The orchestrator independently reviews the code, regression quality, Harn
   truth, focused tests, and clean tree. A correction receives a new contained
   review-fix Harn plan and commit. Once the complete worktree is accepted, the
   orchestrator tags the main Investigator once with commits and exact evidence.

No participant pushes, merges to `main`, deploys, publishes, releases, updates a
real host, or begins unassigned work.

## Lane A - hosted transcript reliability

### H1 - selected-room terminal evidence reconciliation

#### Reproduced cause

When a run settles while its room is inactive, switching away clears that
room's mutable `runEvents`. The background subscription receives the terminal
message record but not the complete journal evidence. Returning to a room that
already has its 20-unit hydration budget does not resubscribe, while the live
renderer excludes terminal runs until combined history owns them. The newest
answer can therefore disappear until a watchdog, reconnect, computer switch, or
page reload refreshes history.

#### Contract

- Activating a room performs one deduplicated, destination-owned combined-head
  reconciliation after the correct connector is ready.
- The request remains bound to the actual source computer store and its token
  across every await; switching computers or same-named rooms cannot redirect
  the response.
- Preserve the warm tunnel/app socket, existing room subscriptions, cached
  readability, direct mode, and the no-finalized-`/runs/:id` boundary.
- Do not reload the document, reopen the relay handshake, or clear newer live
  rows while reconciliation is pending or failed.
- A failed refresh stays retryable and does not publish an honestly empty or
  exhausted history state.

#### Red-first acceptance

Start run A, switch to B, finalize A, and switch back. Before the fix the latest
terminal evidence must be absent; after the fix it is immediately present with
no reload, watchdog, new socket, relay handshake, or full journal fetch. Add the
same-room-id/two-computer case and prove only A's captured store changes.

### H2 - authoritative transcript order and stable reconciliation

#### Reproduced cause

The server's permanent message/continuation order is correct. The browser's
head merge keeps current units before the newly authoritative head. If a human
or another agent interjects while a run is active, that interjection may already
exist in immutable history while the running family is excluded. Settlement
then returns the correct `first half -> interjection -> continuation` order, but
the client appends the missing run units after the existing interjection. Older
content can appear above newer content or one run half can jump across the
interjection.

#### Contract

- Treat a successful combined-head response as authoritative for the returned
  overlap and adopt its stable-unit order.
- Preserve older pages outside that refreshed overlap, newer live records not
  yet represented by the response, stable anchors, pins, search, permalinks,
  evidence ownership, and exact continuation attribution.
- Deduplicate by stable unit identity, not visible text. Never reorder by local
  receipt time when permanent server order is available.
- Preserve the first pre-existing visible unit's viewport offset through merge,
  including an intra-message boundary and delayed hosted materialization.

#### Red-first acceptance

Reproduce `#1 first-half prose -> #2 human/other-agent interjection -> #3 run
continuation`, then settle and refresh. Assert stable unit-key order `#1, #2,
#3` during live rendering, settlement, head refresh, room switch-back, reload,
and a page boundary, with no gaps or duplicates. The regression must fail on the
accepted baseline for the ordering reason before implementation.

## Lane B - composer send acknowledgement

### Q1 - exact trailing-mention acknowledgement and draft ownership

#### Reproduced cause

The composer submits a canonical trimmed body and correlates the self echo using
that body, but later clears only when the raw textarea value equals the trimmed
body. Mention autocomplete commonly leaves a trailing space. The send succeeds
while the raw input no longer equals the canonical pending body, so the draft
remains visible.

#### Contract

- Capture both the exact raw textarea snapshot and canonical submitted body at
  dispatch.
- Use canonical content plus the authenticated self identity and destination
  room for echo correlation.
- Clear only when the current textarea still equals the exact dispatched raw
  snapshot. Preserve a draft edited after dispatch.
- Keep exact trailing local or qualified mentions sending on the first Enter,
  with one delivery only. An identical message from another author must not
  acknowledge the pending send.
- Refusal/error preserves the draft and exposes the existing actionable error.
  Do not subscribe the composer to unrelated room state.

#### Red-first acceptance

With the literal textarea value `please investigate @sol `, press Enter once,
observe exactly one canonical message, deliver its authenticated self echo, and
assert the textarea clears. Repeat for a qualified trailing mention. Also prove
edit-after-send preservation, other-author non-correlation, whitespace handling,
and refusal/error behavior. Each failing reproduction is recorded before the
fix.

## Lane C - persistent scheduled messages

### S1 - durable exactly-once scheduler

- Recognize scheduling only at the first substantive token, including
  `[send_in=2h30m]@sol` and `[send_at=8:30PM]@sol`, with a documented canonical
  timezone/offset rule and an unambiguous ISO-8601 option.
- Parse, bound, and authorize at creation time. Resolve local and worktree-
  qualified targets to a durable identity snapshot and store the clean body,
  target, absolute due instant, author, and stable schedule id in SQLite.
- Use one next-due alarm/timer backed by durable state. Atomically claim then
  deliver through the ordinary routing boundary; crash/restart may delay but
  must never duplicate. Boot recovery resumes pending/claimed work honestly.
- Support authorized cancellation before claim and explicit failure for a
  removed/unavailable target. Never silently retarget.
- Bound directive/body size, require a future time, and enforce a one-year
  maximum. Recurrence, cron, arbitrary scripts, editing, bulk operations, and
  external queues are out of scope.
- Cover simultaneous due rows, cancellation/claim races, restart at every state,
  target removal, authorization, worktree targeting, and exactly-once delivery.

### S2 - composer/CLI syntax and scheduled cards

Dependency: accepted Q1 is integrated before this phase is planned.

- Browser and `codor post` submit the same canonical request without regressing
  Q1's raw-draft/self-echo acknowledgement behavior.
- Render a compact accessible card with clock, target/worktree, local date/time
  and zone, short preview, and Pending/Sending/Failed/Cancelled state.
- Pending cards expose Cancel only to an authorized author/admin. Reconcile a
  sent schedule into the ordinary delivered message without duplication.
- Cover direct/hosted mode, reconnect/reload, mobile, Axe, offsets, same-instant
  schedules, worktree-qualified targets, and cancellation races.

## Lane D - collaboration briefing

### D1 - correct post-compaction channel workflow

- Inject a concise collaboration briefing on first delivery and through the
  existing flag-gated hook after successful automatic or manual compaction.
- State explicitly: do not delegate channel work to internal subagents; assign a
  channel member by tagging once; plain names do not invoke; after handoff do
  not poll or monitor; the worker tags the orchestrator once on completion or a
  genuine blocker.
- Explain that ordinary final replies post automatically. Use `codor post` only
  for necessary interim output while continuing or from outside the normal
  response path; use `codor post --wait` only for a genuinely blocking answer.
- Do not inject mid-turn, duplicate briefings, alter stored user text, or create
  a second compaction mechanism.
- Cover fresh sessions, automatic and manual compaction, repeated compaction,
  restart, and all first-party adapters' prompt boundaries.

## Lane E - explicit prose event semantics

### P1 - protocol and adapter classification

- Preserve `text_delta` for an incomplete native streaming fragment. Consumers
  concatenate consecutive compatible deltas exactly.
- Add `text_block` for one complete native prose block emitted by a harness that
  does not stream token/chunk deltas. Consecutive blocks retain a paragraph
  boundary instead of being silently concatenated.
- Classify by native event path, never timing heuristics. Audit every first-party
  adapter. An adapter may emit both types on distinct paths.
- Expected streaming paths include ACP message chunks, Copilot message deltas,
  Cursor/Grok delta events, and Antigravity stdout; expected completed-block
  paths include Codex agent messages, completed Claude assistant text blocks,
  completed Gemini assistant messages, and Copilot's non-stream fallback. The
  implementer must verify and document the actual OpenCode/native seams.
- Keep old stored `text_delta` journals valid without migration. Update protocol
  schemas/types, adapter contracts, normalization, and focused conformance tests.
- Preserve tool/reasoning/status semantics and final-text deduplication.

### P2 - live and historical presentation parity

Dependency: accepted H2 is integrated before this phase is planned.

- Thread `text_block` through continuation projection, live presentation,
  server history unitization/pagination, combined-head reconciliation, and the
  historical renderer.
- `text_delta` remains fragment concatenation. `text_block` supplies an explicit
  visible paragraph boundary. Neither time gaps nor output-row boundaries invent
  prose breaks.
- Preserve stable unit IDs/anchors, H2 ordering, the 20-visible-unit history
  budget, continuation interleaving, final fallback deduplication, search, pins,
  permalinks, and no cold full-journal requests.
- Red-first tests compare the same transcript live, settled, paged, switched,
  and reloaded for both native paths and for mixed text/tool evidence.

## Lane F - reliable non-blocking context reset

### C1 - bounded, correlated reset backend

- Keep owner/admin, owned-custody, idle/no-active-turn, no-compaction, and
  single-reset-lease checks.
- Correlate every request/result/error with an explicit ref. Unrelated room
  errors or member updates cannot settle the request.
- Fully retire Claude, Codex, ACP, and every first-party retained runtime using
  honest adapter hooks. Bound graceful retirement and escalate only for an
  owned child. Confirm the old runtime can no longer write before clearing
  durable session/context/task/runtime metadata.
- Preserve identity, configuration, transcript, limits, usage/spend, and queued
  future delivery. Clicking Clear creates no native session and no paid turn;
  the next delivery creates the fresh session.
- Block attach/turn/compaction races while leased. Delayed usage peeks, old-model
  turns, or stale exits cannot restore invalidated data. Failure preserves the
  old valid reference and releases the lease without false success.
- Cover timeout, disconnect, restart, repeated/concurrent clear, mirrored
  custody refusal, attach race, stale usage, and adapter teardown order.

### C2 - anchored confirmation and member-local progress

- Replace blocking room-level UI with a small anchored confirmation below Clear.
  Confirm dispatches once, closes immediately, and changes only that member's
  control to a compact spinner; the rest of the room and composer stay usable.
- Settle only from the matching C1 ref. On success hide the session-dependent
  control until a new native session exists. On failure show a small local
  retry/error affordance.
- Preserve keyboard focus, Escape/outside cancellation before dispatch, mobile
  bounds, direct/hosted behavior, and Axe.

## Per-phase verification standard

Every phase records the exact failing reproduction first, focused tests after
the fix, all affected package tests and builds, Harn check/apply/staged results,
`git diff --check`, the implementation commit, and clean worktree status.
Browser-affecting phases run the relevant direct and hosted Playwright journeys,
including multi-computer/store isolation where applicable. Protocol or adapter
phases run complete protocol/switchboard suites. CLI phases run packed installed
CLI coverage where their public path changes.

The final integration review runs one expensive combined gate after all accepted
worktrees are merged: recursive build, serialized workspace tests, isolated
Playwright, Harn/provenance, release/license audits, and cross-feature journeys
for scheduled delivery through reconnect, Q1 acknowledgement of a scheduled
request, prose ordering across interjections, compaction briefing after reset,
and reset while schedules remain pending.

## Integration and release

- The main Investigator reviews each completed worktree independently; one slow
  lane does not block review or correction of another.
- Accepted commits are integrated with traceable no-ff merges (or an explicit
  dependency rebase/cherry-pick before the dependent phase), followed by a
  narrowly scoped reconciliation Harn plan only where trees genuinely overlap.
- Never merge implementation branches directly from an unreviewed worktree.
- No push, deployment, npm publication, host update, or release occurs without a
  separate explicit approval after combined verification.

## Explicit exclusions

- No global wave barrier and no internal agent delegation.
- No inactive-channel unsubscribe redesign, full offline archive, offline send
  queue, or finalized full-journal fallback.
- No relay wire-protocol, Worker/Durable Object, account, registry, pooling, or
  scale-framework redesign.
- No timestamp heuristic for prose splitting and no migration of old prose
  journals.
- No recurring/cron scheduler or external queue.
- No destructive reset before confirmed runtime retirement.
- No unrelated UI polish, deployment, publication, or real-host mutation.
