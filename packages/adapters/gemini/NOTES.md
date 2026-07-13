# Gemini CLI behavioral specification

This adapter was written from behavior, not from Paseo source. No Paseo code,
types, or implementation structure are present here.

## Sources checked (2026-07-10)

Paseo is AGPL-3.0 and was read only as a behavioral reference:

- [Paseo ACP provider catalog](https://github.com/getpaseo/paseo/blob/main/packages/app/src/data/acp-provider-catalog.ts)
  pins Gemini CLI and launches it as `npx -y @google/gemini-cli@<version>
  --acp`.
- [Paseo custom providers](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)
  describes the generic ACP path: spawn the configured process, initialize,
  create a session, send prompts, and stream responses, tools, and permission
  requests. This confirms the external behavior but is not Codor's transport.

First-party Gemini CLI references:

- [Headless mode](https://geminicli.com/docs/cli/headless/) documents `-p`,
  `--output-format stream-json`, JSONL event kinds, terminal exit codes, and
  aggregate token statistics.
- [Session management](https://geminicli.com/docs/cli/session-management/)
  documents automatic project-scoped storage under
  `~/.gemini/tmp/<project>/chats`, exact UUID resume, `--list-sessions`, and the
  interactive resume browser.
- [CLI argument source](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts)
  is Apache-2.0 first-party behavior evidence for `--model`, `--approval-mode`,
  `--resume`, `--list-sessions`, `--prompt`, and `--output-format`.
- [Stream event interfaces](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts)
  specify exact fields for init, message, tool use/result, error, result, and
  token statistics.
- [Recording service](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts)
  specifies JSONL session metadata (`sessionId`, `kind`) and main-session file
  placement.
- [Plan mode](https://geminicli.com/docs/cli/plan-mode/) defines the read-only
  approval mode used for Codor's `read-only` policy chip.

Paseo uses Gemini's generic ACP endpoint. Codor deliberately does not: the
repository architecture requires one plain headless CLI process per turn, so
this adapter uses the independently documented `stream-json` interface.

## Invocation

New turn:

```text
gemini --output-format stream-json [--model MODEL] [--approval-mode MODE] --prompt PAYLOAD
```

Continued turn:

```text
gemini --output-format stream-json [--model MODEL] [--approval-mode MODE] --resume UUID --prompt PAYLOAD
```

The process starts in the member's persisted `cwd`, stdin is closed, stdout is
read through EOF, stderr is bounded for failure detail, and the detached process
group is signalled on interrupt and cleanup. A child exit is not treated as
stdout EOF.

Codor policy mapping is `read-only` to `plan`, `workspace-write` to
`auto_edit`, and `full-access` to `yolo`. These canonical mappings were
rechecked on 2026-07-11 against the first-party CLI argument source and
[approval modes](https://geminicli.com/docs/cli/configuration/#approval-mode).
Unknown native or legacy values do not pass through. Gemini exposes no
documented low/medium/high thinking control in this interface, so the adapter
declares `thinking:false` and rejects a requested level before spawning. The
verification used documentation only and made no model call.

## Resume and discovery

The `init.session_id` UUID becomes the member's `session_ref`. Subsequent turns
pass that exact UUID to `--resume` from the same persisted `cwd`, because Gemini
history is project-scoped. Discovery reads only direct main-session JSON/JSONL
files under each `~/.gemini/tmp/<project>/chats` directory and extracts the full
metadata UUID; subagent records and filename short IDs are never advertised.

Interactive attach is `gemini --resume UUID` in the member's working directory.

## Event normalization

| Gemini stream event | Codor event |
| --- | --- |
| `init` | capture `session_id`; no visible item |
| assistant `message` | `run.item/text_delta`; concatenate final text |
| user `message` | ignored as prompt echo |
| `tool_use` | `run.item/tool_call` |
| `tool_result` | `run.item/tool_result` |
| `error` | error-shaped `run.item/tool_result`; retain fatal text |
| successful `result` | completed run plus input/output tokens |
| error `result` | failed run plus reported input/output tokens |
| EOF without `result` | interrupted, or failed when process evidence says so |

Gemini reports token statistics but no dollar cost in this interface. The
adapter never invents `cost_usd`.

## Capability truth

| Capability | Declared | Evidence |
| --- | --- | --- |
| resume | true | documented exact UUID `--resume`; argv and stable-ref conformance test |
| discover | true | documented project store; metadata discovery test |
| interactive attach | true | documented resume TUI; CLI resolver test |
| ask | false | no response channel in headless stream-json |
| approvals | spawn-time | `--approval-mode`; no runtime response channel |
| extensions | false | stream-json has no documented subagent lifecycle events |
| thinking | false | no documented low/medium/high headless control |

The checked-in JSONL files are explicitly **SYNTHETIC**, built from Google's
documented event interfaces. The `gemini` binary is absent and no authenticated
Gemini account is available on this machine, so no live claim is made. The one
deferred tiny authenticated probe is recorded in `MANUAL-VERIFY.md`.

<!-- harn:assume adapters-own-their-model-catalog ref=gemini-model-catalog-notes -->
## Model catalog (U3)

The Gemini CLI is not installed on the development host, so the catalog cites the CLI's own
model documentation:
<https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/model.md>, which lists the
models selectable via `--model` / `/model`. Checked 2026-07-12; no model call was made.

| Label | Model id |
| --- | --- |
| Flash | `gemini-3-flash-preview` |
| Pro | `gemini-3-pro-preview` |
| 2.5 Flash | `gemini-2.5-flash` |
| 2.5 Pro | `gemini-2.5-pro` |

This interface exposes no documented low/medium/high thinking control, so the adapter
declares `thinking:false` and the thinking row renders disabled with the capability hint.
<!-- harn:end adapters-own-their-model-catalog -->

<!-- harn:assume live-inbox-capability-is-evidence-backed ref=gemini-live-inbox-notes -->
## Live inbox (LC3)

Rechecked 2026-07-13 against the first-party headless stream-json sources cited above; the
Gemini binary remains absent and no model call was made. The documented interface exposes no
first-party tool-boundary hook whose command stdout enters the running model turn. This
adapter therefore declares `live_inbox:false`.
<!-- harn:end live-inbox-capability-is-evidence-backed -->
