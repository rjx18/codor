# cursor adapter — behavioral sources

Drives the `cursor-agent` CLI in headless mode. Mirrors the `gemini` adapter
(per-turn subprocess + `--output-format stream-json` + readline over stdout).
Captured against `cursor-agent 2026.07.16-899851b`.

## Invocation

```
cursor-agent -p --output-format stream-json --stream-partial-output --trust \
  [--model <m>] [<policy flags>] [--resume <session_id>] -- <payload>
```

`--` guards payloads beginning with a dash. Prompt is a positional arg (no
`--prompt` flag exists). `--trust` avoids the workspace-trust prompt in headless
mode. Child `cwd` is the session cwd; `cursor-agent` defaults its workspace to cwd.

## policy -> flags

| canonical | flags | native label |
| --- | --- | --- |
| read-only | `--mode plan` | `plan` |
| workspace-write | `--force --sandbox enabled` | `force+sandbox` |
| full-access | `--force --sandbox disabled` | `yolo` |

`--force` auto-runs tool calls (no interactive approval exists in headless
`--print`). The OS sandbox (`--sandbox enabled`) confines shell/filesystem to the
workspace for workspace-write; full-access disables it.

## stream-json events (one JSON object per line)

- `{type:'system', subtype:'init', session_id, model, apiKeySource:'login'}` —
  session id announced here -> `hooks.onSessionRef`. `login` = subscription auth.
- `{type:'user', ...}` — input echo; ignored.
- `{type:'thinking', subtype:'delta'|'completed', text}` -> `reasoning_summary`.
- `{type:'assistant', message:{content:[{type:'text',text}]}, timestamp_ms?}` —
  events WITH `timestamp_ms` are incremental deltas -> `text_delta`; the one
  WITHOUT is the cumulative echo and is skipped (else text doubles).
- `{type:'tool_call', subtype:'started'|'completed', call_id, tool_call:{<name>ToolCall:{args,result}}}`
  -> `tool_call` (started) / `tool_result` (completed). Tool name is the single
  key minus the `ToolCall` suffix (e.g. `shellToolCall` -> `shell`). `result` with
  a `success` key = ok, else error.
- `{type:'result', subtype:'success', is_error, result, usage:{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}`
  -> `run.completed` (final_text = `result`, usage mapped to input/output_tokens).

## capabilities

`resume:true` (via `--resume`), `discover:false` (`cursor-agent ls` needs a TTY /
Ink raw mode, unusable headlessly — codor resumes from its own persisted
session_ref, so discovery is not required), `ask:false`, `approvals:'spawn-time'`,
`extensions:false`, `thinking:false` (effort is expressed inside the `--model`
string, e.g. `claude-opus-4-8[effort=high]`), `live_inbox:false`.
