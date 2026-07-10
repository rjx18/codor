# OpenCode behavioral specification

This adapter was written from observed and documented behavior. Paseo is an
AGPL-3.0 behavioral reference only; no Paseo code, types, or implementation
structure are used.

## Sources checked (2026-07-10)

Paseo behavior:

- [Paseo OpenCode connector](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/agent/providers/opencode-agent.ts)
  keeps a supervised OpenCode server, creates or resumes a session by id plus
  original cwd, subscribes before prompting, maps message/tool/status events,
  accumulates step-finish tokens and cost, answers permissions/questions through
  the server API, aborts on interrupt, and correlates task child sessions.
- [Paseo provider guide](https://github.com/getpaseo/paseo/blob/main/docs/providers.md)
  identifies OpenCode as a direct provider rather than an ACP provider and calls
  out provider-owned message ids and dynamic session-scoped MCP configuration.

Wireroom does not adopt Paseo's SDK/server design. Its architecture requires a
plain CLI subprocess per turn, so this adapter implements the independently
documented `opencode run` interface and honestly exposes the smaller capability
surface available there.

First-party OpenCode sources:

- [CLI reference](https://opencode.ai/docs/cli/) documents `opencode run`, raw
  JSON output, `--session`, `--model`, `--auto`, JSON session/database commands,
  export, and the interactive TUI.
- [`run.ts` at installed v1.17.14](https://github.com/anomalyco/opencode/blob/v1.17.14/packages/opencode/src/cli/cmd/run.ts)
  specifies the emitted JSON wrapper and event boundary: `step_start`,
  `step_finish`, completed `tool_use`, final `text`, optional `reasoning`, and
  `error`, each with top-level `sessionID`; clean idle closes the stream, with no
  separate result event. It also shows headless permissions are accepted once
  with `--auto` or rejected by the CLI otherwise.
- [Session v1 schema at v1.17.14](https://github.com/anomalyco/opencode/blob/v1.17.14/packages/schema/src/v1/session.ts)
  specifies text/tool part state and step-finish `tokens` plus `cost`.
- [Session id schema at v1.17.14](https://github.com/anomalyco/opencode/blob/v1.17.14/packages/schema/src/session-id.ts)
  specifies `ses_` native identifiers.

The installed CLI is OpenCode `1.17.14`; `--help`, JSON session listing, and the
configured model catalog were checked without model spend.

## Invocation

New turn:

```text
opencode run --format json [--model PROVIDER/MODEL] [--auto] PAYLOAD
```

Continued turn:

```text
opencode run --format json [--model PROVIDER/MODEL] [--auto] --session SESSION_ID PAYLOAD
```

The process starts in the member's persisted cwd, stdin is closed, stdout is
read through EOF, stderr is bounded for failure detail, and the detached process
group is signalled on interrupt and cleanup. OpenCode emits no result record:
clean EOF after exit zero completes the turn; nonzero exit, spawn failure, or an
error record plus nonzero exit fails it.

OpenCode has no read-only run flag. Wireroom passes `--auto` only for explicit
`auto`, `yolo`, or `danger-full-access` policies. Other policy chips leave
OpenCode's configured rules in force and its headless runner rejects any newly
raised permission. This is spawn-time policy, not a runtime Wireroom approval.

## Resume, discovery, and attach

Every raw output record carries `sessionID`; the first valid value becomes the
member's `session_ref`. Resume passes that exact id to `--session` from the same
persisted cwd. Although the CLI reference describes `session list` as listing all
sessions, installed v1.17.14 filters it to the current project (verified by
comparing the repository and `/tmp` after the live capture). Global discovery
therefore uses the documented, non-model database command with a read-only query:

```text
opencode db --format json "SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC"
```

Only root session ids are returned; task child sessions are not persistent room
members.

Interactive attach is `opencode --session SESSION_ID` in the member cwd.

## Event normalization

| OpenCode raw event | Wireroom event |
| --- | --- |
| `step_start` | capture session id; no visible item |
| completed/error `tool_use` | `run.item/tool_call` then `run.item/tool_result` |
| `text` | `run.item/text_delta`; concatenate final text |
| `reasoning` | `run.item/reasoning_summary` when present |
| `step_finish` | accumulate input/output tokens and reported `cost` |
| `error` | retain diagnostic and emit error-shaped tool result |
| clean EOF + exit 0 | completed run with accumulated text/usage |
| other EOF | failed or interrupted run according to process evidence |

Step-finish `cost` is already a reported dollar amount. The adapter forwards it
unchanged and never derives prices from tokens.

## Capability truth

| Capability | Declared | Evidence |
| --- | --- | --- |
| resume | true | documented `run --session`; subprocess argv/stable-id test |
| discover | true | documented global JSON db command; parser test and live store check |
| interactive attach | true | native TUI `--session`; CLI resolver test |
| ask | false | `run` exposes no question response channel |
| approvals | spawn-time | `--auto` or CLI-owned rejection; no Wireroom runtime response |
| extensions | false | completed task tools do not provide authoritative child lifecycle |

`fixtures/live-pong-1.17.14.jsonl` is the one real authenticated capture required
by P1.7b, using the configured free model and the tiny prompt `Reply PONG only.`.
It is captured once and never regenerated by the normal test suite.
