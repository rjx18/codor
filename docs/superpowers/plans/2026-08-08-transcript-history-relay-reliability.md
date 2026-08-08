# Transcript History and Relay Reliability Implementation Plan

> **For phase implementers:** Sol executes Phases 2 and 3; Luna executes Phase 4. Each uses `superpowers:executing-plans` only for the phase assigned by Investigator. Every phase receives its own locked Harn plan and one implementation commit. Do not begin a later phase until Investigator has reviewed and accepted the preceding phase.

**Goal:** Make cold channel history bounded by visible transcript work, make hosted sessions recover reliably after idle disconnects, and stop unrelated codor.app releases from redeploying the relay Worker.

**Architecture:** Add one authorized server projection that pages immutable transcript units across both SQLite messages and their JSONL run journals. The browser consumes that projection as the sole source of finalized history while retaining the existing live stream for mutable runs. Separately, coordinate each hosted computer's tunnel and app connector by the tunnel's current connection generation, then narrow relay deployment decisions to inputs that can affect the relay bundle or its deployment logic.

**Tech Stack:** TypeScript, Node.js, Fastify, Zod, React, Zustand, Vitest, Playwright, pnpm, GitHub Actions, Cloudflare Pages/Workers, Harn.

## Workflow and global constraints

- The approved sequence is Phase 1 server pagination, Phase 2 browser integration, Phase 3 coordinated relay recovery, then Phase 4 deployment isolation.
- Investigator owns orchestration, Harn-plan review, and implementation review. Sol owns implementation of Phases 2–3; Luna owns implementation of Phase 4. Each implementer works only on the phase explicitly assigned by Investigator, tags Investigator when complete or genuinely blocked, and then waits without polling or monitoring Investigator's activity. Coordination happens only through explicit tags in the Codor channel; do not use internal delegation.
- Each phase is one locked Harn plan and one implementation commit. Prepare and lock a phase plan only after the preceding phase's implementation is present and accepted. This document is the cross-phase implementation plan, not a substitute for those per-commit Harn plans.
- Preserve authentication, redaction, evidence ownership, live-run fidelity, permanent message IDs, continuations, direct mode, multi-computer isolation, and existing authorized attachment/search/pin behavior.
- Do not optimize inactive-channel startup, add a persistent journal index or migration without measured evidence, redesign the relay protocol or Worker runtime, add account/cloud-registry/pooling infrastructure, or redesign unrelated UI.
- Do not carry the obsolete `1723f54` plan checkpoint, rejected inactive-channel changes, or provisional CI edits. The replacement branch starts from clean `main` at `3b587c75cc02a9580ffbdaaafc217fc4d12d8cf5`.

## Shared transcript contract

The first two phases must implement the following contract without changing live fanout or the raw evidence model:

