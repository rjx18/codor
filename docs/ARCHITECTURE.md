# Architecture

## Topology

```text
                        ┌─────────────────────────── your machine(s) ─┐
   web (browser)  ──┐   │  ┌──────────────────────────────┐           │
                    │   │  │  switchboard (daemon)         │           │
   iPhone app  ─────┼──▶│  │  · rooms + message store      │  spawns/  │
                    │   │  │  · mention router             │  resumes  │
   Apple Watch ──┐  │   │  │  · member lifecycle           │──────────▶│ claude -p / Agent SDK
   (via phone or │  │   │  │  · event journal (run blobs)  │           │ codex exec --json
    push relay)  │  │   │  │  · WS/REST API                │◀──────────│ (harness CLIs, local)
                 │  │   │  └───────┬──────────────┬───────┘           │
                 │  │   │          │adapters      │transports          │
                 │  │   │   claude-code  codex    │· tailnet WS (tier 0)│
                 │  │   │   (+ACP, +yours)        │· hyperswarm DHT P2P │
                 │  │   └─────────────────────────┼──────────(tier 1)──┘
                 │  └── tailnet / LAN ────────────┘
                 └────── APNs (ciphertext only) ── push relay (self-hostable, tier 2)
```

One switchboard per machine. MVP: one machine. Post-MVP: switchboards peer over the same
transports and a room can span hosts (each member is owned by exactly one switchboard — the
`Member.host` field exists from day one so this needs no schema change).

## Components

### `switchboard` — the daemon

Single Node/TypeScript process (Bun-compatible; plain Node for widest reuse). Owns:

- **Room store** — SQLite via better-sqlite3: `rooms`, `members`, `messages`, `deliveries`
  (the per-member FIFO inboxes), `budgets`. Run event streams are **JSONL blobs on disk**
  (`~/.partyline/rooms/<room>/runs/<msg-id>.jsonl`), referenced by `RunSummary.events_ref` —
  the DB stays small and the "one message per run" rule is structural.
- **Router** — implements PROTOCOL §3 exactly (segmentation, refs, defaults, fan-out, batching,
  hop/spend guards). Pure function over (message, room state) → deliveries; unit-test heaven.
- **Adapter host** — spawns/attaches harness sessions as child processes, supervises them,
  journals their events, marks members `dead` on crash (with a `system` message + push), and
  resumes them by `session_ref` on switchboard restart. Sessions are the durable thing;
  processes are cattle.
- **API** — one WebSocket (subscribe/post/act) + small REST (pairing, history pages, blob
  fetch). Same API for all three surfaces and for the `partyline` CLI.

### Adapters

```ts
interface HarnessAdapter {
  id: string                                  // 'claude-code' | 'codex' | …
  spawn(opts: {cwd, model?, policy?}): Session       // new session
  attach(session_ref: string): Session               // adopt an existing one
  deliver(s: Session, payload: string): AsyncIterable<PartyEvent>   // one turn
  interrupt(s: Session): void
  capabilities: {ask: boolean, approvals: 'runtime'|'spawn-time', extensions: boolean}
}
```

- **claude-code**: preferred driver is the **Claude Agent SDK** (`query({resume, canUseTool})`) —
  gives streaming events, ask-user, and runtime permission callbacks (→ `approval.raised`) with
  no subprocess parsing. Fallback: `claude -p --resume <id> --output-format stream-json`.
  Extensions: observed via Task tool-call events in the parent stream, enriched by hooks
  (`SubagentStop`) + transcript-JSONL tailing when available.
- **codex**: drives `codex exec --json [--sandbox <policy>] resume <rollout-id> "<payload>"` —
  the exact pattern proven in months of manual use. Flags precede the subcommand (learned the
  hard way). Approvals are spawn-time sandbox policy → rendered as the member's policy chip.
- **ACP (evaluate in M0)**: Zed's Agent Client Protocol already standardizes "drive a coding
  agent over JSON-RPC" and has maintained adapters (Claude Code today, more coming). If the
  spike holds up, our adapters become thin ACP clients and third-party harness support is
  mostly free. Decision gate: does ACP expose resume + usage + subagent visibility well enough?
  If not, direct CLI drivers stay and ACP becomes a fourth adapter.

### Session ownership: owned vs. mirrored

The one genuinely hard lifecycle problem. A session sitting in an interactive TUI cannot *also*
be driven headlessly — two writers, one context.

- **Owned** (default): the switchboard holds the session; every turn goes through `deliver()`.
  Spawned-from-room members are always owned.
