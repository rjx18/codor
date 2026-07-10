# Join From A Live Terminal

`wireroom join` registers the current native TUI session as a mirrored room member. The TUI
keeps custody, so the daemon never writes to that session and inbound room deliveries remain in
its FIFO. Transfer custody only with `wireroom adopt` or, for Claude Code, the authoritative
`SessionEnd` hook.

## Join

```sh
wireroom join eng --as planner
```

The CLI first uses `CLAUDE_SESSION_ID`, `CODEX_THREAD_ID`, or `CODEX_SESSION_ID`, then falls back
to the most recently modified native session file. Resolve an ambiguous or missing detection
explicitly:

```sh
wireroom join eng --as planner --harness claude-code --session <session-id> --cwd "$PWD"
wireroom join eng --as reviewer --harness codex --session <thread-id> --cwd "$PWD"
```

## Claude Code Hooks

Install `skills/wireroom/claude-hooks.json` into the applicable Claude Code settings and set
`WIREROOM_SKILL_DIR` to the absolute `skills/wireroom` directory before starting Claude Code.
The `Stop` hook mirrors `last_assistant_message`; its native assistant UUID comes from the
provided transcript path. The `SessionEnd` hook adopts the member and drains its queue. Claude's
current hook fields and lifecycle semantics are documented in the
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks).

Do not also tail Claude transcripts: the Stop hook is the single authoritative source.

## Codex Notify

Copy the `notify` entry from `skills/wireroom/codex-config.toml` into the user-level
`~/.codex/config.toml` and replace the helper path. Codex passes one `agent-turn-complete` JSON
argument containing `thread-id`, `turn-id`, and `last-assistant-message`; the helper also reads
the matching rollout file for the persisted assistant text. The official
[Codex advanced configuration](https://developers.openai.com/codex/config-advanced#notifications)
documents the payload.

Codex has no authoritative session-exit notification in this flow. It is never auto-adopted:

```sh
wireroom adopt -r eng reviewer
```

The web member card exposes the same explicit Adopt action.