- The public cursor is opaque, at most 4096 characters, versioned internally, bound to one room, and rejected before decoding when oversized or when malformed, from a different room, or outside the immutable page boundary. The first cursor fixes a newest-message ceiling, so messages arriving later cannot move the page while the operator walks backward.
- The immutable REST page includes only run families whose lifecycle root is finalized (`completed`, `failed`, or `interrupted`). Running families and work still queued for a run are excluded as a whole: their root, continuations, and mutable journal remain owned by live fanout and the existing mutable full-journal path until finalization.
- A page contains at most 20 visible units. It may contain more than 20 complete message records when continuation/root context is required to render those units honestly.
- An ordinary visible message is one unit. Consecutive valid prose deltas for the same permanent output message form one indivisible unit. A valid tool call and its matching valid result form one indivisible unit only within that permanent output message; an orphan valid result is one unit. For item types the browser renders, malformed normalized payloads follow its fallback exactly: they remain visible single rows and malformed text/tool events are never coalesced or paired from raw fields. Every `reasoning_summary` counts as zero, whether valid or malformed. A compaction loading/completed pair upgrades one visible unit only within its permanent output message rather than counting twice.
- A finalized run contributes a settled-tail unit only when the browser has something settled to render: final-text fallback or trailing text, or failed/interrupted error/status. Fully represented streamed evidence in a successful completed run adds no invisible terminal unit. The terminal journal event belongs to that settled-tail unit when it exists and is otherwise omitted from the excerpt.
- A unit never splits a prose block or a valid tool call/result pair. Units retain journal indices and permanent output message IDs when present. Modern continuation journals use permanent `output_message_id` position followed by journal order. For legacy pre-continuation journals, only prose-bearing runs interleave their segments by the current first-delta/tool timestamp fallback; tools-only and compaction-only runs remain grouped at `ended_ts`, and a failed/interrupted settled tail stays beside the final visible segment rather than moving across an interleaved human message.
- The response returns complete authorized, projected, redacted message records needed by the selected units plus indexed journal excerpts, never partial message shapes or raw evidence. One lifecycle-root journal may provide excerpts for several continuation rows.
- Raw JSONL remains the evidence source. Phase 1 may scan the local journal and must measure that scan; no persistent index is introduced unless measurements justify a separately approved follow-up.

## Phase 1: Server-side combined transcript pages

**Intent:** Introduce the bounded, authorized server contract while leaving every current client and endpoint behavior intact.

### Task 1: Define the protocol representation and unit rules

**Files:**

- Create: `packages/protocol/src/transcript-history.ts`
- Create: `packages/protocol/src/transcript-history.spec.ts`
- Modify: `packages/protocol/src/index.ts`

Define Zod-backed request/response types for:

- `HISTORICAL_TRANSCRIPT_PAGE_SIZE = 20`;
- an opaque cursor string;
- complete projected message records;
- indexed run events `{ index, event }` grouped by lifecycle root;
- ordered unit descriptors that identify ordinary-message, prose, tool-pair, timeline/compaction, and visible settled-tail units by permanent output message and the event indices they own;
- `before_cursor` and `has_more`.

Keep the cursor payload server-private. Protocol tests must prove every returned shape is serializable and rejects partial records, invalid indices, unknown unit kinds, and pages over 20 units.

### Task 2: Build deterministic local pages

**Files:**

- Create: `packages/switchboard/src/transcript-history.ts`
- Create: `packages/switchboard/src/transcript-history.spec.ts`

Implement a pure page builder with injected message and journal readers. Its private v1 cursor records the exact room, immutable newest ceiling, and the prior `(messageId, unitOrdinal)` boundary; encode it opaquely and validate all fields before use.

Walk message rows backward in bounded chunks, resolve `run_parent_id` to the owning journal, and scan that JSONL locally only for terminal lifecycle roots. Exclude an entire family when its root is running or its work is still queued/not finalized; the REST response must not expose a partial mutable family. Unitize finalized evidence under the shared contract, select no more than 20 newest units before the cursor, and return the selection chronologically. Include complete root/continuation records required for attribution even if a record is context-only. Do not alter or truncate the raw journal.

Use permanent output-message placement for modern continuation journals, with independent prose, tool-call, and compaction grouping state per output message. Safe-parse every browser-rendered normalized payload before deciding its visible kind, prose coalescing, or tool pairing, while suppressing every reasoning summary before fallback handling. If a stored legacy journal has no `output_message_id`, reproduce `buildTimelineEntries` exactly: prose-bearing runs use segment timestamps with the preceding/finalized fallback and stable original order for ties, while tools-only and compaction-only runs keep every unit at the run's `ended_ts`. Timestamp a failed/interrupted settled tail with the final visible segment so it cannot cross a human message that followed that segment.

Focused tests must cover:

