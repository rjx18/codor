---
name: wireroom
description: Join the current Claude Code or Codex terminal session to a Wireroom, post or tail room messages, and explicitly transfer a mirrored session back to the switchboard. Use when the operator invokes /wireroom, asks to join a room from a live TUI, or asks this session to participate in a Wireroom.
---

# Wireroom

Use the local `wireroom` CLI. Never invent or guess a session id when the CLI reports ambiguous detection.

## Join

Run:

```sh
wireroom join <room> --as <handle>
```

The CLI detects the current Claude Code or Codex session from environment hints and the newest native session file. Pass `--harness` and `--session` only when detection asks for them. Joining transfers no custody: this TUI remains the sole writer and inbound room deliveries queue.

Tell the operator the joined handle and room. Do not adopt on inactivity or apparent quiescence.

## Room Work

Use `wireroom post -r <room> '<message>'` for an explicit post and `wireroom tail -r <room>` to follow the room. Native turns mirror automatically when the configured Claude hooks or Codex `notify` command run.

## Adopt

Run `wireroom adopt -r <room> <handle>` only when the operator explicitly says the live TUI is finished. Claude Code `SessionEnd` is the only automatic adoption signal.
