# Roadmap

Milestones M0–M5, ordered low-risk → high-risk, each independently shippable and demo-able.
**MVP = M0 + M1** — the point where the real-world claude↔codex review loop (the workflow this
tool was born from) runs end-to-end with zero terminal copy-paste. Detailed per-phase
implementation plans (harn-style, one plan per commit) are written per milestone when that
milestone starts — this file stays the map, not the turf.

## M0 — Dial tone

*A room exists; one human and one owned agent talk in it over the tailnet.*

- `packages/protocol`: schemas for Member/Message/WireEvent/deliveries (PROTOCOL.md → zod).
- `packages/switchboard`: SQLite store, run-blob journal, WS/REST API, single-room MVP of the
  router (mention→recipients, whole-message payloads, refs, defaults — full PROTOCOL §3
  semantics from day one; they're the product).
- `packages/adapters/codex`: spawn + resume + deliver via `codex exec --json`; run message
  streaming with live header; usage capture.
- `packages/adapters/claude-code`: CLI driver — `claude -p --resume` with stream-json in/out
  (events, ask-user, and permission prompts over the control protocol → ask/approval cards).
  No SDK dependency, by design.
- `packages/web`: room timeline, collapsible runs, composer with @/# autocomplete + implied
  recipient, member rail, ask/approval cards.
- **License + reuse audit** (the M0 gate for the build map): verify walkie, claude-watch, paseo
  licenses; **ACP spike** — can it carry resume/usage/extensions? Decision recorded in
  ARCHITECTURE.md.
- Tailnet deploy recipe (`tailscale serve`) + pairing token for the web client.

**Acceptance:** from a browser on another machine (over tailnet), spawn a Codex session and a
Claude session into a room, send `@claude plan X`, watch the run stream collapse into one
message, have Claude's final `@codex implement` hand off automatically, and read Codex's
result — no terminal involvement after setup.

## M1 — The party (MVP)

*Many sessions, custody in both directions, extensions. The manual review loop is dead.*

- Multi-agent rooms: rename, per-member policy chips, queue/batch semantics, member revive.
- `/wireroom` skill (Claude Code) + `wireroom join` CLI (Codex): mirrored members, hook-based
  mirroring, adopt-on-TUI-exit custody transfer.
- `wireroom attach <member>`: jump into any member's session from a terminal via native resume;
  re-adopt on exit (the reverse custody direction).
- Extensions: subagent capture via Task-call events + hooks; collapsed rendering under parent.
- Always-on spend meter; opt-in turn/spend brakes (off by default — agents run to completion);
  stall flagging.
- History paging, room search, message permalinks (#N anchors).

**Acceptance:** replay a real historical workflow — plan → `@codex` review (persistent session)
→ fold findings → `@codex` re-review → converge — entirely in one room with no brakes tripping,
including one `/wireroom join` of a pre-existing live TUI session, one `wireroom attach` into a
room-owned member and back, and one subagent appearing as an extension. Separately, a room with
the opt-in turn brake enabled holds and releases correctly.

## M2 — Long lines

*Rooms escape the single machine without touching a cloud.*

- Hyperswarm transport (`line:secret` → DHT topic; walkie's model): switchboard↔switchboard
  peering; a room hosted on the desk reachable from a laptop on hotel wifi.
- Multi-box rooms (ARCHITECTURE §multi-box): remote member residency — deliveries routed to the
  member's switchboard, events streamed back to the home, unreachable-peer queueing.
- Room keys + sealed-box distribution + revocation (PRIVACY §keys) — encryption layered on
  regardless of transport.
- Ledger v1 (PROTOCOL §6): vault bootstrap, `[[name]]` refs resolved into deliveries,
  `wireroom ledger` CLI, change notices in the room.
- Optional SQLCipher at rest; multi-device web pairing polish.

**Acceptance:** two machines with no shared tailnet hold a conversation in one room over the
DHT; a packet capture shows nothing readable; revoking a device locks it out of new messages.

## M3 — The bullpen phone (iPhone)

*Built on the Mac; first Apple surface.*

- SwiftUI app: QR pairing, room list/timeline (runs collapsed), composer with dictation,
  ask/approval action sheets, foreground live over tailnet/LAN.
- Notification plumbing prepared (NSE target, key storage in Keychain) but push may still be
  doorbell-less until M4's relay.

**Acceptance:** the M1 acceptance flow driven entirely from the phone, including answering a
Claude ask card and approving a permission request.

## M4 — On the wrist

*claude-watch's promise, generalized to every agent in every room.*

- watchOS app (started from the claude-watch fork): inbox (addressed messages, asks, approvals,
  budget holds), room glance, dictation replies with recipient picker.
- Push relay (`relay/`): sealed-payload APNs forwarding, NSE decrypt, padded buckets;
  self-host doc with your-own-APNs-key setup.
- WatchConnectivity bridging via the phone; haptics vocabulary (done / question / budget-hold).

**Acceptance:** phone in pocket, watch only: receive 🕊️ run-complete, answer an ask card by
voice, and hold/release an opt-in turn brake — while the switchboard sees no plaintext leave the tailnet
except sealed push payloads.

## M5 — Open the doors

*From personal tool to open-source project.*

- Adapter SDK: `HarnessAdapter` documented + a reference third-party adapter (ACP-based if the
  M0 spike held; else OpenCode or Gemini CLI direct).
- Multi-human rooms: org enrollment (invite QR, device keys), role enforcement
  (owner/admin/member/observer), presence, per-human notification routing.
- Ledger graph view in the web UI; optional Graphiti indexer for temporal queries.
- Bridges: Slack + Telegram as opt-in room mirrors (ARCHITECTURE §bridges), with the bridged
  banner and role-gated enablement.
- Self-host guide, threat-model doc review (external eyes invited), docs site, demo video of
  the M1 acceptance loop, launch.

**Acceptance:** a stranger with the README, a Mac, and one evening gets tier-0 running with
both stock adapters, and a third-party harness lands via the SDK without patching core.

## Deliberately deferred

- Offline ciphertext mailbox (push is a doorbell; content fetch requires reachability).
- MLS group crypto (sealed-box fan-out is right at ≤5 devices).
- Addressable extensions, `@all`, threading beyond `reply_to`, message editing.
- Android/WearOS (architecture is surface-agnostic; someone else's M3/M4).
- Any hosted "Wireroom cloud". The moment content touches our servers, PRIVACY.md has failed.
