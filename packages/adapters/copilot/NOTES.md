# GitHub Copilot CLI behavioral specification

This adapter was written from behavior and public documentation. Paseo is an
AGPL-3.0 behavioral reference only; no Paseo code, types, or implementation
structure are used.

## Sources checked (2026-07-10)

Paseo behavior:

- [Paseo Copilot connector](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/agent/providers/copilot-acp-agent.ts)
  launches `copilot --acp`, advertises streaming, persisted/listable sessions,
  dynamic models and modes, reasoning, and tools, and maps Copilot's `allow_all`
  session configuration into an Allow All mode.
- [Paseo ACP base](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/agent/providers/acp-agent.ts)
  owns process initialization, new/load session, prompt streaming, cancellation,
  permission responses, model/mode discovery, and token mapping for that path.

Wireroom deliberately does not use Paseo's ACP design. Its architecture requires
a normal CLI process per turn, so this adapter implements Copilot's independently
documented programmatic JSONL mode and exposes only what that mode can prove.

First-party GitHub references:

- [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
  documents prompt mode, JSONL output, streaming, exact session ids, resume,
  model selection, `--no-ask-user`, allow/deny flags, `COPILOT_HOME`, and native
  interactive sessions.
- [Programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
  documents one-shot `-p`, model pinning, ask suppression, and tool restrictions.
- [Session data](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle)
  documents complete local session records under
  `~/.copilot/session-state/<session-id>` and CLI resume.
- [Streaming event reference](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
  specifies the common JSONL-compatible event envelope plus assistant deltas and
  complete messages, tool lifecycle, usage, errors, idle, and authoritative
  subagent started/completed/failed records field by field.
- [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
  records the addition of `--output-format json` for prompt-mode JSONL and exact
  UUID session creation/resume.

The `copilot` executable is absent and no authenticated Copilot subscription is
available on this machine. No live claims are made.

## Invocation

The adapter allocates a UUID before the first turn. First use creates that exact
session; later uses resume it:

```text
copilot --output-format=json --stream=on --no-ask-user --no-color \
  [--model MODEL] [--allow-all-tools] --session-id UUID --prompt PAYLOAD
```

The process starts in the member's persisted cwd, stdin is closed, stdout is
read through EOF, stderr is bounded for failure detail, and the detached process
group is signalled on interrupt and cleanup. Clean exit completes the turn;
nonzero exit/spawn failure fails it; signal termination interrupts it.

`--allow-all-tools` is passed only for explicit `allow-all`, `yolo`, or
`danger-full-access` policy chips. Other policies leave Copilot's configured
permissions in force. `--no-ask-user` prevents a noninteractive turn from
blocking on a question. Wireroom therefore declares spawn-time approvals and no
runtime ask response channel.

## Resume, discovery, and attach

`spawn()` generates a valid UUID and every turn passes it via `--session-id`.
The command reference guarantees an existing id resumes and a missing valid UUID
creates. The adapter reports the id as soon as the child spawns so the daemon
persists it before output completion.

Discovery enumerates UUID-named directories immediately below
`$COPILOT_HOME/session-state` (default `~/.copilot/session-state`), exactly the
local store documented by GitHub. Interactive attach is
`copilot --resume UUID` in the member cwd.

## Event normalization

Every synthesized record uses GitHub's documented envelope:
`{id,timestamp,parentId,ephemeral?,type,data}`.

| Copilot event | Wireroom event |
| --- | --- |
| parent `assistant.message_delta` | `run.item/text_delta`; accumulate text |
| parent `assistant.message` | final text; emit only if no deltas for that message |
| `assistant.reasoning` | `run.item/reasoning_summary` |
| `tool.execution_start` | `run.item/tool_call` |
| `tool.execution_complete` | `run.item/tool_result` |
| `assistant.usage` | accumulate input/output tokens |
| `session.error` | retain failure detail and emit error-shaped tool result |
| `subagent.started` | `extension.started`, keyed by `toolCallId` |
| `subagent.completed` / `subagent.failed` | `extension.ended` |
| clean EOF + exit 0 | completed run with accumulated text/usage |
| other EOF | failed or interrupted according to process evidence |

Copilot documents `assistant.usage.cost` as a **model multiplier for billing**,
not a reported USD amount. The adapter never maps it to `cost_usd`; Copilot
tokens remain visibly uncosted in Wireroom's meter.

## Capability truth

| Capability | Declared | Evidence |
| --- | --- | --- |
| resume | true | exact UUID `--session-id`; subprocess/stable-id conformance test |
| discover | true | documented session-state layout; directory fixture test |
| interactive attach | true | documented `--resume`; CLI resolver test |
| ask | false | `--no-ask-user`; no JSONL response channel |
| approvals | spawn-time | allow/deny CLI flags; no Wireroom runtime response |
| extensions | true | documented subagent lifecycle; synthetic replay test |

All checked-in JSONL is explicitly **SYNTHETIC**, assembled from the first-party
event envelope and field tables. The deferred authenticated checks are recorded
in the repository-root `MANUAL-VERIFY.md`.
