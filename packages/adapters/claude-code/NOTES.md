# Claude Code CLI — behavioral spec (probed 2026-07-10, claude 2.1.209)

Everything below was observed live against the installed CLI. The JSONL files under
`fixtures/` are raw scrubbed captures (paths/usernames replaced, structure untouched) and are
the normative wire shapes the adapter and its tests replay. `*.stdin.jsonl` files are the
exact bytes the driver wrote to the CLI's stdin in the same probe. Contract drift must be
re-probed — never hand-edited into the fixtures.

## Invocation

```sh
claude -p --output-format stream-json --input-format stream-json --verbose \
  --permission-prompt-tool stdio [--permission-mode <mode>] [--effort <level>] \
  [--resume <session_id>] [--settings <abs-path.json>]
```

### Canonical spawn controls (rechecked 2026-07-14)

Claude Code 2.1.207 `--help` and the first-party
[CLI reference](https://code.claude.com/docs/en/cli-usage) document both
`--permission-mode` and `--effort`. Codor maps `read-only` to `plan`,
`workspace-write` to `acceptEdits`, and `full-access` to
`bypassPermissions`. It maps thinking `low`, `medium`, `high`, `xhigh`, `max`, and
`ultracode` directly to `--effort <level>`; `ultracode` is the CLI's xhigh plus dynamic
workflow-orchestration mode and requires workflows plus an xhigh-capable model. The adapter
declares those exact choices. Whether a particular provider/model or organization honors an
effort level is configuration-dependent. No model call was made for this verification, so a
native rejection is surfaced as a normal failed turn.

- `--verbose` is REQUIRED for stream-json output in print mode.
- **`--permission-prompt-tool stdio` is the control-protocol enabler, not a fallback.**
  Without it: `AskUserQuestion` is not even in the session's tool list (the model is told the
  tool doesn't exist), and no `can_use_tool` control requests are emitted. With it: permission
  prompts AND AskUserQuestion arrive as `control_request` lines on stdout, answered on stdin.
  (docs/ARCHITECTURE.md corrected accordingly.)
- User messages go in on stdin as JSONL:
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`.
  Closing stdin after the result ends the process cleanly. One `-p` process = one turn
  (`num_turns` counts assistant iterations within it).
- `--settings <file>` path resolves relative to the child cwd — pass absolute.
- `--resume <session_id>` KEEPS the same session_id (verified: init of `resume.jsonl` reports
  the id of `pong.jsonl`); `--fork-session` exists for id-changing forks. Transcripts persist
  under `~/.claude/projects/<cwd-slug>/<session_id>.jsonl` (the discovery store).

## Output stream (stdout JSONL)

- `system/init` is NOT guaranteed first: user-config hooks emit `system/hook_started` +
  `system/hook_response` BEFORE init (fixtures show a SessionStart hook pair). Tolerate
  arbitrary `system` subtypes anywhere (`thinking_tokens`, `task_started`, `task_updated`,
  `task_notification`, … observed).
- `system/init`: `{cwd, session_id, tools[], mcp_servers[], model, permissionMode,
  slash_commands[], apiKeySource, claude_code_version, agents[], skills[], plugins[], uuid,
  memory_paths, …}`.
- `assistant` events wrap FULL API message envelopes: `{type:"assistant", message:{id, model,
  content:[…], usage, …}, parent_tool_use_id, session_id, uuid}` — one event per content
  block delta batch; the same `message.id` can appear across several events (thinking block,
  then text block). `user` events carry tool_results back.
- `rate_limit_event`: `{rate_limit_info:{status, resetsAt, rateLimitType, …}}` — periodic,
  ignore for routing.
- `result`: `{subtype:"success"|…, is_error, result:"<final text>", stop_reason, session_id,
  num_turns, duration_ms, total_cost_usd, usage:{input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens, …}, modelUsage:{<model>:{…costUSD…}},
  permission_denials[], terminal_reason, uuid}` — the finalize signal; `result` is the
  final text, `total_cost_usd` the dollar cost (present, unlike codex).
- Subagent (Task) internals are NOT streamed at the top level (no assistant events with
  `parent_tool_use_id` set were observed around the Task call) — hooks are the authoritative
  extension signal (below).

## Control protocol (asks + permissions)

CLI → client, on stdout:

```jsonl
{"type":"control_request","request_id":"<uuid>","request":{
  "subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion",
  "input":{"questions":[{"question":"…","header":"…","options":[{"label":"…","description":"…"},…],"multiSelect":false}]},
  "tool_use_id":"toolu_…","requires_user_interaction":true}}
```

Permission requests are the same envelope with the target tool
(`tool_name:"Bash"`, `input:{command,…}`) plus `permission_suggestions[]`
(addRules/addDirectories/setMode candidates) and `blocked_path`.

Client → CLI, on stdin:

```jsonl
{"type":"control_response","response":{"subtype":"success","request_id":"<same uuid>","response":{
  "behavior":"allow","updatedInput":{…original input…, "answers":{"<question text>":"<label>"}}}}}
{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{
  "behavior":"deny","message":"denied by codor probe"}}}
