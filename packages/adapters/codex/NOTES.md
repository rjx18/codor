# Codex CLI — behavioral spec (probed 2026-07-10, codex-cli 0.144.0)

Everything below was observed live against the installed CLI. The JSONL files under
`fixtures/` are raw scrubbed captures of these probes (paths/usernames replaced, structure
untouched) and are the normative wire shapes the adapter and its tests replay. Contract drift
must be re-probed against the CLI — never hand-edited into the fixtures.

## Invocation

```sh
codex exec --json [--sandbox <read-only|workspace-write|danger-full-access>] \
  [-c model_reasoning_effort=<low|medium|high>] [--ignore-user-config] \
  --skip-git-repo-check -C <cwd> "<prompt>"                                  # new thread
codex exec --json … resume <thread_id> "<prompt>"                             # resume
```

### Canonical spawn controls (rechecked 2026-07-11)

Codex CLI 0.144.1 `exec --help`, the first-party
[CLI reference](https://developers.openai.com/codex/cli/reference/), and
[configuration reference](https://developers.openai.com/codex/config-reference/)
document the sandbox vocabulary and `model_reasoning_effort`. Codor maps
`read-only` and `workspace-write` directly, maps `full-access` to
`danger-full-access`, and passes thinking `low`, `medium`, or `high` as
`-c model_reasoning_effort=<level>`. The adapter declares `thinking:true`;
provider/model support for a requested effort is not guaranteed, and a CLI
error becomes an ordinary failed turn. Phase 2 used only help/config probes,
with no model call.

- Flags precede the `resume` subcommand (`codex exec --json … resume <id> "<prompt>"`).
- Prompt as argv; if stdin is a pipe it is ALSO read and appended as a `<stdin>` block —
  always spawn with stdin closed (`/dev/null`) or you hang/append garbage. stderr prints
  `Reading additional input from stdin...` noise even with stdin closed.
- `--skip-git-repo-check` required outside a git repo. `-C` sets the agent cwd.
- `--ignore-user-config` skips `~/.codex/config.toml` (MCP servers, feature flags) but keeps
  auth. Probes used it from the refusal probe onward for determinism; shapes are identical
  either way, but user config can change which internal exec tool the model uses (see
  "invisible tool calls" below).
- Session rollouts persist under `~/.codex/sessions/<Y>/<m>/<d>/rollout-<ts>-<thread_id>.jsonl`
  (the resume/discovery store). `--ephemeral` disables persistence.

## Event stream (stdout JSONL)

Observed event vocabulary, in order of appearance:

| event | shape | notes |
| --- | --- | --- |
| `thread.started` | `{type, thread_id}` | first line; on `resume` it re-emits the SAME thread_id (fixtures `success` + `resume` share one) |
| `turn.started` | `{type}` | |
| `item.started` / `item.completed` | `{type, item:{id, type, …}}` | `id` is `item_<n>`, per-turn ordinal |
| `turn.completed` | `{type, usage:{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}}` | tokens only — NO `cost_usd` anywhere |
| `turn.failed` | `{type, error:{message}}` | terminal; process exits 1 |
| `error` | `{type, message}` | stream-level error, precedes `turn.failed` |

Item types observed:

- `agent_message` `{id, type, text}` — a turn may contain SEVERAL (commentary then final
  answer). The LAST agent_message is the final text. Only `item.completed` observed for these.
- `command_execution` `{id, type, command, aggregated_output, exit_code, status}` —
  `item.started` with `status:"in_progress"`, `exit_code:null`, then `item.completed` with
  `status:"completed"` and the real `exit_code` (`command` is the full `/bin/bash -lc '…'`
  string). Captured in `kill-mid-turn.jsonl` / `interrupt-sigint.jsonl`; a clean success
  capture (not in the plan's fixture list, verbatim below) shows the same shape.
- `error` `{id, type, message}` — non-fatal warning as an item (seen for unknown-model
  metadata before the hard failure).

Verbatim capture of a successful command run (probe `ls`; shipped as fixture
`command-success.jsonl` in P0.6):

```jsonl
{"type":"thread.started","thread_id":"019f4ae3-02e9-7473-80fc-afed1875d899"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll count the entries from the requested command."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc ls","aggregated_output":"README.md\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"1"}}
{"type":"turn.completed","usage":{"input_tokens":26387,"cached_input_tokens":22016,"output_tokens":110,"reasoning_output_tokens":0}}
```

### Invisible tool calls (contract caveat — bit us during probing)

The model has more than one path to the shell. Plain shell-tool calls surface as
`command_execution` items. But when the model uses the newer unified-exec/script tool
(`custom_tool_call` `name:"exec"` running `tools.exec_command(...)` — confirmed in the rollout
file), `--json` emits NO item at all: the command runs, the rollout records it, the stream
shows only the surrounding agent messages. `refused-write.jsonl` is such a turn: the sandbox
denial (`touch: cannot touch 'probe.txt': Read-only file system`, exit 1 inside the tool
output) happened invisibly; the stream carries only the agent's report of it.

Adapter consequences: `run.item` maps whatever items DO arrive; `tool_calls` counted from the
stream UNDERSTATES reality and must be treated as best-effort; never assume a write/exec is
observable on the wire.

## Sandbox refusal (read-only)

A blocked write does NOT fail the turn: the command fails inside the sandbox (nonzero
exit_code in the tool output), the model reports, `turn.completed` lands normally. There is no
distinct refusal event. When simply ASKED to write (without being pushed), the model usually
declines without attempting — codex's own system prompt tells it the sandbox is read-only.

## Failure shapes

- CLI argv error (`failure-bogus-flag`): exit 2, EMPTY stdout (no JSONL at all), usage text on
  stderr (`error: unexpected argument '--bogus-flag' found`). The empty fixture file is the
  point: spawn failures produce no stream; the adapter must surface stderr + exit code.
- In-stream failure (bogus model probe, verbatim capture below; shipped as fixture
  `failure-bogus-model.jsonl` in P0.6):
  exit 1, `thread.started` still emitted, then `error` + `turn.failed`:

```jsonl
{"type":"thread.started","thread_id":"019f4ae4-c98c-7c12-af40-e53f7b652ea2"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `totally-bogus-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}
{"type":"turn.started"}
{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'totally-bogus-model' model is not supported when using Codex with a ChatGPT account.\"}}"}
{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'totally-bogus-model' model is not supported when using Codex with a ChatGPT account.\"}}"}}
```

(`error.message` can itself be a JSON-encoded provider error — treat as opaque text.)

## Signals, kill, resume (crash boundaries)

The `codex` on PATH is the npm shim (`@openai/codex` `bin/codex.js`): it spawns the native
binary as a child and FORWARDS SIGINT/SIGTERM/SIGHUP — but SIGKILL is unforwardable.

- SIGINT mid-turn (`interrupt-sigint.jsonl`): stream truncates right after the last event
  (here `item.started` of the running command); NO `turn.failed`/`turn.completed`/farewell
  event; observed exit code 1. "Process exited without `turn.completed`" IS the interrupt
  signal on the wire.
- SIGKILL mid-turn (`kill-mid-turn.jsonl`): the shim dies (exit 137) but the ORPHANED native
  engine keeps running, finishes the turn, and keeps writing through the inherited pipe/fd —
  the fixture really contains events written AFTER the kill (completed sleep, final
  agent_message, turn.completed). Adapter consequences: spawn the child in its own process
  group and signal the GROUP (or resolve the native binary path); treat child-exit and
  stream-EOF as separate facts; after a kill, the rollout may show the turn COMPLETED —
  exactly the reconcile case P0.8's attempt-WAL must handle.
- Resume after SIGKILL (`kill-mid-turn-resume.jsonl`): `codex exec … resume <thread_id>` of a
  killed thread works, re-emits the same thread_id, retains context (the model knew about the
  interrupted sleep — probed while the orphan was still mid-turn), and completes normally.

The adapter therefore reports confirmed spawn/process-group identity before reading stdout
and reports `thread_id` as soon as `thread.started` arrives. Reconciliation does not guess at
undocumented rollout internals: the recorded JSONL event contract plus persisted process
evidence are the normative facts, and an incomplete started attempt is held rather than
silently resumed alongside a possibly orphaned native engine.

## Capabilities (for P0.6)

`{resume: true, discover: true, interactiveAttach: true, ask: false, approvals: 'spawn-time',
extensions: false, thinking: true}` — no ask/approval control protocol exists in `exec` mode (sandbox policy
is fixed at spawn); no subagent events observed or documented.

## Probe log (spend discipline)

Each fixture = one live probe (ChatGPT-account auth; usage tokens visible in the captures;
no dollar cost is reported by this harness). Extra probes beyond the plan's list: 3 attempts
to induce an attempted-write refusal (model declined twice — kept the third, which pasted the
sandbox error), 1 vanilla `ls` probe (command_execution shape), 1 bogus-model probe
(turn.failed shape). No quota/auth exhaustion encountered; no fixture is MISSING.

<!-- harn:assume adapters-own-their-model-catalog ref=codex-model-catalog-notes -->
## Model catalog (U3)

`codex --help` exposes `-m, --model <MODEL>` ("Model the agent should use") but enumerates
no ids. The catalog therefore cites the vendor model documentation at
<https://learn.chatgpt.com/docs/models>, which lists the models Codex accepts and names
`gpt-5.6-sol` as the default. Checked 2026-07-12; no model call was made.

| Label | Model id |
| --- | --- |
| Luna | `gpt-5.6-luna` |
| Terra | `gpt-5.6-terra` |
| Sol | `gpt-5.6-sol` |
| GPT-5.5 | `gpt-5.5` |

Thinking is supported and maps to `-c model_reasoning_effort=<low|medium|high>`.
<!-- harn:end adapters-own-their-model-catalog -->
