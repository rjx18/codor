# Antigravity (`agy`) adapter — behavioral sources

The `antigravity` adapter drives the Antigravity CLI (`agy`), Google's successor to the
now-deprecated `gemini` CLI. It is a supervised per-turn subprocess driver like the
copilot and opencode adapters.

## CLI surface (`agy --help`, `agy models`)

- `--print <prompt>` — run one prompt non-interactively and print the response. **Output is
  plain text**, not a structured stream. There is no `--output-format` flag.
- `--model <name>` — a display name from `agy models` (e.g. `Gemini 3.5 Flash (High)`), not
  an id slug.
- `--mode <accept-edits|plan>` — execution mode. `--dangerously-skip-permissions`
  auto-approves tool permissions.
- `--conversation <id>` / `--continue` — resume a prior conversation.
- `--add-dir <dir>` — add a workspace directory. `--log-file <path>` — override the log path.
- `--print-timeout <dur>` — print-mode wait timeout (default 5m); we set 30m and let the
  switchboard own real interruption.

## Session resume — why the log is parsed

`agy --print` never prints the conversation id, but its verbose `--log-file` (Google glog
format) records it on the stream-lifecycle lines, e.g.:

```
I0719 ... server.go:952] Stream goroutine exited for 1f935c68-016d-4cbb-a740-56e90ab75630, sending completion signal
I0719 ... conversation_manager.go:654] Stream completed for 1f935c68-016d-4cbb-a740-56e90ab75630, clearing ResponsePending
```

`deliver()` writes a temp log file, reads it after the turn, and takes the last UUID as the
conversation id (`session_ref`). Subsequent turns pass `--conversation <id>`. This anchors on
a log line rather than a stable API, so it is best-effort: if the id cannot be recovered the
member simply starts a fresh conversation on its next turn.

## Capabilities

- `resume: true` (via the recovered conversation id), `discover: false` (no session-store
  listing command), `interactiveAttach: false`, `ask: false`, `approvals: 'spawn-time'`,
  `extensions: false`, `thinking: false` — thinking is encoded in the model name, not a flag.
- Policy mapping: `read-only → --mode plan`, `workspace-write → --mode accept-edits`,
  `full-access → --mode accept-edits --dangerously-skip-permissions`.
- No token usage: `agy` reports none through the print interface or the log.
