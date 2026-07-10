# Architecture

## Topology

```text
                        ┌─────────────────────────── your machine(s) ─┐
   web (browser)  ──┐   │  ┌──────────────────────────────┐           │
                    │   │  │  switchboard (daemon)         │           │
   iPhone app  ─────┼──▶│  │  · rooms + message store      │  spawns/  │
                    │   │  │  · mention router             │  resumes  │
   Apple Watch ──┐  │   │  │  · member lifecycle           │──────────▶│ claude -p (stream-json)
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

One switchboard per machine. MVP: one machine. Multi-box rooms (M2+) follow the model in
§Multi-box below — one *home* switchboard per room, members resident wherever their session runs.

## Components

### `switchboard` — the daemon

Single Node/TypeScript process (Bun-compatible; plain Node for widest reuse). Owns:

- **Room store** — SQLite via better-sqlite3: `rooms`, `members`, `messages`, `deliveries`
  (the per-member FIFO inboxes), `budgets`. Run event streams are **JSONL blobs on disk**
  (`~/.wireroom/rooms/<room>/runs/<msg-id>.jsonl`), referenced by `RunSummary.events_ref` —
  the DB stays small and the "one message per run" rule is structural.
- **Router** — implements PROTOCOL §3 exactly (recipient selection from mentions, whole-message
  payloads, ref resolution, defaults, fan-out, batching, the opt-in brakes). Pure function over
  (message, room state) → deliveries; unit-test heaven.
- **Adapter host** — spawns/attaches harness sessions as child processes, supervises them,
  journals their events, marks members `dead` on crash (with a `system` message + push), and
  resumes them by `session_ref` on switchboard restart. Sessions are the durable thing;
  processes are cattle.
- **API** — one WebSocket (subscribe/post/act) + small REST (pairing, history pages, blob
  fetch). Same API for all three surfaces and for the `wireroom` CLI.

### Adapters

```ts
interface HarnessAdapter {
  id: string                                  // 'claude-code' | 'codex' | …
  spawn(opts: {cwd, model?, policy?}): Session       // new session
  attach(session_ref: string): Session               // adopt an existing one
  deliver(s: Session, payload: string): AsyncIterable<WireEvent>   // one turn
  respondInteraction(s: Session, interaction_id: string, answer: unknown): Promise<void>  // resolves on ack
  interrupt(s: Session): void
  discoverSessions(): SessionRef[]
  capabilities: {resume: boolean, discover: boolean, interactiveAttach: boolean,
                 ask: boolean, approvals: 'runtime'|'spawn-time', extensions: boolean}
  // no `resume` ⇒ one-shot ephemeral members only (no revive/join/attach), surfaced as such
}
```

Design rule: **adapters drive plain CLIs, never SDKs.** An agent in Wireroom runs exactly as it
would in your terminal — a normal subprocess in a shell runtime, addressed over stdin/stdout.
This keeps every harness loosely coupled and identically shaped (spawn a process, write JSONL,
read JSONL), which is also what makes new harnesses cheap and native-resume/jump-in trivial.

- **claude-code**: drives `claude -p --resume <session-id> --output-format stream-json
  --input-format stream-json --verbose` — the same wire protocol the Agent SDK wraps, spoken
  directly. Events, `AskUserQuestion`, and runtime permission prompts all arrive as JSONL on
  stdout (control requests answered on stdin). **`--permission-prompt-tool stdio` is the
  enabler, not a fallback** (probed, P0.2): without it the control-request path is off and
  AskUserQuestion isn't even offered to the model. Extensions:
  **`SubagentStart`/`SubagentStop` hooks are authoritative** (injected via `--settings`,
  reporting agent id + transcript path); Task/Agent tool-call stream events only enrich.
- **codex**: drives `codex exec --json [--sandbox <policy>] resume <rollout-id> "<payload>"` —
  the exact pattern proven in months of manual use. Flags precede the subcommand (learned the
  hard way). Approvals are spawn-time sandbox policy → rendered as the member's policy chip.
- **ACP — evaluated in M0 (P0.2), verdict: NO for driver replacement.** Decision gate was
  resume + usage + subagent visibility. Findings: resume exists (`session/load` +
  `session/resume`, optional; `claude-agent-acp` implements both across process restarts);
  usage is a session-cumulative `usage_update` notification with optional cost — per-turn
  token itemization is still a Draft RFD; **subagent visibility is absent by design** (no
  schema types, and the reference Claude adapter deliberately filters subagent traffic out).
  Codex has only a third-party (JetBrains) adapter, `codex-acp`. Direct CLI drivers stay;
  ACP (Apache-2.0) remains a candidate FOURTH adapter for harnesses we don't drive natively.

<!-- harn:assume adapter-registry-sole-harness-source ref=acp-final-verdict -->
**M5 final revisit:** the configured adapter registry now gives an ACP implementation the same
trusted third-party module boundary as any other harness, but the driver verdict remains **NO**.
Registry hot-swap fixes installation, not ACP's coarse cumulative usage or absent subagent model.
An external ACP-backed adapter may register without a core patch only when it reports those
reduced capabilities honestly; no ACP dependency enters the built-in data plane.
<!-- harn:end adapter-registry-sole-harness-source -->

### Session ownership: owned vs. mirrored, in both directions

The one genuinely hard lifecycle problem. A session sitting in an interactive TUI cannot *also*
be driven headlessly — two writers, one context. So custody is explicit, and it transfers **both
ways** — the layers stay loosely coupled: a session is just a harness-native artifact
(`session_ref`), and the switchboard, your terminal, and the room are all merely clients of it.

- **Owned** (default): the switchboard holds the session; every turn goes through `deliver()`.
  Spawned-from-room members start owned.
- **Mirrored — joining from a terminal**: `/wireroom join` from inside a *live* TUI session
  registers the session (id + harness + cwd) with the switchboard over a local unix socket.
  While the TUI runs, the member is read-mostly: hooks/notify streams mirror its activity into
  the room (Claude Code: hooks; Codex: `notify` config + session-file tailing), and inbound
  deliveries **queue** with a nudge shown in the room ("mirrored — deliveries wait for the
  operator's terminal"). When the TUI exits, the switchboard **adopts** the session via
  `attach()` and the queue drains.
- **Jumping into a member — the reverse**: `wireroom attach <member>` (or a "jump in" button in
  the web UI showing the command) makes the switchboard finish/hold the member's current turn,
  release custody, and hand you the harness's native resume — `claude --resume <session-id>` /
  `codex resume <rollout-id>` — in your terminal. You're now driving the *same session the room
  has been driving*, full TUI, full context. The member shows as mirrored while you work; when
  you exit, the switchboard re-adopts and drains the queue.

Same member, same context, custody moving freely between room and terminal — that's why
`session_ref` is the identity anchor, not the process.

### Surfaces

- **Web** (`@wireroom/web`): React + Vite SPA served by the switchboard itself — there is no
  hosted web app; the "server side" of the web surface *is* your box. Room list, timeline with
  collapsible runs, composer with @/# autocomplete + implied-recipient indicator, member rail
  (state, policy chip, spend), ask/approval cards, budget banner. No SSR, no framework ceremony.
  Access paths: `tailscale serve` is the zero-config baseline (`https://desk.<tailnet>.ts.net`,
  automatic TLS); for teams that want a memorable custom domain with centralized ACL control,
  the documented setup is a **Tailscale app connector** (policy-file grants + a connector node
  routing the app domain across the tailnet). The browser holds only a cache: history pages in
  over REST, live updates over the WS, reconnect delta-syncs from the room change-log cursor
  (`since_seq` — message ids can't express in-place run finalizations).
- **iPhone** (SwiftUI): same WS API. Pairing via QR (device keypair, PRIVACY §pairing). Rooms,
  notifications, ask/approval actions, dictation composer.
- **Apple Watch** (SwiftUI, started from claude-watch's design): three screens — inbox
  (messages addressed to you, asks, approvals, budget holds), room glance (who's running, spend
  today), and reply (dictation → composer with a recipient picker defaulting per PROTOCOL §3).
  Connectivity: via the paired iPhone (WatchConnectivity) when phone is reachable; else via
  push relay for alerts + standalone WS to the switchboard *only if* the watch can reach it
  (LAN). watchOS cannot run a tailnet client — the phone is the watch's tailnet on-ramp; this
  is a hard platform constraint, not a design choice.
- **CLI** (`wireroom`): join/spawn/attach/list/post/tail. Also the thing the Codex-side skill
  shells out to.

### The `/wireroom` skill

Claude Code skill (and an AGENTS.md snippet for Codex) so a live session can self-register:
`/wireroom join traderjoe-eng --as planner`. The skill just calls the local CLI, which talks to
the unix socket — no HTTP, no tokens on disk beyond the socket's filesystem permissions.

### The ledger

Per-room shared memory (PROTOCOL §6): an Obsidian-compatible markdown vault under
`~/.wireroom/rooms/<room>/ledger/`, bootstrapped by the switchboard (folders + note templates)
when enabled. The switchboard watches it (fs events), posts change notices to the room, resolves
`[[name]]` refs at delivery time, and serves notes + a link-graph JSON over the API so surfaces
can render a graph view. Deliberately just files: agents edit them like any other file, humans
open the same directory in Obsidian, and an optional temporal-graph indexer (Graphiti) can sit
on top later without owning the data.

### Multi-box: room home vs. member residency

The two concepts multi-machine setups must not conflate:

- **Every room has exactly one home switchboard.** The home assigns message ids, stores the
  history and run blobs, hosts the ledger vault, and runs the router. If the home box is off,
  the room is down — deliberate, the same deal as any self-hosted service. Put a room's home on
  the box that's always on (the desk box), not the laptop.
- **Members reside wherever their session runs** (`Member.host`). A room homed on the desk can
  have `coder` running on the desk and `gpu-runner` on the lab box: the home switchboard sends
  each delivery to the member's resident switchboard over the wire (tailnet WS or hyperswarm),
  the resident runs the turn locally against its own harness CLI, streams normalized events
  back, and the home journals them. Adapters never span machines; payloads and events do.
- **The ledger lives on the home box only.** No shared filesystem, no sync conflicts — remote
  members never need the vault mounted, because `[[name]]` refs are resolved by the *home*
  router at delivery time and travel inside the payload. Remote reads/writes go through
  `wireroom ledger …`, which routes to the home switchboard; `wireroom ledger pull` can drop a
  read-only snapshot locally for browsing in Obsidian.
- **Offline peers hold, never drop.** A member whose resident switchboard is unreachable shows
  `unreachable`; its deliveries queue at the home and drain on reconnect — same semantics as a
  busy member.

So: a room/workspace is *anchored to* one machine but not *confined to* it. If you want fully
independent workspaces per machine, simply home different rooms on different boxes.

### Bridges (Slack, Telegram) — optional, eyes open

Partyline surfaces parties in Slack; Wireroom supports the same as an explicit **bridge**: a
small process that is just another API client, pairing a room with an external channel. It
mirrors room traffic outward and posts inbound platform messages as bridge-relayed human
messages (`via slack: @sarah`), with mentions and `#N` refs working normally. Slack first;
Telegram is the same interface (and closer to home for solo operators); Discord etc. are
community territory. The privacy contract is explicit: **bridging a room knowingly exports that
room's content to the platform's servers** — enabling it is an owner/admin action, the room
wears a permanent "bridged" banner, and PRIVACY.md's guarantees are marked void for bridged
content. The default remains unbridged.

### Access control (orgs and roles)

Multi-human rooms carry partyline-style org access control — without accounts. An **org** is a
namespace on the switchboard with an org signing key; humans join by QR/invite link (their
device pubkey gets enrolled with a `role`). Roles gate actions, enforced by the switchboard:
`observer` reads; `member` posts and answers asks addressed to them; `admin` also spawns/renames/
kills agents, changes brakes/budgets, and manages the ledger; `owner` also manages keys, roles,
and rooms. Agent members don't have roles — what an agent may *do on the machine* is its harness
policy chip; roles govern what *humans* may do to the room. Schema ships in M0 (`Member.role`),
enforcement + invite flows land with multi-human rooms in M5.

## Reuse-first build map

The standing rule: **depend** where an artifact fits, **fork/vendor** where we need to bend the
source, **pattern** where we take the design but the code doesn't transplant. License column is
verified in M0 before any code lands (unverified entries marked ⚠).

| Component | Reuse | Mode | Notes |
| --- | --- | --- | --- |
| Claude session driving | `claude` CLI (`-p --resume`, stream-json in/out) | depend | subprocess only — no SDK, by design (loose coupling; same shape as every other harness) |
| Codex session driving | `codex` CLI (`exec --json`, `resume`) | depend | subprocess; proven pattern |
| Harness normalization | Zed ACP (`agent-client-protocol` + `claude-agent-acp`, both Apache-2.0) | rejected as driver layer (M0 verdict) | P0.2 spike: resume OK, usage coarse (per-turn tokens still a Draft RFD), subagent visibility absent by design; codex adapter is third-party (JetBrains). CLI drivers stay; ACP = candidate future fourth adapter |
| Additional harness adapters (Copilot CLI, OpenCode, Gemini, Pi, …) | paseo's adapter set as the *behavioral reference* (AGPL forbids copying code, not learning from it); ACP adapters where they exist (Apache/MIT); each harness's first-party headless docs | pattern / depend | per harness: read their connector → write a behavioral spec (`packages/adapters/<harness>/NOTES.md`: invocation, resume, session store, event format, quirks) → implement our small adapter from the spec against the six-method interface. No paseo code in this repo, in-process or sidecar |
| P2P transport | `hyperswarm` (+ DHT, Noise) — walkie's stack (**MIT, verified P0.2**) | depend; walkie as pattern/vendor | `line:secret` → DHT topic, exactly walkie's channel model; walkie's `listen()/send()` lib is MIT (`walkie-sh` v1.5.0) — reuse permitted with attribution, else hyperswarm directly |
| Tailnet access | Tailscale (user-supplied): `tailscale serve` for TLS; app connectors for custom-domain team access | depend | zero code: bind the tailnet IP; connector setup is documentation, not software |
| Session-store discovery | partyline-sh/cli (MIT, Go) | port | its readers for `~/.claude` / `~/.codex` / Gemini session stores solve attach-by-session-id; port the formats to TS (Go binary doesn't transplant into a Node daemon) |
| Blind ciphertext relay | partyline-sh relay + `ptysess` (Noise NNpsk0, key in URL fragment) | pattern / candidate depend | same philosophy as our push relay; M0 audit checks how separable it is from their hosted control plane — if it's a clean generic pipe, run it wholesale for room sync |
| Watch/phone bridge | claude-watch (verified **MIT**) | fork | MIT permits the closed derivative — cleared. SwiftUI watch app + phone relay + SSE bridge; rework bridge → our WS protocol; lands in the private apps repo |
| Multi-surface daemon shape | Paseo (verified **AGPL-3.0**) | pattern ONLY | license verdict: no code may be copied into this MIT codebase — design cues only (daemon/WS/pairing shape, event rendering ideas). Stack also mismatches: their web/desktop is Expo/react-native-web in Electron; ours is React DOM |
| E2EE primitives | libsodium (`sodium-native`) / Noise via hyperswarm | depend | never hand-rolled; MLS (OpenMLS) only if multi-party keys outgrow sealed-box fan-out |
| Encrypted push | Matrix `sygnal` pattern; NSE decrypt on device | pattern (gateway is ~200 lines) | see PRIVACY §push; consider `ntfy` where APNs isn't required |
| At-rest encryption | OS full-disk encryption (documented) | platform | app-level SQLCipher **deferred**: it would cover the DB but not run blobs/ledger, and the native-build cost buys misleading partial protection |
| Storage | better-sqlite3 + JSONL blobs | depend | boring on purpose |
| Ledger format | Obsidian vault conventions (markdown + `[[wikilinks]]`) | pattern/format | files are the store; Obsidian itself becomes a free graph-view client |
| Ledger graph queries | Graphiti (temporal knowledge graph) ⚠ | optional depend, post-MVP | indexes the vault; never owns the data |
| Web UI | React + Vite; chat primitives from an MIT kit if one fits | depend | timeline/composer are commodity; run-message rendering is ours. Paseo's client is ruled out for code reuse (AGPL + RN-web); a desktop "app" is the PWA, or later a thin Tauri wrapper of our own SPA |
| Voice | Apple SFSpeechRecognizer / watch dictation | platform | on-device toggle, PRIVACY §voice |

What we actually write: **the router, the member/lifecycle model, two thin adapters, the run
journal, and the surfaces' room-rendering.** Everything else is glue around the table above.

## Monorepo layout

```text
wireroom/
  packages/protocol/      # zod schemas: Member, Message, WireEvent, deliveries
  packages/switchboard/   # daemon: store, router, adapter host, WS/REST
  packages/adapters/      # claude-code/, codex/, acp/ (spike)
  packages/cli/           # wireroom join/spawn/post/tail
  packages/web/           # React SPA / installable PWA (the free client, incl. phones)
  relay/                  # push relay (self-hostable, tiny)
  skills/                 # /wireroom Claude Code skill; AGENTS.md snippet for Codex
  docs/
```

pnpm workspaces; no build framework beyond tsc/vite. The native iPhone/Watch apps are **not in
this repo**: they are closed-source, paid, first-party clients of the open protocol
(BUSINESS.md), developed in a private repo on a Mac (Xcode 16+). Nothing here depends on them.

## Stack decisions (pinned)

TypeScript everywhere (Node ≥22, pnpm workspaces). Per part:

| Part | Stack |
| --- | --- |
| `protocol` | zod schemas, plain TS types |
| `switchboard` | Node daemon; **better-sqlite3**; run blobs as JSONL files; **Fastify** (REST) + **ws** (WebSocket); child_process for adapters; **chokidar** for ledger watching; systemd unit for install |
| `adapters/*` | zero deps beyond protocol — spawn + JSONL parse |
| `web` | **React 18 + Vite + Tailwind CSS**; **zustand** for client state; **vite-plugin-pwa** (Workbox) for the M3 PWA; no SSR |
| `cli` | **commander**; unix socket + WS client |
| `relay` | same Node/TS; **web-push** (VAPID) for Web Push; APNs over HTTP/2 added in M4; stateless, Dockerfile provided |
| bridges (M5) | **Slack Bolt** / **grammY** (Telegram Bot API) |
| P2P | **hyperswarm** (hyperdht + Noise secret-streams); `hyperdht/testnet` for deterministic tests; length-prefixed JSON envelopes with own ids + acks over the raw streams |
| crypto | one suite everywhere: **sodium-native** (Node) + **libsodium-wrappers** (browser page + SW, keys in IndexedDB) — sealed boxes, keypairs, Ed25519 identities; cross-runtime seal/open is a tested invariant; at-rest = OS full-disk encryption |
| testing | **vitest** (unit/integration), **Playwright** (web e2e), recorded-stream fixtures for harnesses absent from the dev box |
| docs site (M5) | **VitePress**, static output — host anywhere |
| SaaS control plane (relay business, post-launch) | **Next.js** (marketing + billing dashboard), **Supabase** (Postgres + GoTrue auth with GitHub/Google OAuth + magic links, storage for sealed mailbox blobs), **Stripe** (billing) — see BUSINESS.md; only we run this, the product itself touches none of it |
| native apps (M4, private repo) | Swift/SwiftUI, WatchConnectivity, APNs + Notification Service Extension, Keychain/Secure Enclave; claude-watch (MIT) fork basis |

**SaaS in the product: none.** No auth provider (identity = device keypairs + QR pairing — no
Auth0/Clerk/Firebase), no hosted DB, no analytics, no error-tracking service. Tailscale is
user-supplied. The only external services ever touched are the unavoidable platform endpoints:
browser push services (free, standard Web Push), APNs (M4, needs the Apple Developer Program),
Slack/Telegram APIs (M5 bridges), and **Stripe** at business-launch time for relay billing —
billing identity (an email) is the only account-shaped thing anywhere, it lives with Stripe,
and it maps to keys, never to content.

## Failure behavior

- Harness process dies mid-run → run message finalized `failed`, member `dead`, system message +
  push; member resurrectable via `attach(session_ref)` (one tap: "revive").
- Switchboard restart → resumes all owned members from `session_ref`s (+ persisted `cwd`),
  replays nothing: a delivery is consumed only when `run.completed` lands; in-flight attempts
  are reconciled against the run blob and native transcript — provably completed → finalize,
  provably never started → retry once, **ambiguous → held for the operator**. Never silently
  double-delivered.
- Surface offline → clients are caches; on reconnect they page missed history via REST. Push
  relay down → notifications degrade, room state unaffected.
- Clock: message ids are the ordering truth (per-room monotonic, assigned by the single owning
  switchboard); timestamps are display-only. Cross-host rooms order by (host lamport, id) —
  post-MVP detail, schema-ready.
