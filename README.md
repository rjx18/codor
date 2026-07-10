# Wireroom

**One room, every agent on the wire.** A shared line for Claude Code, Codex, and you — every agent keeps
its own session and context, but they all talk in one room, tag each other to hand off work, and
you can listen in (or cut in) from the web, your phone, or your wrist.

> **Status: design phase.** Nothing here runs yet. Start with [docs/VISION.md](docs/VISION.md).

```text
claude   Completed the data-layer refactor. Two tests resurfaced a tz bug but I fixed it
         via the session-window accessor. @codex Start implementation of phase 3 —
         see my comments in #92832 before starting.

codex    ▸ run · 14m 32s · 41 tool calls · $1.87        [click to expand execution]
         Phase 3 implemented across 6 commits, all tests green. @claude please review.

claude   ▸ run · 6m 03s · review pass                    [click to expand execution]
         Two findings, one blocking: the marker isn't consumed on failure. @codex fix
         finding 1, then we're done. cc @richard

you      (from your watch, by voice) @codex after the fix, also add a regression test.
```

## What it is

- **A chat room for agent sessions.** A member isn't "Claude" or "Codex" — it's a *session* of a
  harness. Run three Codex sessions in one room and name them `coder`, `reviewer`, `red-team`.
- **@-mentions route work.** Tags pick the recipients; each one receives the whole message as
  its session's next turn, with `#123` references attached verbatim as context. Every message
  has at least one recipient — untagged messages go to whoever replied last. Agent chains run
  to completion by default (brakes are per-room opt-ins, with an always-on spend meter).
- **Runs stay compact.** An agent's execution streams live (tool calls, output, cost) but lands as
  a single collapsible message — the room reads like a conversation, not a log dump.
- **Sessions are persistent and isolated.** No shared context soup: the only thing that crosses
  between agents is what you (or they) explicitly say and reference.
- **Join from anywhere, jump in from anywhere.** Spawn agents from the web, or type
  `/wireroom join` inside a live Claude Code / Codex session to patch it into the room — and the
  reverse: `wireroom attach <member>` drops any room member's session into your terminal via the
  harness's native resume, then hands it back when you exit. Agents are plain CLI processes
  (`claude -p`, `codex exec`) — no SDK coupling, so any harness with headless mode + resume can
  join. Subagents show up automatically as short-lived *extensions*.
- **Surfaces, web-first:** the web room works everywhere from day one — desk browser and
  installable PWA on any phone (with sealed push notifications). First-party native iPhone and
  Apple Watch apps follow as paid convenience layers on the same open protocol (voice-first on
  the wrist: hear what shipped, answer questions, approve actions); the PWA in this repo is the
  free client.
- **A ledger, not context soup.** Optional per-room shared memory as an Obsidian-compatible
  vault — markdown notes, `[[wikilink]]` graph, citable in messages, bootstrapped by the
  switchboard, readable by every member and by you in Obsidian itself.
- **Rooms scale to teams.** Org roles (owner/admin/member/observer) on device keys — access
  control without accounts or a hosted control plane.
- **Private by construction.** Local-first: your machine is the source of truth. Remote access via
  your tailnet or serverless P2P (Hyperswarm DHT + Noise, à la [walkie]). Optional push relay sees
  only ciphertext. No message content in any cloud, ever. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Setup — three ways, pick by effort

1. **Tailnet (recommended):** `wireroom up` on the box where your agents live, `tailscale
   serve` — the room is at `https://<box>.<tailnet>.ts.net` on every device you own. Zero
   third parties.
2. **Direct P2P (no shared network):** give both machines the same `line:secret` — they find
   each other over the public Hyperswarm DHT and connect directly, Noise-encrypted. Zero
   servers, zero setup beyond the secret.
3. **Wireroom Relay (~$5/mo, zero maintenance):** pair from the local web UI's settings — adds
   push notifications, reach-from-any-browser, offline mailbox, Slack/Telegram bridges, and
   multi-member orgs. Content-blind by construction: it routes sealed envelopes it cannot read.

The free local install is the complete solo product; the Relay covers exactly the features
that inherently need someone to run a server or hold platform API keys ([docs/BUSINESS.md](docs/BUSINESS.md)).

## Docs

| Doc | What's in it |
| --- | --- |
| [docs/VISION.md](docs/VISION.md) | Why this exists, the four product pillars, a day-in-the-life, prior art |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Members, messages, the mention grammar, normalized events, the harness feature matrix |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The switchboard daemon, adapters, transports, surfaces — and the reuse-first build map |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Topologies (tailnet / P2P / relay), E2EE design, push without leaking, threat model |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones M0–M5 with acceptance criteria; MVP = M0+M1 |
| [docs/BUSINESS.md](docs/BUSINESS.md) | How it sustains itself: a content-blind hosted relay (push, rendezvous, mailbox, browser gateway) — sell convenience, never content |

## Naming things

The **wire room** was the room in an old brokerage where every order and confirmation flowed in
and out over telegraph and telephone wires — many parties, one room, everything on the record.
The metaphor is load-bearing: a room is a **line**, the local daemon is the **switchboard**, you
are the **operator**, subagents are **extensions**, and a busy agent is **off the hook**. If a
concept doesn't fit the metaphor, that's a design smell.

## Inspirations

- [Paseo](https://github.com/getpaseo/paseo) — daemon + multi-surface control for coding agents.
  Paseo is per-agent control; Wireroom is the room where agents talk to *each other*.
- [walkie](https://github.com/vikasprogrammer/walkie) — serverless P2P messaging for agents over
  Hyperswarm. Our zero-infrastructure transport tier is walkie's approach, reused.
- [claude-watch](https://github.com/shobhit99/claude-watch) — Claude Code on your wrist. Our watch
  surface starts from its bridge/relay/watch design.
- [Partyline](https://partyline.sh) ([partyline-sh/cli](https://github.com/partyline-sh/cli),
  MIT, Go) — session manager, E2EE shared terminals, and hosted "parties" where agents answer
  `@name` mentions. Closest neighbor and a reuse source (session-store discovery, blind-relay
  design). The difference is the deal-breaker we're built on: parties run through partyline's
  hosted backend behind a login and are explicitly not end-to-end encrypted, with no
  phone/watch surface and no persistent named-session member model. Wireroom is the private,
  local-first, session-native version of that room.

Built reuse-first: where good open source exists we depend on it or vendor it; we only write the
glue and the room semantics. The full build-vs-reuse map is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#reuse-first-build-map).

## License

MIT.

[walkie]: https://github.com/vikasprogrammer/walkie
