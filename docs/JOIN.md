# Join From A Live Terminal

The browser's **Existing Codex or Claude session** wizard defaults to **Fork a copy into
Codor**. Paste the full native session UUID and choose the matching provider. Codor verifies
the UUID against that provider's local session store, then creates a separate native session
on the first message. The original terminal remains open and unchanged.

Use **Mirror the live terminal** only when the terminal itself must remain authoritative.
Mirrored members cannot receive browser turns until custody is transferred.

`codor join` registers the current native TUI session as a mirrored channel member. The TUI
keeps custody, so the daemon never writes to that session and inbound channel deliveries remain in
its FIFO. Transfer custody only with `codor adopt` or, for Claude Code, the authoritative
`SessionEnd` hook.

## Join

```sh
codor join eng --as planner
```

The CLI first uses `CLAUDE_SESSION_ID`, `CODEX_THREAD_ID`, or `CODEX_SESSION_ID`, then falls back
to the most recently modified native session file. Resolve an ambiguous or missing detection
explicitly:

```sh
codor join eng --as planner --harness claude-code --session <session-id> --cwd "$PWD"
codor join eng --as reviewer --harness codex --session <thread-id> --cwd "$PWD"
```

## Claude Code Hooks

Install `skills/codor/claude-hooks.json` into the applicable Claude Code settings and set
`CODOR_SKILL_DIR` to the absolute `skills/codor` directory before starting Claude Code.
The `Stop` hook mirrors `last_assistant_message`; its native assistant UUID comes from the
provided transcript path. The `SessionEnd` hook adopts the member and drains its queue. Claude's
current hook fields and lifecycle semantics are documented in the
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks).

Do not also tail Claude transcripts: the Stop hook is the single authoritative source.

## Codex Notify

Copy the `notify` entry from `skills/codor/codex-config.toml` into the user-level
`~/.codex/config.toml` and replace the helper path. Codex passes one `agent-turn-complete` JSON
argument containing `thread-id`, `turn-id`, and `last-assistant-message`; the helper also reads
the matching rollout file for the persisted assistant text. The official
[Codex advanced configuration](https://developers.openai.com/codex/config-advanced#notifications)
documents the payload.

Codex has no authoritative session-exit notification in this flow. It is never auto-adopted:

```sh
codor adopt -r eng reviewer
```

The web member card exposes the same explicit Adopt action.
