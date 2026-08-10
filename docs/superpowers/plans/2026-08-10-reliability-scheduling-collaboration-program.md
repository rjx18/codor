# Codor Reliability, Scheduling, Collaboration, and Context Program

## Outcome

Ship the already-investigated hosted relay/startup fixes through the official `codor update` journey, then add durable scheduled messages, clearer post-compaction collaboration instructions, a Codex steering separator, and a context reset that is both reliable and non-blocking in the UI.

This is a planning-only program. No manual XPS restart is part of acceptance: the XPS and macOS hosts stay on their current release until the official update command is ready, and that command must prove the service/runtime convergence fix.

## Shared delivery rules

- Start each worktree from the accepted integration head produced by the previous worktree. Do not create four independent long-lived branches from today's `main`; sequential bases avoid avoidable protocol/daemon/UI merge conflicts.
- Each phase gets its own clean-locked Harn plan and one implementation commit. A later phase is not locked until Investigator has reviewed and accepted the preceding phase.
- Use existing mechanisms before adding new ones: SQLite/store lifecycle, ordinary Codor routing, Act-frame refs and correlated member results, current platform service generators, existing spinner/popover styles, and the current compaction reinjection hook.
- Preserve authentication, redaction, room/worktree target identity, direct/Tailscale behavior, hosted computer isolation, evidence ownership, and live-run fidelity.
- Implementers do not delegate internally and do not monitor an active peer. Investigator invokes one channel agent once, then waits for that agent's completion or genuine-blocker tag without polling.

## Worktree 1 — hosted and update reliability

**Path:** `/home/richard/git/codor-relay-smooth-startup`

**Branch:** `fix/relay-smooth-startup`

**Detailed plan:** `docs/superpowers/plans/2026-08-10-hosted-relay-smooth-startup.md`

The existing unlocked `hosted-relay-smooth-startup` Harn draft must be split before implementation; one plan/commit cannot honestly consume all three phases.

### R1 — hosted startup, channel loading, cache, and transcript geometry

**Implementer: Sol (hard).** Fix the late-readiness dead end, duplicate managed bootstrap requests, abortless tunnel fetches, eager 20-message hydration for every background room, reconnecting presentation, bounded last-good active-room cache, and the transcript/composer scroll flicker. Keep every room on every paired computer subscribed for live state; only historical tails become metadata-first for inactive rooms.

### R2 — official update and service convergence

**Implementer: Sol (hard).** Add `codor update`, acquire the exact current stable npm release without a shell, run that release's private updater, reuse the atomic durable-runtime swap, restart the platform service exactly once, and verify the new runtime generation. Fix Linux's no-restart `enable --now`, Windows's already-running scheduled task, and macOS's loaded-but-booting launchd race. Preserve all user state and roll back a failed update.

The acceptance test is the real supported journey: an older XPS/WSL and Mac installation runs `codor update`; no manual service command is permitted; the new CLI, web routes, pairing, relay identity, and existing channels must all work afterward.

### R3 — empty default-roster guidance

**Implementer: Luna (straightforward UI/test work).** Treat an authoritative empty roster as unconfigured, not failed and not selectable. Link an existing channel to the mounted Settings surface and show the shortest real setup sequence there. Preserve genuine Retry errors and keep Starting agent usable.

## Worktree 2 — scheduled messages

**Path:** `/home/richard/git/codor-scheduled-messages`

**Branch:** `feat/scheduled-messages`

Create this worktree from the accepted Worktree 1 integration head.

### S1 — persistent exactly-once scheduler

**Implementer: Sol (hard).**

- Recognize a scheduling directive only at the start of a substantive message, with optional whitespace before the target: `[send_in=2h30m] @sol ...` and `[send_at=9:30PM] @sol ...`. Support seconds, minutes, hours, and days for relative sends. Browser/CLI clock input resolves to an absolute instant using the submitting client's local offset; agent-authored clock-only input uses the switchboard host zone and is rendered with that zone. An ISO-8601 value with offset is the unambiguous form.
- Parse and authorize at creation time, resolve ordinary and `~worktree:@member` targets to durable identities, store the clean body and target snapshot in SQLite, and assign a stable schedule id. Do not leave correctness to an in-memory timer.
- On boot and after every mutation, arm only the next due deadline. At due time, atomically claim the row, create one normal message/delivery through the existing routing boundary, and mark it sent. Crash/restart may delay a send but may never duplicate it. A removed or unavailable target becomes an explicit failed schedule; it must not silently fall back to another agent.
- Add authorized cancellation before claim. Enforce bounded body/directive sizes, a future-only timestamp, and a one-year maximum horizon. Recurrence, cron syntax, edits, bulk scheduling, external queues, and arbitrary scripts are out of scope.

### S2 — composer/CLI syntax and scheduled-card UI

**Implementer: Luna (contained UI/CLI work).**

- Make the browser composer and `codor post` resolve friendly absolute clock input consistently and submit the canonical scheduled request. Keep ordinary messages containing directive examples untouched unless the directive is the first substantive token.
- Render a compact transcript card immediately: clock icon, addressed member/worktree, local date/time plus zone, short preview, and Pending/Sending/Failed state. Pending cards expose Cancel only to an authorized author/admin. Reconcile a sent card into the ordinary delivered message without duplication; cancelled/failed cards remain compact and honest.
- Cover direct and hosted mode, refresh/reconnect, multiple schedules at the same instant, offset input, worktree-qualified targets, cancellation races, accessibility, and mobile layout.

## Worktree 3 — collaboration delivery polish

**Path:** `/home/richard/git/codor-collaboration-delivery-polish`

**Branch:** `fix/collaboration-delivery-polish`

Create this worktree from the accepted Worktree 2 integration head.

### D1 — briefing rules and Codex steering boundary