- one enormous finalized run split across several pages without splitting prose or tool pairs;
- a page boundary inside one run;
- call/result separation by unrelated journal events and orphan results;
- continuation output IDs, one root journal, and ordinary messages interleaved between continuation rows;
- legacy pre-continuation journals without output IDs retain timestamp interleaving around human messages;
- legacy tools-only and compaction-only runs stay grouped at `ended_ts`, and failure tails stay with their final segment;
- malformed browser-rendered text/tool payloads produce fallback units without false coalescing or pairing, while valid and malformed reasoning summaries both produce zero units;
- prose, same-ID tool calls/results, and compaction loading/completed events on different permanent output messages never share grouping state;
- running and queued/not-finalized families contribute no root, continuation, excerpt, unit, or cursor position until terminal;
- compaction loading/completed upgrades and only genuinely visible settled tails;
- at least 25 completed fully streamed runs page as 20 visible prose units, not prose plus invisible terminal units;
- new messages inserted above the fixed ceiling while paging;
- malformed, oversized, and cross-room cursors;
- no duplicates or gaps across a full cursor walk;
- complete message records and indexed, redacted excerpts only.

Add a deterministic measurement fixture for a large journal. Report serialized response bytes, message/journal records touched, and server scan/build latency for one cold scan and at least five warm scans. Keep structural limits as hard assertions; record latency so Phase 1 has evidence without turning machine timing into a brittle low threshold.

### Task 3: Expose the authorized projection

**Files:**

- Modify: `packages/switchboard/src/daemon.ts`
- Modify: `packages/switchboard/src/server.ts`
- Modify: `packages/switchboard/src/server.spec.ts`

Add `GET /api/rooms/:room/transcript-history?cursor=<opaque>` (with the first request omitting `cursor`). Reuse the existing bearer authentication and room-read authorization, require the room to exist, and fix the public limit at 20. Project and deeply redact complete messages and selected events before serialization; raw bodies and journals stay on disk.

Return `400` for malformed, stale-invalid, or cross-room cursors, normal authorization failures for inaccessible rooms, and one stable response shape for empty/end-of-history pages. Leave `/api/rooms/:room/messages`, `/api/rooms/:room/runs/:id`, WebSocket hydration, live fanout, search, pins, and permalinks unchanged in this phase.

Server integration tests must prove authorization, room isolation, redaction, huge-run internal pagination, running/queued-family exclusion, exact legacy grouping/tail ordering, output-message-scoped grouping, browser-rendered malformed-event fallbacks with unconditional reasoning suppression, oversized-cursor refusal, bounded response bytes for the 20-renderable-unit selection, stable cursor walking, and no mutation of raw evidence.

### Task 4: Verify Phase 1

Run:

```bash
pnpm --filter @codor/protocol test -- transcript-history.spec.ts
pnpm --filter @codor/switchboard test -- transcript-history.spec.ts server.spec.ts
pnpm --filter @codor/protocol test
pnpm --filter @codor/switchboard test
pnpm --filter @codor/protocol build
pnpm --filter @codor/switchboard build
pnpm harn check transcript-history-reliability-p1-server-pages
```

Record the large-journal scan latency, selected-unit count, serialized payload bytes, and reader-call counts in the handoff. Apply the locked Harn plan and create the single Phase 1 implementation commit. Investigator reviews the actual diff and results before Phase 2 receives a Harn plan.

## Phase 2: Browser uses bounded history

**Intent:** Make the combined page the sole source of finalized transcript history while preserving unbounded live runs and all navigation behavior.

### Task 1: Add the page client and isolated history state

**Likely files:**

- Modify: `packages/web-next/src/runtime/api.ts`
- Modify: `packages/web-next/src/runtime/api.spec.ts`
- Create: `packages/web-next/src/room/transcript-history.ts`
- Create: `packages/web-next/src/room/transcript-history.spec.ts`
- Modify: `packages/web-next/src/app/store.ts`
- Modify: `packages/web-next/src/app/store.spec.ts`

