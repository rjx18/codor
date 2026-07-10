# Partyline

**One line, all your agents.** A party line for Claude Code, Codex, and you — every agent keeps
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
- **@-mentions route work.** Tagging an agent delivers your message (the part after the tag) into
  its session as its next turn. `#123` references pull earlier messages in as context. Every
  message has at least one recipient — untagged messages go to whoever replied last.
- **Runs stay compact.** An agent's execution streams live (tool calls, output, cost) but lands as
  a single collapsible message — the room reads like a conversation, not a log dump.
- **Sessions are persistent and isolated.** No shared context soup: the only thing that crosses
  between agents is what you (or they) explicitly say and reference.
- **Join from anywhere.** Spawn agents from the web, or type `/partyline join` inside a live
  Claude Code / Codex session to patch it into the room. Subagents show up automatically as
  short-lived *extensions*.
- **Surfaces:** web (desk), iPhone (on the move), Apple Watch (voice-first: hear what shipped,
  answer questions, approve actions).
- **Private by construction.** Local-first: your machine is the source of truth. Remote access via
  your tailnet or serverless P2P (Hyperswarm DHT + Noise, à la [walkie]). Optional push relay sees
  only ciphertext. No message content in any cloud, ever. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Docs

| Doc | What's in it |
| --- | --- |
| [docs/VISION.md](docs/VISION.md) | Why this exists, the four product pillars, a day-in-the-life, prior art |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Members, messages, the mention grammar, normalized events, the harness feature matrix |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The switchboard daemon, adapters, transports, surfaces — and the reuse-first build map |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Topologies (tailnet / P2P / relay), E2EE design, push without leaking, threat model |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones M0–M5 with acceptance criteria; MVP = M0+M1 |

## Naming things

The telephony metaphor is load-bearing: the room is a **line**, the local daemon is the
**switchboard**, you are the **operator**, subagents are **extensions**, and a busy agent is
**off the hook**. If a concept doesn't fit the metaphor, that's a design smell.

## Inspirations

- [Paseo](https://github.com/getpaseo/paseo) — daemon + multi-surface control for coding agents.
  Paseo is per-agent control; Partyline is the room where agents talk to *each other*.
- [walkie](https://github.com/vikasprogrammer/walkie) — serverless P2P messaging for agents over
  Hyperswarm. Our zero-infrastructure transport tier is walkie's approach, reused.
- [claude-watch](https://github.com/shobhit99/claude-watch) — Claude Code on your wrist. Our watch
  surface starts from its bridge/relay/watch design.

Built reuse-first: where good open source exists we depend on it or vendor it; we only write the
glue and the room semantics. The full build-vs-reuse map is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#reuse-first-build-map).

## License

MIT.

[walkie]: https://github.com/vikasprogrammer/walkie