**Implementer: Luna (straightforward copy/adapter regressions).**

- Replace the current monitoring-oriented convention copy with a concise channel workflow: do not spawn internal subagents for channel work; invoke a channel member with one `@mention` only to start or hand off work; plain names do not invoke; after invocation do not poll, monitor, status-check, wait on, or remind the active member; that member tags the parent on completion or a genuine blocker.
- State that ordinary final replies auto-post. Use `codor post` only for a nonterminal progress update while continuing work, or when operating outside the normal final-response path. Use `codor post --wait` only when work is genuinely blocked on a direct answer, never as a monitoring loop. Use a tagged final reply once for completion/blocker handoff.
- Keep the same concise briefing on first delivery and re-inject it through the existing flag gate after both automatic completed compaction and successful manual compaction. Do not inject mid-turn or add a second briefing mechanism.
- In the Codex adapter only, prefix active-turn `turn/steer` text with a blank-line boundary so a newly delivered Codor message cannot concatenate onto the preceding native text. Leave the stored message, normal `turn/start`, other adapters, routing, and message body unchanged. Prove repeated steers stay ordered and each begins after a visible paragraph break.

## Worktree 4 — reliable non-blocking context reset

**Path:** `/home/richard/git/codor-context-reset`

**Branch:** `fix/context-reset`

Create this worktree from the accepted Worktree 3 integration head.

### C1 — bounded, correlated reset backend

**Implementer: Sol (hard).**

- Keep owner/admin, owned-custody, idle-only, no-active-turn, no-compaction, and single-reset lease checks. Add a unique Act-frame ref to each request and return a correlated member result on success or the same ref on error; reuse the existing management correlation shape instead of inferring success from any member object change or a room-wide error counter.
- Make Claude, Codex, ACP, and first-party CLI retirement bounded. Gracefully interrupt and close first, escalate only after a short deadline where a child process is owned, confirm the old runtime can no longer write, then atomically clear session/task/credential context while preserving identity, channel history, configuration, usage, spend, and queued delivery. If retirement cannot be made safe, return a correlated error and preserve the old session reference—never report a false clear.
- A successful reset releases the lease and starts already-queued work as a genuinely fresh session. Failure, timeout, client disconnect, daemon restart, repeated click, and two agents clearing concurrently must leave no dead promise or stuck lease.

### C2 — small confirmation and background spinner

**Implementer: Luna (contained UI/accessibility work).**

- Replace the blocking alert modal with a small anchored confirmation popover below the clear icon. Confirm dispatches once, closes the popover immediately, and changes only that member's clear icon to the existing compact spinner pattern; the rest of the room, composer, other agents, and menus remain usable.
- Settle the spinner only from the matching correlated success or error. On success the cleared session control disappears until the next native session is created. On failure show a small member-local error/retry affordance without reopening or blocking the page. Preserve keyboard focus, Escape/outside-click cancellation before dispatch, mobile bounds, and Axe.

## Integration and merge order

1. Create a dedicated integration worktree/branch from current `main`; never merge feature branches directly from their implementation worktrees.
2. Implement, review, and no-ff merge Worktree 1. Create Worktree 2 from that accepted merge; repeat sequentially for Worktrees 3 and 4. This deliberately trades parallelism for smaller, predictable diffs in shared protocol, daemon, and web files.
3. For each phase, Investigator reviews the exact diff, Harn truth and anchors, failure paths, focused tests, and clean worktree. Material issues return to the same implementer as a new contained review-fix plan and commit. The next phase starts only after acceptance.
4. After all feature merges, create one post-merge reconciliation Harn plan only for real overlap. Expected shared seams are `protocol/ws`, `switchboard/daemon` and `server`, web store/connector, and room styles. Resolve additively and add cross-feature regressions: scheduled delivery after reconnect, reset while schedules exist, compaction reinjection containing the new workflow, and official update preserving schedules, roster, and cached state.
5. Final gates: full recursive build, serialized workspace tests, complete isolated Playwright, release/license audits, deployment/workflow checks, fresh install, packed/offline install, previous-stable-to-candidate `codor update` on Linux/macOS/Windows service fixtures, npm TGZ `npx` proof, Harn/provenance, exact merge parents, and clean tree. Only then push `main`, deploy, publish, and prepare artifacts under a separate explicit release instruction.

## Channel-agent handoff workflow

Investigator sends one tagged assignment containing the worktree, branch/base, locked plan id, phase scope, required tests, and these rules:

1. Do not delegate internally.
2. Do not monitor Investigator or any other active member.
3. Do not post routine play-by-play. Continue autonomously within the locked plan.
4. For a genuine scope blocker, tag Investigator once with the exact Harn boundary and evidence, then stop.
5. On completion, tag Investigator once with commit, changed files, exact tests, Harn result, and clean-tree status; do not push, merge, deploy, release, or start the next phase.

Normal channel final responses already post automatically. If an implementer must report from a shell or outside that response path, use:

```sh
codor post --channel codor-main '@investigator Phase X complete. Commit: <sha>. Tests: <exact results>. Harn: <result>. Worktree: clean.'
```

Do not add `--wait` to a completion report. `codor post --wait` is reserved for one genuinely blocking direct question; it is not a way to poll an active reviewer or implementer.

## Explicit exclusions

- No immediate manual XPS recovery or manual service restart as acceptance.
- No relay Worker, Durable Object, or tunnel protocol redesign.
- No hydration unsubscribe system; background rooms retain live subscriptions.
- No full offline archive, cached credentials or binaries, or queued offline sends.
- No recurring schedules, cron builder, external scheduler, or notification redesign.
- No global message formatting change for the Codex separator.
- No destructive context reset before the old runtime is safely retired.
- No parallel implementation in shared worktrees and no direct feature-branch push to `main`.