Fetch the first page only for the mounted active room and store its complete messages, ordered units, indexed excerpts, cursor, loading state, and exhaustion state per room and per computer store. Do not request zero-message snapshots for inactive channels. Deduplicate concurrent first-page and older-page requests by room/cursor.

### Task 2: Retire full-journal reads for finalized history

**Likely files:**

- Modify: `packages/web-next/src/room/run-journals.ts`
- Modify: `packages/web-next/src/room/run-journals.spec.ts`
- Modify: `packages/web-next/src/room/Transcript.tsx`
- Modify: `packages/web-next/src/room/Transcript.spec.tsx`

Page-hydrated finalized runs must render only the server's selected indexed excerpts and must never trigger the current cold `GET /runs/:id` cache fill. Mutable/running journals may still use the existing full journal plus live buffer. When a visible live run settles, preserve the already-rendered evidence in place, accept any visible settled tail once, and transition it to immutable history without a duplicate unit or cold journal download.

The store may retain broader WebSocket message metadata for synchronization, but the active transcript must render finalized history exclusively from the combined pages plus currently live material. Merely adding the REST endpoint while leaving the finalized-run cache eager is not acceptable.

### Task 3: Page on deliberate top reach and preserve navigation

**Likely files:**

- Modify: `packages/web-next/src/room/Transcript.tsx`
- Modify: `packages/web-next/src/room/Transcript.spec.tsx`
- Modify: `packages/web-next/tests/room21-hydration.e2e.spec.ts`
- Create: `packages/web-next/tests/room-history-pagination.e2e.spec.ts`

Initial history is at most 20 units. One deliberate top reach requests one preceding page and restores the same visible DOM anchor after prepending; a still-intersecting sentinel must not drain every page automatically. A live run remains unbounded.

Search results, pins, and `#N` permalinks must reveal their target by walking bounded cursors until the target unit/message is present or history is exhausted, then retain existing focus/highlight behavior. Continuation attribution and interleaved rows must use their permanent IDs. Room/computer switches must not leak excerpts or cursors across stores; direct mode uses the same REST contract over native fetch.

### Task 4: Verify Phase 2

Add unit and Playwright regressions for a huge run, boundary within a run, continuation/interleaved messages, top-scroll anchoring, search, pins, permalinks, live-to-finalized settlement, computer/room isolation, and direct mode. Instrument requests to prove cold history makes one bounded transcript-page request and zero full `/runs/:id` requests for finalized runs; record browser payload bytes and request counts.

Run affected units, all web-next units/build, focused hydration/history Playwright suites, and the Phase 2 Harn check. Apply and commit once, then stop for Investigator review.

## Phase 3: Coordinate relay recovery by tunnel generation

**Intent:** Remove the confirmed rendezvous race between tunnel recovery and app-stream recovery without changing the relay protocol.

### Task 1: Make current-generation tunnel readiness authoritative

**Likely files:**

- Modify: `packages/web-next/src/runtime/relay.ts`
- Modify: `packages/web-next/src/runtime/relay.spec.ts`

Replace the permanently resolved one-shot readiness promise with readiness scoped to the current tunnel generation. Increment the generation when a tunnel is lost or deliberately restarted; settle waiters only for the matching successful handshake and reject/retire stale waiters. Replace the single assignable `onStateChange` slot with a subscribe/unsubscribe listener set so the manager and connector cannot overwrite each other.

Make `connect()`/`recover()` idempotent: one in-flight handshake and one retry timer per session generation. A foreground recovery request may accelerate the current attempt but may not create parallel handshakes. Preserve canonical/alias failover and signed session authentication.

### Task 2: Gate the app connector and open exactly once

**Likely files:**

- Modify: `packages/web-next/src/app/connector.ts`
- Modify: `packages/web-next/src/app/connector.spec.ts`
- Modify: `packages/web-next/src/app/computer-sessions.ts`
- Modify: `packages/web-next/src/app/computer-sessions.spec.ts`