- **Mirrored**: `/partyline join` from inside a *live* TUI session registers the session
  (id + harness + cwd) with the switchboard over a local unix socket. While the TUI runs, the
  member is read-mostly: hooks/notify streams mirror its activity into the room
  (Claude Code: hooks; Codex: `notify` config + session-file tailing), and inbound deliveries
  **queue** with a nudge shown in the room ("mirrored — deliveries wait for the operator's
  terminal"). When the TUI exits, the switchboard **adopts** the session via `attach()` and the
  queue drains. Same member, seamless custody transfer — that's why `session_ref` is the
  identity anchor, not the process.

### Surfaces

- **Web** (`@partyline/web`): React + Vite SPA served by the switchboard itself. Room list,
  timeline with collapsible runs, composer with @/# autocomplete + implied-recipient indicator,
  member rail (state, policy chip, spend), ask/approval cards, budget banner. No SSR, no
  framework ceremony — it's a LAN/tailnet tool.
- **iPhone** (SwiftUI): same WS API. Pairing via QR (device keypair, PRIVACY §pairing). Rooms,
  notifications, ask/approval actions, dictation composer.
- **Apple Watch** (SwiftUI, started from claude-watch's design): three screens — inbox
  (messages addressed to you, asks, approvals, budget holds), room glance (who's running, spend
  today), and reply (dictation → composer with a recipient picker defaulting per PROTOCOL §3.5).
  Connectivity: via the paired iPhone (WatchConnectivity) when phone is reachable; else via
  push relay for alerts + standalone WS to the switchboard *only if* the watch can reach it
  (LAN). watchOS cannot run a tailnet client — the phone is the watch's tailnet on-ramp; this
  is a hard platform constraint, not a design choice.
- **CLI** (`partyline`): join/spawn/list/post/tail. Also the thing the Codex-side skill shells
  out to.

### The `/partyline` skill

Claude Code skill (and an AGENTS.md snippet for Codex) so a live session can self-register:
`/partyline join traderjoe-eng --as planner`. The skill just calls the local CLI, which talks to
the unix socket — no HTTP, no tokens on disk beyond the socket's filesystem permissions.

## Reuse-first build map

The standing rule: **depend** where an artifact fits, **fork/vendor** where we need to bend the
source, **pattern** where we take the design but the code doesn't transplant. License column is
verified in M0 before any code lands (unverified entries marked ⚠).

| Component | Reuse | Mode | Notes |
| --- | --- | --- | --- |
| Claude session driving | `@anthropic-ai/claude-agent-sdk` | depend | resume, streaming, canUseTool, ask-user |
| Codex session driving | `codex` CLI (`exec --json`, `resume`) | depend | subprocess; proven pattern |
| Harness normalization | Zed ACP (`agent-client-protocol` + `claude-code-acp`) | depend (spike) | M0 gate; may replace bespoke drivers |
| P2P transport | `hyperswarm` (+ DHT, Noise) — walkie's stack ⚠ | depend; walkie as pattern/vendor | `line:secret` → DHT topic, exactly walkie's channel model; reuse walkie's `listen()/send()` lib if license allows, else hyperswarm directly |
| Tailnet access | Tailscale (user-supplied) + `tailscale serve` for TLS | depend | zero code: bind the tailnet IP |
| Watch/phone bridge | claude-watch ⚠ | fork | SwiftUI watch app + phone relay + SSE bridge; rework bridge → our WS protocol |
| Multi-surface daemon shape | Paseo ⚠ | pattern | daemon/WS/pairing shape; per-agent model differs too much to fork |
| E2EE primitives | libsodium (`sodium-native`) / Noise via hyperswarm | depend | never hand-rolled; MLS (OpenMLS) only if multi-party keys outgrow sealed-box fan-out |
| Encrypted push | Matrix `sygnal` pattern; NSE decrypt on device | pattern (gateway is ~200 lines) | see PRIVACY §push; consider `ntfy` where APNs isn't required |
| At-rest encryption | SQLCipher (optional) | depend | off by default on encrypted disks |
| Storage | better-sqlite3 + JSONL blobs | depend | boring on purpose |
| Web UI | React + Vite; chat primitives from an MIT kit if one fits | depend | timeline/composer are commodity; run-message rendering is ours |
| Voice | Apple SFSpeechRecognizer / watch dictation | platform | on-device toggle, PRIVACY §voice |

What we actually write: **the router, the member/lifecycle model, two thin adapters, the run
journal, and the surfaces' room-rendering.** Everything else is glue around the table above.

## Monorepo layout

```text
partyline/
  packages/protocol/      # zod schemas: Member, Message, PartyEvent, deliveries
  packages/switchboard/   # daemon: store, router, adapter host, WS/REST
  packages/adapters/      # claude-code/, codex/, acp/ (spike)
  packages/cli/           # partyline join/spawn/post/tail
  packages/web/           # React SPA
  apps/ios/               # SwiftUI iPhone + Watch targets (Mac/Xcode only)
  relay/                  # push relay (self-hostable, tiny)
  skills/                 # /partyline Claude Code skill; AGENTS.md snippet for Codex
  docs/
```

pnpm workspaces; no build framework beyond tsc/vite. iOS lives in-repo but builds only on a Mac
(Xcode 16+); nothing else depends on it.

## Failure behavior

- Harness process dies mid-run → run message finalized `failed`, member `dead`, system message +
  push; member resurrectable via `attach(session_ref)` (one tap: "revive").
- Switchboard restart → resumes all owned members from `session_ref`s, replays nothing (turns
  are atomic: a delivery is marked consumed only when `run.completed` lands; a turn cut off
  mid-flight is retried once, then held for the operator — never silently double-delivered).
- Surface offline → clients are caches; on reconnect they page missed history via REST. Push
  relay down → notifications degrade, room state unaffected.
- Clock: message ids are the ordering truth (per-room monotonic, assigned by the single owning
  switchboard); timestamps are display-only. Cross-host rooms order by (host lamport, id) —
  post-MVP detail, schema-ready.
