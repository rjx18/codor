# Smooth Codor.app Startup, Official Update, Runtime Convergence, and Roster Setup Plan

**Goal:** Make a paired codor.app tab show useful channel state immediately, converge automatically when a computer comes back, and avoid paying unnecessary relay work before the operator can read or use the active channel.

**Scope:** One worktree with three separately locked Harn implementation phases: hosted startup/performance, official update/service convergence, then the contained roster setup UI. It does not redesign the relay Worker, Durable Object, tunnel wire protocol, server storage, or account model.

## Confirmed causes

1. **Late active sessions never enter the page.** `ComputerSessionManager.start()` waits at most eight seconds for the active connector. `main.tsx` then chooses a fullscreen recovery card once. The manager keeps retrying, but the root bootstrap does not subscribe to later readiness. The recovery list excludes the active computer, so it becomes visibly available only after another computer is selected. This explains the reported “XPS never appears, then flips online after I click another machine” behavior.
2. **Hosted startup repeats serial relay requests.** A normal managed launch performs a tunnel handshake, two device-session HTTP requests, a room-summary request owned by the manager, then another compatibility request and another room-summary request from `main.tsx`. The latter two add relay latency but do not add managed-session truth: the connector already enforces the browser protocol and the manager already owns the authorized room summaries.
3. **An individual tunneled HTTP stream can wait forever.** `TunnelClient.fetch()` rejects when the whole tunnel dies but does not honor `RequestInit.signal`. A stalled auth or room-summary stream on an otherwise connected tunnel can therefore keep one computer connectorless indefinitely.
4. **Every connector cold-hydrates every room.** All computers correctly start concurrently, but each app socket subscribes every listed room with a 20-message hydrate. Relay latency and payload amplify this fan-out even though only one room per computer needs a readable cold transcript immediately.
5. **There is no persisted chat fallback after refresh.** Room state is memory-only. After a real page reload, the browser has pairing records and the app shell but no transcript to show. During a mid-session drop the room remains mounted initially, but the recovery overlay becomes modal/inert after six seconds and blocks the retained transcript.
6. **A runtime update can leave the old daemon resident.** On the observed XPS, the installed runtime is 0.10.11 and its service definition was rewritten on August 10, but the live Codor process has remained resident since August 7. Static web files are read from the replaced runtime on demand, so the browser can run the new UI against an old in-memory switchboard. That split explains both the default-roster request failure and the new CLI management request timeout: Linux `systemctl enable --now` does not restart an already-active service. Setup must converge the resident process after replacing or reselecting its runtime, not merely update files and confirm that some older daemon still answers.
7. **Default-roster UI conflates absence with failure.** A successful empty roster is currently rendered as a selectable “no starting agents” roster, while any preset/roster read failure becomes the same red Retry card. An empty group needs setup guidance, not selection; a real request failure still needs an honest retry path.
8. **There is no official self-update command.** `codor install`/`setup` can copy the runtime that invoked it, but an installed launcher cannot resolve the current stable npm release, run that release's updater, atomically replace the durable runtime, restart the resident service, and prove the new generation is answering. This is the supported XPS/macOS acceptance path; no manual restart is part of the fix.

## Worktree phases

### Phase R1 — hosted startup, payload, cache, and transcript stability

### 1. Make managed boot reactive and reuse manager-owned results

- Mount one small managed bootstrap shell that subscribes to `ComputerSessionManager` instead of awaiting it once and selecting a terminal screen.
- Hydrate the active computer's last-good local snapshot immediately when present. When the live entry becomes ready—whether before or after eight seconds—activate it and replace cached state in the same document, without a click or reload.
- Preserve the concurrent start of every paired computer and warm in-place switching.
- In hosted/managed mode, treat the manager's authenticated token, room summaries, selected public root, connector, and connector-level upgrade frame as the bootstrap result. Do not repeat `checkBrowserCompatibility()` or `resolveAuthorizedRooms()` from `main.tsx`. Direct/Tailscale boot keeps its current compatibility and room-resolution path.
- Keep a bounded wait only as the point where the UI changes from “Connecting” to cached/recovery presentation; it must never stop the manager or make later readiness invisible.

### 2. Bound stalled tunnel requests

- Make `TunnelClient.fetch()` honor `RequestInit.signal`: remove listeners on settlement, reset the stream, and reject exactly once on abort.
- Give each manager authentication and room-summary attempt one short deadline. A timeout retires/restarts that entry's owning tunnel generation so all work on the stale mux rejects and the existing retry loop advances.
- Do not alter authenticated bytes, alias failover, keepalive, generation ownership, app-socket readiness, or auth/upgrade/manual parks.

### 3. Hydrate background rooms cheaply

