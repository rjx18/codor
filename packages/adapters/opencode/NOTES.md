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

Codor does not adopt Paseo's SDK/server design. Its architecture requires a
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

Phase 2 rechecked the installed `run --help` plus the first-party
[permissions](https://opencode.ai/docs/permissions/) and
[models](https://opencode.ai/docs/models/) references on 2026-07-11.
Codor emits no policy flag for `read-only` or `workspace-write`, and maps
`full-access` to `--auto`.

2026-09-12 probe with opencode `0.0.0-dev-202609102034`: `--variant`
names are per-model variant presets (see `opencode models --verbose`), not
a fixed effort scale, and an unsupported or unknown value is accepted and
silently ignored with exit 0, so a fixed low/medium/high control cannot
tell the operator whether the value will be used. The adapter therefore
declares `thinking:false` and never sends `--variant` until variants are
exposed per model.

Upgrade note: an existing opencode member with a persisted `thinking`
value fails loudly on its next turn (`validateSpawnOptions` on rebuild,
`openCodeArgs` on attach) with `adapter 'opencode' does not support
thinking levels`. Recovery is a manual save in the Configure agent
dialog, which submits `thinking: null` for an unsupported level and
clears the stored value.

Presets behave differently: applying an opencode preset with a stored
`thinking` value is refused with a named message rather than a failed
turn, and the preset editor blocks save while the unsupported value is
present. Clear it by switching the draft to another harness and back
(`reconcileConfig` drops the level), or by editing or removing the
preset. A saved default roster holding such a preset fails channel
creation at roster expansion, not one turn.

## Invocation

New turn:

```text
opencode run --format json [--model PROVIDER/MODEL] [--auto] PAYLOAD
```

Continued turn:

```text
opencode run --format json [--model PROVIDER/MODEL] [--auto] --session SESSION_ID PAYLOAD
```

Codor never sends `--variant`. The CLI accepts it, but the name must come
from the selected model's own `variants` object (`opencode models
--verbose`), which varies per model and install and admits operator-defined
custom names; an unknown name is ignored with exit 0.

The process starts in the member's persisted cwd, stdin is closed, stdout is
read through EOF, stderr is bounded for failure detail, and the detached process
group is signalled on interrupt and cleanup. OpenCode emits no result record:
clean EOF after exit zero completes the turn; nonzero exit, spawn failure, or an
error record plus nonzero exit fails it.

OpenCode has no read-only run flag. Codor passes `--auto` only for canonical
`full-access`. Other policy chips leave
OpenCode's configured rules in force and its headless runner rejects any newly
raised permission. This is spawn-time policy, not a runtime Codor approval.

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

Only root session ids are returned; task child sessions are not persistent channel
members.

Interactive attach is `opencode --session SESSION_ID` in the member cwd.

## Event normalization

| OpenCode raw event | Codor event |
| --- | --- |
| `step_start` | capture session id; no visible item |
| completed/error `tool_use` | `run.item/tool_call` then `run.item/tool_result` |
<!-- harn:assume native-prose-completeness-is-explicit ref=opencode-prose-classification-contract -->
| completed `text` part (`part.time.end` is present in the verified 1.17.14 capture) | `run.item/text_block`; concatenate final text |
<!-- harn:end native-prose-completeness-is-explicit -->
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
| approvals | spawn-time | `--auto` or CLI-owned rejection; no Codor runtime response |
| extensions | false | completed task tools do not provide authoritative child lifecycle |
| thinking | false | `--variant` is per-model and silently ignored when unsupported; no fixed effort set is offered |

`fixtures/live-pong-1.17.14.jsonl` is the one real authenticated capture required
by P1.7b, using the configured free model and the tiny prompt `Reply PONG only.`.
It is captured once and never regenerated by the normal test suite.


<!-- harn:assume adapters-own-their-model-catalog ref=opencode-model-catalog-notes -->
## Model catalog (U3): discovered, not curated

opencode is the one harness that can enumerate its own models, so `listModels()` DISCOVERS
them: it runs `opencode models` with a fixed argument vector (no shell), a 5s timeout and a
capped buffer, and reports `source: 'discovered'`. Nothing is hardcoded.

This matters because opencode's catalog is per-installation: run on the development host
2026-07-12 (no model spend) it printed 79 models drawn entirely from THAT machine's
configured providers — `openai`, `opencode`, and `synthetic`, with zero Anthropic entries.
Any hardcoded list would have been wrong for somebody.

Discovery is best-effort by design. A missing binary, a non-zero exit, a hang, or output the
daemon cannot validate all degrade silently to no list, and the dialog falls back to its
`Custom…` escape (placeholder `provider/model`, the form opencode's `--model` takes).
<!-- harn:end adapters-own-their-model-catalog -->

<!-- harn:assume live-inbox-capability-is-evidence-backed-v2 ref=opencode-live-inbox-notes -->
## Live inbox (LC3)

Rechecked 2026-07-13 with installed `opencode run --help`, without a model call. The direct
runner exposes no first-party tool-boundary hook whose command stdout enters the running
model turn. This adapter therefore declares `live_inbox:false`.
<!-- harn:end live-inbox-capability-is-evidence-backed-v2 -->
