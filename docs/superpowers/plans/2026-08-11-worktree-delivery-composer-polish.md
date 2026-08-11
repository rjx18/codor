# Worktree Rail, Inline Delivery Retry, and Composer Send Plan

**Goal:** Make worktree rows compact and obvious, replace disruptive reboot-hold banners with retry state on the original message, and make Enter reliably send a draft that ends in an exact mention.

**Scope:** Two small implementation phases in the existing worktree-orchestration branch, reviewed separately, followed by one alpha release. This does not change worktree identity/routing, Git lifecycle rules, relay generations, delivery persistence, or the exactly-once-or-held protocol.

## Confirmed causes

1. **The worktree row spends a second line on status.** `ChildRow` renders the branch on the first line, then activity, connection, and unread state on a second line. The normal connected state is the green dot Richard called out; it adds no useful action.
2. **Manage overlaps because it is absolutely positioned over the row link.** The text button has no reserved column. Long branches therefore run underneath it. It also opens a large modal that eagerly loads removal state even when the operator only wanted to see the actions.
3. **Working state duplicates itself.** A working worktree keeps the branch icon and adds animated dots plus accessible activity on the second line. The requested compact representation only needs the dots in the icon slot.
4. **Held delivery is projected globally instead of on its message.** `HoldBanner` lifts every held inbox row above the transcript and presents two recovery verbs. The original outgoing message and its delivery records already share `delivery.message_id`, so the error can be rendered on that exact message without a new protocol or database field.
5. **Release and Redeliver are different but look equivalent.** `release_hold` resumes the held attempt and preserves its run/journal/attempt evidence. `redeliver` clears the old binding and starts a fresh attempt. Both look like “try again” in the current banner. The ordinary UI should expose one safe retry path, not both implementation concepts.
6. **A trailing exact mention consumes Enter as autocomplete.** At keydown, `Composer` treats every mention prefix with candidates as an open completion. Thus `please check this @investigator` + Enter inserts a trailing space and returns before `send()`. The post never happened, so the echo-driven draft clearing correctly never ran. Mentions at the front do not show the problem because the user types more text after accepting them.

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

## Phase 2 — inline failed-delivery retry and exact-mention send

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

**Acceptance:** reboot-held messages have no top banner and show one inline retry affordance on the original message; retry clears only the matching held state and produces one resumed attempt; reload retains the same presentation. Both `message @investigator` and an exact qualified target send on the first Enter and clear after their own echo, while partial autocomplete, rejection retention, mobile newline, and computer/worktree switching remain green.

## Review and alpha release

- Investigator reviews each phase before the next starts, focusing on the exact state mapping, no duplicate retry, focus/phone behavior, and the trailing-mention regression.
- Run focused component/unit tests, all web units, production/PWA build, and exact browser suites covering Rooms 2, 34, 40, and 41 plus a reboot/reload held-delivery fixture. Run light/dark Axe at desktop and 390px.
- Run Harn plan/check/apply/staged checks independently for each phase. Phase 1 must replace the current promise that connection/activity always has a visible compact indicator; Phase 2 adds the message-owned held-recovery presentation while reviewing daemon delivery semantics unchanged.
- After both reviews pass, bump to the next unused alpha package version, run release/license and packed `npx` proofs, publish `@richhardry/codor` under the `alpha` dist-tag, create the matching GitHub prerelease artifacts/checksums, and deploy the web app. The relay Worker does not need deployment unless the final diff unexpectedly touches its relevant inputs.

## Explicitly out of scope

- No worktree routing, naming, repository, database, or authorization changes.
- No new delivery state, retry endpoint, queue, or server migration.
- No removal of the underlying `redeliver` or `release_hold` protocol actions.
- No optimistic clearing that could lose a refused or disconnected draft.
- No channel-rail, relay-recovery, transcript-pagination, or broader visual redesign.