```

- **AskUserQuestion answers ride `updatedInput.answers`**: a map keyed by the QUESTION TEXT,
  value = chosen option label; multi-select answers are comma-separated (per the CLI's own
  schema description). Free-text answers are allowed (the tool always offers a free-text
  path). Replying `behavior:"allow"` with `updatedInput` lacking `answers` reads as
  "dismissed without an answer" (probed) — the turn continues but no choice is recorded.
- After a valid answer the tool executes, a `user` event carries the tool_result, and the turn
  proceeds to `result` (fixture ends `result:"ALPHA"`). After a deny, the turn continues too —
  the model sees the denial and wraps up (`result:"DENIED"`, and `permission_denials[]` in the
  result is populated).
- `interrupt` is also a client→CLI `control_request` subtype on stdin (not probed; SIGINT on
  the child is the documented interrupt path we use).

## Hooks (extensions source)

`--settings` JSON injects hooks; matchers optional:

```json
{"hooks":{"SubagentStart":[{"hooks":[{"type":"command","command":"cat >> /abs/log.jsonl"}]}],
          "SubagentStop":[{"hooks":[{"type":"command","command":"cat >> /abs/log.jsonl"}]}]}}
```

Hook commands receive one JSON object on stdin (fixture `hooks-log.jsonl`):

- `SubagentStart`: `{session_id, transcript_path, cwd, prompt_id, agent_id, agent_type,
  hook_event_name}`
- `SubagentStop`: same + `{permission_mode, effort, stop_hook_active, agent_transcript_path,
  last_assistant_message, background_tasks[], session_crons[]}`

`agent_id` + `agent_type` name the extension member; `agent_transcript_path` points at the
subagent's own transcript. Both fired reliably in `-p` mode with a Task-spawning prompt
(fixture `hooks-subagent.jsonl` is the parent stream: the spawning tool_use IS visible — but
under the API name `Agent`, not `Task` — while subagent internals are not streamed; hooks are
authoritative, stream is enrichment only).

## Crash boundaries (asks) — what P0.8 reconcile implements

- **Kill while ask `pending`** (`kill-during-ask.jsonl` → SIGKILL right after the
  `control_request` arrived, never answered): on `--resume` with a nudge user message
  ("continue"), the model RE-RAISES the AskUserQuestion — as a NEW `tool_use_id` and NEW
  `request_id` (`kill-during-ask-resume.jsonl`). Re-correlation therefore CANNOT match on
  native ids; match on (member, tool_name, question content) or replace the card. Answering
  the re-raised request completes the turn normally (`result:"GAMMA"`).
- **Answered but not acked** (`answered-then-kill.jsonl` → control_response written to stdin,
  process SIGKILLed immediately, ack never observed): the answer DID NOT survive — the CLI
  had not persisted it; on resume the ask re-raises fresh (`answered-then-kill-resume.jsonl`),
  and REPLAYING the persisted answer is safe and idempotent (same choice, no double-execution,
  `result:"EPSILON"`). So: `answered`-but-not-`acked` + session re-raises ⇒ replay the stored
  answer against the NEW request ids; if nothing re-raises and the transcript shows the turn
  proceeded ⇒ mark `acked`; else orphan.
- A killed `-p` process emits nothing on the way out (no result event); exit code/signal is
  the only evidence. Resume requires a user message to start a new turn — nothing re-runs
  spontaneously.

The adapter persists confirmed spawn identity and the init `session_id` while the turn is
live. It does not infer completion from undocumented transcript-store internals: recorded
stream-json shapes remain normative, while an incomplete started process is held unless the
documented interaction re-correlation path applies after that process is known dead.

## Capabilities (for P0.7)

`{resume: true, discover: true, interactiveAttach: true, ask: true, approvals: 'runtime',
extensions: true, thinking: true, thinking_levels: ['low', 'medium', 'high', 'xhigh', 'max',
'ultracode']}`.

## Probe log (spend discipline)

One live probe per fixture (subscription auth; `total_cost_usd` visible in captures). Extra
probes beyond the plan's list: 2 failed ask-protocol attempts (one without
`--permission-prompt-tool stdio` — AskUserQuestion absent from the tool list; one with the
answer wrongly encoded per-question — read as "dismissed"), kept until the `answers`-map
encoding was confirmed from the CLI binary's own schema strings. No quota/auth exhaustion; no
fixture is MISSING. Probes ran with the user's global config (visible as SessionStart hook
events + plugin/skill lists in init) — scrubbed of paths only.


<!-- harn:assume adapters-own-their-model-catalog ref=claude-code-model-catalog-notes -->
## Model catalog (U3): curated aliases

`claude` has NO model-listing subcommand, so `listModels()` returns a curated list rather
than discovering one. Evidence: `claude --help` documents `--model <model>` as "Provide an
alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name
(e.g. 'claude-fable-5')". Probed 2026-07-12; no model call was made.

The catalog reports **aliases** (`haiku`, `sonnet`, `opus`, `fable`), not dated ids, and
that is deliberate: an alias resolves to the latest model of its tier by definition, so it
cannot go stale the way a pinned id does. An operator who needs a specific version uses the
dialog's `Custom…` escape, which the CLI accepts as "a model's full name".

Thinking is supported (`thinking:true`), so the thinking row is enabled.
<!-- harn:end adapters-own-their-model-catalog -->

<!-- harn:assume live-inbox-capability-is-evidence-backed ref=claude-live-inbox-notes -->
## Live inbox (LC3)

Claude Code 2.1.207 was rechecked on 2026-07-13 without a model call. A local fake Anthropic
SSE endpoint proved that a second stream-json user frame written while `Bash` was running is
included beside the tool result in the next model request. Codor does not use that steering
path in this round because its adapter contract has no live-delivery ingress or consumption
acknowledgement. Instead, the generated settings add the specified `PostToolUse` command
`codor inbox --new --consume --format hook`; the member environment inherited by the child
authorizes that command. Therefore this adapter declares `live_inbox:true`.
<!-- harn:end live-inbox-capability-is-evidence-backed -->