- Permit `hydrate_limit: 0` as an explicit browser cold-subscription request. It still returns room, roster, inbox, meter, support, cursor, and `sync_complete`, but no historical message tail.
- On a new app socket, subscribe the current/desired rooms with the existing 20-message limit and all other listed rooms with zero messages. Their live frames and room-support updates continue to feed unread, attention, and working summaries.
- When a zero-hydrated room becomes current, explicitly promote it once with a cold 20-message hydrate; the combined transcript-history page remains the sole finalized-history source. Do not add unsubscribe/resubscribe protocols or a new notification channel.
- Preserve same-room-ID isolation across computers, current-generation readiness, seq-based warm replay, actionable interactions, and live mutable runs.

### 4. Keep one bounded last-good room readable while reconnecting

- Add a small hosted-only IndexedDB cache, separate from CacheStorage and credentials, keyed by computer. Store only that computer's last active public room: its room summaries/room metadata and the latest successfully materialized combined-history page (at most 20 visible units plus the projected messages/journal excerpts needed to render them).
- Never persist drafts, tokens, room keys, attachments or voice bytes, full journals, search archives, inbox deliveries, pending interactions, or more than one room per computer. Cache writes occur only after successful authenticated materialization.
- On reload, hydrate that snapshot as disconnected/read-only before network startup. It is a last-good projection, not new history authority; a current combined page and current socket frames replace/reconcile it after reconnect.
- Forgetting a computer deletes only its snapshot. Full unpair keeps deleting every `codor-*` IndexedDB database. The service worker remains app-shell-only and never caches REST/WebSocket data.
- If retained or cached content exists, ordinary offline/reconnecting state must not make the page inert or replace it with a modal. Show one small floating `Reconnecting…` pill at the top, preserve scroll/search/copy and draft text, and disable all mutating controls—including Send—until current server evidence restores readiness. Do not queue offline sends.
- Keep the fullscreen recovery card only when there is no renderable snapshot/retained room, the browser was never paired, or a terminal repair/upgrade state cannot be represented safely. Warm alternative computers remain selectable.

### 5. Give the transcript one pre-paint tail-follow owner

- Preserve the bottom position synchronously when a pinned transcript's content height changes; do not defer the correction to a later animation frame that can expose one paint at the old scroll position between live output batches.
- Observe the transcript viewport as well as its content column. When a multiline composer grows or shrinks the flex layout, a pinned transcript follows the new true bottom before paint. An unpinned reader keeps the same visible anchor and is never pulled to the tail.
- Keep the sticky working indicator, its visible composer gap, history prepend anchoring, jump-to-latest, and eight-row composer cap unchanged. Do not introduce global window scrolling or another competing observer.

### Phase R2 — add `codor update` and converge the installed service

- Add `codor update` as the packaged-install self-update command. It resolves the stable `@richhardry/codor` npm dist-tag, compares it with the installed durable runtime, and does nothing when already current.
- Keep acquisition and application separate: the old CLI starts npm without a shell to acquire the exact resolved release, then invokes a private update entrypoint from that new package. The new package reuses the existing staged-copy/backup/atomic-swap runtime installer with explicit update intent, rewrites the platform service against the new durable runtime, restarts that service, and verifies the reported runtime version before declaring success.
- Do not rerun first-install onboarding, mint a new pairing code, or alter access/relay choices. Preserve the data directory, token, relay identity, pairing records, channels, worktrees, presets, roster, agents, and logs. A fetch, staging, restart, or readiness failure must leave or restore the old durable runtime and emit a direct recovery diagnostic.
- Restrict the first cut to the official stable npm package. Source checkouts receive a clear “update with Git” refusal; arbitrary package URLs, automatic prerelease selection, background updates, and auto-restart without an operator command stay out of scope.
- On the first Start-service attempt of each real `codor setup` run, make every supported service manager load the runtime that setup just selected: Linux must restart the user service rather than treating `enable --now` on an already-active unit as an update; Windows must stop an already-running scheduled task before starting the rewritten task. Retry inside the same setup run remains idempotent and must not restart a daemon that already passed readiness.
- Make macOS launchd convergence state-driven rather than timing-lucky: wait boundedly for `bootout` to make the old target absent, bootstrap one new target, and if launchd reports the target loaded during a transient bootstrap error, give that new job a bounded readiness window before unloading it. Do not immediately kill a loaded-but-still-booting daemon or unconditionally `kickstart -k` a job that bootstrap already started; only tear down and retry after the loaded job fails its bounded health window.
- Run the existing bounded readiness proof only after that restart. Preserve the durable data directory, operator token, relay identity, pairing state, channels, and member recovery; this is process convergence, not reset or reinstall of user state.

### Phase R3 — guide default-roster setup without a false error

