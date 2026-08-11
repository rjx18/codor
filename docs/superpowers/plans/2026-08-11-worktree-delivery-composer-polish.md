# Worktree Rail, Delivery/Composer Fixes, and Transcript Reconciliation Plan

**Goal:** Make worktree rows compact and obvious, replace disruptive reboot-hold banners with retry state on the original message, make Enter reliably send a draft that ends in an exact mention, and keep cached/finalized transcript presentation complete and visually coherent.

**Scope:** Two implementation phases in the existing worktree-orchestration branch, reviewed separately, followed by one alpha release. Phase 1 is the contained worktree presentation change. Phase 2 owns the harder delivery/composer and transcript reconciliation fixes. This does not change worktree identity/routing, Git lifecycle rules, relay generations, delivery persistence, or the exactly-once-or-held protocol.

## Confirmed causes

1. **The worktree row spends a second line on status.** `ChildRow` renders the branch on the first line, then activity, connection, and unread state on a second line. The normal connected state is the green dot Richard called out; it adds no useful action.
2. **Manage overlaps because it is absolutely positioned over the row link.** The text button has no reserved column. Long branches therefore run underneath it. It also opens a large modal that eagerly loads removal state even when the operator only wanted to see the actions.
3. **Working state duplicates itself.** A working worktree keeps the branch icon and adds animated dots plus accessible activity on the second line. The requested compact representation only needs the dots in the icon slot.
4. **Held delivery is projected globally instead of on its message.** `HoldBanner` lifts every held inbox row above the transcript and presents two recovery verbs. The original outgoing message and its delivery records already share `delivery.message_id`, so the error can be rendered on that exact message without a new protocol or database field.
5. **Release and Redeliver are different but look equivalent.** `release_hold` resumes the held attempt and preserves its run/journal/attempt evidence. `redeliver` clears the old binding and starts a fresh attempt. Both look like “try again” in the current banner. The ordinary UI should expose one safe retry path, not both implementation concepts.
6. **A trailing exact mention consumes Enter as autocomplete.** At keydown, `Composer` treats every mention prefix with candidates as an open completion. Thus `please check this @investigator` + Enter inserts a trailing space and returns before `send()`. The post never happened, so the echo-driven draft clearing correctly never ran. Mentions at the front do not show the problem because the user types more text after accepting them.
7. **A cached combined-history head can remain stale after a hard refresh.** The durable room contains the missing rows and the server's current combined-history page returns the newer units. The browser can nevertheless restore an IndexedDB page ending at an older message, mark it initialized, and show a current live run beside it. `ensureTranscriptHistory()` then short-circuits, while the manager's cache-replacement refresh is one fire-and-forget attempt. If that attempt races or fails, finalized rows remain page-owned/suppressed and the visible transcript has a hole.
8. **Invisible output-row boundaries split visually consecutive tool batches.** Historical evidence is correctly indexed per `output_message_id`, but `renderHistoricalTimeline()` creates a separate `TurnBlock` for each output row. `RunContent` can merge tool-only units only inside that block, producing repeated `Ran 2 tools` controls even when no visible prose, message, compaction marker, or status separates them.

## Phase 1 — compact worktree row and anchored action menu

**Recommended implementer:** Luna (contained presentation work).

- Keep one visible line per child: branch glyph followed by the exact Git branch, with the existing unread badge and a fixed trailing action cell.
- Remove the normal connection/activity row and the visible green connection dot. Keep connection, attention, and checkout truth in the row's accessible label/title so removing the dot does not falsify state for assistive technology.
- While any agent in that exact child conversation is queued/running, replace the branch glyph—not the branch text—with the existing three animated green dots. When work stops, restore the branch glyph. Do not render “agent is working” or “Working” text.
- Replace the overlapping `Manage` text button with an always-reachable three-dot icon in its own grid column. It must never sit over the branch link at desktop or 390px width.
- Open a small anchored dropdown, not a modal. It contains the existing two authorized acts only:
  - `Unregister` advances to a compact confirm/cancel state in the same dropdown.
  - `Remove from disk` loads the existing fresh safety preview only when selected, shows a blocked reason or compact confirm/cancel state in the same dropdown, and continues preserving the Git branch.
- Close on outside click and Escape and return focus to the three-dot trigger. Keep Create and Find as their existing dialogs; only child management moves to the dropdown.
- Do not reintroduce aliases, generated conversation IDs, visible Live/offline prose, or any Git/server behavior.

**Acceptance:** exact branch remains the only visible name; idle is branch icon + branch; working is animated dots + branch; no green connection dot or second-line working text exists; menu never overlaps; keyboard, phone, light/dark Axe, unregister, blocked removal, clean removal, and error retry all pass.

## Phase 2 — delivery/composer correctness and transcript reconciliation

**Recommended implementer:** Sol (delivery recovery semantics plus composer action-edge correctness).

### Inline retry

