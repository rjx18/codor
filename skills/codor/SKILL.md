---
name: codor
description: Join the current Claude Code or Codex terminal session to a Codor, post or tail channel messages, and explicitly transfer a mirrored session back to the switchboard. Use when the operator invokes /codor, asks to join a channel from a live TUI, or asks this session to participate in a Codor.
---

# Codor

Use the local `codor` CLI. Never invent or guess a session id when the CLI reports ambiguous detection.

## Join

Run:

```sh
codor join <channel> --as <handle>
```

The CLI detects the current Claude Code or Codex session from environment hints and the newest native session file. Pass `--harness` and `--session` only when detection asks for them. Joining transfers no custody: this TUI remains the sole writer and inbound channel deliveries queue.

Tell the operator the joined handle and channel. Do not adopt on inactivity or apparent quiescence.

## Channel Work

Use `codor post -r <channel> '<message>'` for an explicit post and `codor tail -r <channel>` to follow the channel. Native turns mirror automatically when the configured Claude hooks or Codex `notify` command run.

## Adopt

Run `codor adopt -r <channel> <handle>` only when the operator explicitly says the live TUI is finished. Claude Code `SessionEnd` is the only automatic adoption signal.