For each indexed computer, gate app-stream creation on that computer's current connected tunnel generation. Suppress doomed app attempts while the tunnel is down. On the connected handshake edge, wake the connector immediately and open exactly one app socket for that generation; retain server-frame readiness as the only signal that the app socket is usable.

Bootstrap and every recovery attempt must await current-generation readiness, not the first connection the session ever made. Disconnect/error/foreground signals can converge on the same idempotent recovery. Stale callbacks from earlier generations must not close or reopen the current socket.

Never auto-reopen authentication failure, revocation, upgrade-required, or explicit/manual parks. Preserve direct/self-hosted behavior and keep all other computer sessions live and isolated.

### Task 3: Prove the race and recovery behavior

**Likely files:**

- Modify: `packages/web-next/tests/room32-relay-journey.e2e.spec.ts`
- Modify: `packages/web-next/tests/room33-recovery.e2e.spec.ts`
- Modify: `packages/web-next/tests/room34-multi-computer.e2e.spec.ts`
- Modify: `packages/web-next/tests/room35-startup-recovery.e2e.spec.ts`

Use deterministic controllable tunnels/sockets, not timing luck, to cover both failure orderings: app retry while tunnel is down and tunnel reconnect after the app backoff has started. Cover idle/background disconnect then foreground, current-generation bootstrap, duplicate recovery triggers, stale generation callbacks, exactly one app socket after each successful tunnel handshake, no document refresh, and no reopening of auth/upgrade/manual parks. Two hosted computers must recover independently; direct mode must remain unchanged.

Run affected runtime/manager units, all web-next units/build, focused relay/recovery/multi-computer Playwright suites, and the Phase 3 Harn check. Apply and commit once, then stop for review.

## Phase 4: Isolate relay Worker deployment

**Intent:** Keep Pages deploying verified `main` commits while deploying the relay Worker only when its bundle, tested shared contract, toolchain, or deploy workflow can change.

### Task 1: Extract and test the deploy decision

**Likely files:**

- Create: `scripts/relay-deploy-decision.mjs`
- Create: `scripts/relay-deploy-decision.spec.mjs`
- Modify: `package.json`

Given a full pushed range, return deploy/skip plus a human-readable reason. Fail open to deploy when the comparison base is missing, unreachable, or ambiguous.

Deploy for:

- `relay-worker/**`;
- `packages/tunnel/**` as a deliberately conservative shared-contract trigger, while documenting that it is currently a relay test dependency rather than a Worker runtime dependency;
- `tsconfig.base.json`;
- the deployment workflow and deploy-decision script/tests themselves when they can change selection or bundling;
- only the selected root manifest fields and lockfile importer/toolchain records that can change the relay build/deploy toolchain.

Do not deploy merely because unrelated root `package.json` fields or unrelated `pnpm-lock.yaml` importers changed. Compare normalized relevant manifest/lockfile slices from both revisions rather than matching the whole files. Avoid a new production dependency for this decision.

### Task 2: Wire the full-range GitHub Actions gate

**Files:**

- Modify: `.github/workflows/ci.yml`

Fetch enough history to compare the entire pushed range. Keep the existing verified-main and Pages behavior, but place relay Worker deployment behind the tested decision output. A missing before SHA/base must deploy. Log both the compared revisions and decision reason.

### Task 3: Verify deployment isolation

Test unrelated web/docs changes, unrelated root manifest edits, unrelated lockfile importer edits, multiple-commit pushes, relay-worker edits, conservative tunnel edits, relevant root toolchain fields, relevant lockfile slice changes, `tsconfig.base.json`, workflow/decision changes, and missing comparison bases. Prove only the relevant cases deploy.

Run the decision tests, workflow syntax/static checks, affected builds, and the Phase 4 Harn check. Apply and commit once, then stop for final review. Do not deploy from the implementation run unless Richard separately authorizes it.