- Remove the global `HoldBanner` from both desktop and mobile room layouts.
- Extend the existing outgoing-message delivery indicator. If any agent delivery for that message is held, show a small red exclamation button beside that message's timestamp/ticks instead of treating it as merely queued.
- Clicking the exclamation reveals a compact, dismissible inline row beneath that same message: `Delivery to @handle stopped after reconnecting` with one `Retry delivery` action. Multiple held recipients render separately and retry independently.
- `Retry delivery` uses `release_hold`, the evidence-preserving recovery path. Do not expose the fresh-attempt `redeliver` control in this ordinary UI; retain both protocol actions and daemon semantics for existing integrations and advanced recovery.
- When the delivery leaves held state, remove the inline error automatically and return to the existing queued/delivered/steered indicator. A failed retry keeps the message and affordance visible and surfaces the existing action error.
- The outgoing message remains in its ordinary chronological position before and after reload. Pagination/search/permalinks remain authoritative; no special duplicate message, top banner, or eager full-history fetch is introduced.

### Exact mention and draft clearing

- At desktop keydown, distinguish a partial completion from an already exact recipient token.
- Enter with an exact local mention such as `text @investigator` or an exact qualified mention sends the whole live textarea immediately. It must not first insert a space.
- Enter on a partial token such as `@inv` keeps selecting the highlighted completion; Tab remains a completion action. Shift+Enter and mobile Enter keep their current newline behavior.
- Preserve the current no-loss rule: clear attachments/reply/draft only after the accepted own-message echo; keep the draft on refusal, disconnect, or invalid qualified target. After successful clear, the normal default-recipient seed may return as it does today.

### Cached-head reconciliation

- A persisted last-good transcript is immediately readable but explicitly stale until an authenticated combined-head refresh succeeds. `initialized` alone must not mean the cache is current.
- Start that refresh only after the computer session has a ready tunnel/token, and route it through that exact computer's tunnel rather than the mutable global active transport. Keep direct mode unchanged.
- Deduplicate refreshes and retry on the next current-generation socket-ready/resume edge after a bounded failure. Never reopen credential, upgrade, or manual parks.
- While revalidation is pending, keep newer socket-received rows/live evidence visible above the cached page. Once the head lands, reconcile by stable message/unit identity without duplicates or scroll jumps.
- Cover the observed journey exactly: cached head ending at `#1635`, newer completed run/chat rows, a concurrently running agent, hard refresh, then every newer visible row appears without waiting for another reload. Include same-room multi-computer isolation.

### Consecutive tool batching

- Keep the server's output-row-scoped unit identities and evidence pairing unchanged.
- In the browser presentation, coalesce adjacent tool-only evidence from the same run root into one `Ran N tools` batch even when it crosses output rows or a loaded-page boundary.
- Preserve every unit/output anchor inside the aggregate so pagination, permalinks, search, and scroll restoration keep their existing identities.
- Stop the aggregate at any renderable prose, human/system message, compaction marker, terminal/status marker, or different run root. Apply the same visible rule while live and after settlement/reload.

**Acceptance:** reboot-held messages have no top banner and show one inline retry affordance on the original message; retry clears only the matching held state and produces one resumed attempt; reload retains the same presentation. Both `message @investigator` and an exact qualified target send on the first Enter and clear after their own echo, while partial autocomplete, rejection retention, mobile newline, and computer/worktree switching remain green. A hard refresh cannot show a stale cached head beside a newer live run, and visually consecutive tools produce one aggregate across output/page boundaries without losing anchors or merging across visible separators.

## Review and alpha release

- Investigator reviews each phase before the next starts, focusing on the exact state mapping, no duplicate retry, focus/phone behavior, trailing-mention send, cached-head recovery, and tool-batch boundaries.
- Run focused component/unit tests, all web units, production/PWA build, and exact browser suites covering Rooms 2, 21, 33, 34, 40, and 41 plus reboot/reload held-delivery and stale-cache fixtures. Run light/dark Axe at desktop and 390px.
- Run Harn plan/check/apply/staged checks independently for each phase. Phase 1 must replace the current promise that connection/activity always has a visible compact indicator; Phase 2 adds the message-owned held-recovery presentation while reviewing daemon delivery semantics unchanged.
- After both reviews pass, bump to the next unused alpha package version, run release/license and packed `npx` proofs, publish `@richhardry/codor` under the `alpha` dist-tag, create the matching GitHub prerelease artifacts/checksums, and deploy the web app. The relay Worker does not need deployment unless the final diff unexpectedly touches its relevant inputs.

## Explicitly out of scope

- No worktree routing, naming, repository, database, or authorization changes.
- No new delivery state, retry endpoint, queue, or server migration.
- No removal of the underlying `redeliver` or `release_hold` protocol actions.
- No optimistic clearing that could lose a refused or disconnected draft.
- No channel-rail, relay-generation, server pagination/unitizer, or broader visual redesign. Phase 2 may only reconcile the existing combined pages/cache/live tail and their presentation.