- Treat a successfully loaded empty roster as a normal unconfigured state. Do not offer it as a selectable zero-agent roster and never send `default_roster:true` from that state. Show a small neutral explanation and a clear “Set up in Settings” action wherever an existing channel can reach the already-mounted Settings surface; first-channel onboarding explains that setup becomes available after the first channel exists.
- In Settings, turn the empty preset/roster state into a short concrete sequence: create a reusable agent preset, add it to Default roster, then save. If presets exist but the roster is empty, start at the add-and-save step. Keep the real list/editor controls in place rather than introducing a wizard or new storage model.
- Keep transport/auth/schema failures distinct from empty configuration. A failed read retains Starting agent and shows a concise Retry error; successful reload transitions to either setup guidance or the selectable ordered roster. Preserve admin/owner authorization, hosted active-computer routing, starting-agent draft restoration, worktree creation, and atomic roster replacement.

## Verification and acceptance

- **Late readiness:** hold active XPS past the eight-second UI boundary, then release it. The same page must enter XPS automatically with no click/reload; alternatives remain warm.
- **Cold cached reload:** with one successful prior room visit, take the host down and reload. The transcript/rail must render from local storage within one second with a floating reconnecting pill; mutations stay disabled; host return replaces cached truth automatically.
- **No false availability:** cached content always starts disconnected. WebSocket OPEN alone never enables Send; only a current server frame does.
- **Hosted request budget:** instrument a healthy one-computer launch and assert one device challenge, one device session, one manager room-summary request, no duplicate bootstrap compatibility/summary request, one app socket, and one combined-history head request for the selected room.
- **Background payload budget:** for many rooms and several computers, assert only current/desired rooms receive a 20-message hydrate and newly listed background rooms receive zero historical messages while unread/attention/working signals continue updating. Promoting a room hydrates it once.
- **Stall recovery:** abort or hang auth/summary streams while the tunnel remains open; each attempt must settle within its deadline, retire only its generation, and retry without parallel app/tunnel sockets.
- **Stable tail geometry:** while pinned, stream output in controlled batches and grow/shrink the composer through several lines; sample every animation frame and require the transcript to remain at the true bottom with no visible intermediate jump. While deliberately scrolled up, both changes must preserve the same visible unit offset.
- **Runtime convergence:** install/update over a running older Linux, macOS, and Windows service fixture. Exactly one successful replacement generation must occur on the first Start attempt, the readiness probe must observe the selected runtime, and an in-run Retry after readiness must not restart again. On macOS, model delayed bootout, bootstrap exit-5 with a loaded-but-not-yet-healthy target, eventual health, and genuine failed-load retry; no valid boot may be killed merely because its first probe was early. Persisted rooms, relay identity, and token paths remain unchanged.
- **Official update journey:** install the previous stable package on Linux/WSL, macOS, and Windows fixtures, keep its daemon running, serve a candidate through a controlled npm fixture, and run only `codor update`. Assert the package is acquired once, the runtime and launcher report the candidate version, exactly one replacement service generation answers the version/readiness probe, existing pairing/channels/relay identity remain, and candidate-only browser/CLI routes work without a manual restart. Exercise already-current, offline registry, corrupt staging, failed restart with rollback, and source-checkout refusal.
- **Roster setup:** an authoritative empty roster is calm, unselectable, and links an existing channel to the mounted Settings setup instructions without reconnecting. Creating a preset, adding it, and saving makes the roster selectable on return. A 503/auth/schema failure remains a genuine Retry state and never blocks Starting agent; hosted calls stay on the active computer.
- **Isolation and purge:** identical room IDs on two computers must never share snapshots, tokens, state, or cursors. Forget deletes one computer's snapshot; unpair deletes all local Codor state.
- **Regression matrix:** direct/Tailscale startup and foreground behavior unchanged; auth/revocation/upgrade/manual parks unchanged; foreground watchdog remains refresh-neutral; live runs remain unbounded; finalized history still comes from combined pages; PWA shell offline; Rooms 5/11/21/25 transcript geometry/history, Rooms 27/32/33 recovery, Rooms 34/35 multi-computer/startup, all web units, protocol/switchboard subscribe tests, production build, Axe, Harn checks.
- Record browser timings and request/payload counts for direct and hosted runs in the handoff. Use deterministic harness controls for latency and stalled streams; do not make machine-time latency a brittle CI assertion beyond the one-second cached-render budget.

## Explicitly out of scope

- Relay Worker/Durable Object or tunnel-wire redesign.
- Cloud registry, pooling, server migrations, or a persistent server history index.
- Full offline archive/search, cached attachments/voice, offline agent state, or queued offline posts.
- Service-worker runtime caching of authenticated data.
- Loading every channel transcript at startup.
- UI redesign beyond the small reconnecting pill and recovery behavior needed to keep cached chats usable.
- A roster wizard, multiple named rosters, preset import/export, or automatic roster creation.
- Background auto-update, arbitrary update URLs, prerelease-channel selection, or a second runtime installer.
