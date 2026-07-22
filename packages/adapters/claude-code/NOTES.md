# Claude Agent SDK — behavioral spec

Phase 5b (2026-07-17) replaces Codor's per-turn raw `claude -p` driver with the
first-party `@anthropic-ai/claude-agent-sdk`. The implementation mirrors Paseo's
provider architecture: one `query()` over streaming user input lives across
multiple turns, with an injected `ClaudeQueryFactory` in tests.

No live Claude CLI or model/API call was made for Phase 5b. Runtime shapes are
pinned by the installed SDK declarations and fixture-only Query mocks. The JSONL
files under `fixtures/` remain immutable scrubbed captures from the earlier
2026-07-10 CLI probe. Their parsed objects use the same system/assistant/user/result
envelopes yielded by the SDK, so they remain translator evidence; their
`*.stdin.jsonl` control responses are historical evidence only.

<!-- harn:assume claude-sdk-message-contract-preserves-normalized-runs ref=claude-sdk-message-contract -->
## Query lifetime and message contract

Production calls:

```ts
query({
  prompt: asyncUserMessageIterable,
  options: {
    cwd,
    model,
    resume: sessionId,
    permissionMode,
    thinking: { type: 'adaptive' },
    effort,
    canUseTool,
    hooks,
    env,
  },
})
```

- The async prompt remains open. Each `deliver()` pushes one `SDKUserMessage`;
  a single pump iterates the Query across terminal results.
- `system/init.session_id` is persisted immediately. If the Query iterator
  throws or ends, the active turn fails (unless explicitly interrupted) and the
  next delivery creates a fresh Query with `resume` set to that session id.
- A fresh translator handles each Codor turn. Only session id and context-window
  max/used telemetry carry across turns and Query recreation; tool call maps,
  pending terminal state, and interaction state never leak between turns.
- The Claude Code preset plus `user`, `project`, and `local` setting sources are
  enabled, matching Paseo. `process.env` is overlaid by the member session env.
- `includePartialMessages` is enabled. Codor currently normalizes complete
  assistant objects and safely ignores partial stream events.

Message semantics retained from the SDK/captured envelopes:

- `system/init`: `{session_id, model, permissionMode, ...}`; hooks may precede it.
- `assistant`: full API message envelope with content blocks and usage.
- `user`: tool results returned by Claude Code.
- `result`: the turn terminal object, including success/error subtype, usage,
  cost, modelUsage, and session id.
- `rate_limit_event`: reported provider windows; unknown shapes are ignored.
<!-- harn:end claude-sdk-message-contract-preserves-normalized-runs -->

## Canonical controls

Codor retains its canonical declarations and maps them to SDK Options:

- `read-only` → `permissionMode: "plan"`
- `workspace-write` → `permissionMode: "acceptEdits"`
- `full-access` → `permissionMode: "bypassPermissions"` with
  `allowDangerouslySkipPermissions: true`
- `low`, `medium`, `high`, `xhigh`, and `max` → adaptive thinking plus the same
  `effort` value
- `ultracode` → adaptive thinking, `effort: "xhigh"`, and
  `settings.ultracode: true`, matching Paseo

Whether a provider/model/organization honors an effort level remains
configuration-dependent; a native rejection is a normal failed turn.

<!-- harn:assume claude-result-errors-follow-native-signals ref=claude-result-error-contract -->
## Result failure contract

The Agent SDK distinguishes `SDKResultSuccess` from `SDKResultError`. Error
results have a non-success subtype such as `error_during_execution`, `is_error`,
and `errors: string[]`; success results carry `result`. Codor keys failure on
those native fields, places detail in `run.completed.error`, and never promotes
it to `final_text`. The known “Prompt is too long” match remains only a legacy
secondary guard.

`test-fixtures/context-overflow.jsonl` is a minimal contract-derived error object
including the synthesized assistant API-error message from the incident. The
regression proves that the terminal error is structurally separate from reply
text.
<!-- harn:end claude-result-errors-follow-native-signals -->

<!-- harn:assume claude-compaction-follows-native-system-events ref=claude-compaction-system-contract -->
## Compaction messages

The SDK yields two native system objects:

- `subtype: "status", status: "compacting"` → loading compaction timeline item
- `subtype: "compact_boundary", compact_metadata: {trigger, pre_tokens,
  post_tokens?}` → completed item plus context-usage re-baseline

`test-fixtures/compaction.jsonl` records the declared automatic and manual
shapes. The long-lived SDK Query makes the already-shipped Phase 4 plumbing
reachable without any Codor threshold trigger; `/compact` is passed through as
an ordinary user message and Claude owns when compaction occurs.
<!-- harn:end claude-compaction-follows-native-system-events -->

<!-- harn:assume claude-sdk-permissions-back-codor-interactions ref=claude-sdk-permission-callback -->
## Permissions and AskUserQuestion

The SDK's `canUseTool(toolName, input, options)` callback is the only active
permission channel. Codor creates a unique interaction id, emits one
`ask.raised` for `AskUserQuestion` or `approval.raised` for another tool, and
parks the callback promise.

`respondInteraction()` settles that exact callback:

- Ask answers return `behavior: "allow"` with `updatedInput.answers` keyed by
  question text (arrays become comma-separated multi-select values).
- `allow once` returns the original `updatedInput`.
- `allow always` additionally returns the SDK's complete permission suggestions.
- `deny` returns a denial message.

SDK abort, Query failure/exit, or interrupt rejects and removes unresolved
callbacks. A resolved callback is the acknowledgement boundary; the obsolete
stdout-progress waiter and stdin `control_response` encoder are deleted.
<!-- harn:end claude-sdk-permissions-back-codor-interactions -->

<!-- harn:assume claude-sdk-hooks-are-authoritative ref=claude-sdk-hook-contract -->
## Hooks

Programmatic SDK hook callbacks replace the generated `--settings` file and
loopback HTTP endpoint entirely:

- `SubagentStart` and `SubagentStop` map their native `agent_id`, `agent_type`,
  session id, summary, and transcript paths to the existing extension events.
- `PostToolUse` runs `codor inbox --new --consume --format hook` in the member
  cwd/environment. Empty stdout returns an empty hook result; non-empty stdout
  is parsed and returned as the SDK `HookJSONOutput`, injecting Codor inbox
  context exactly as before.

Task/Agent tool-use stream objects remain enrichment only; hooks are the
authoritative extension lifecycle source.
<!-- harn:end claude-sdk-hooks-are-authoritative -->

## Interrupt and recovery

`interrupt(session)` completes the active Codor turn as interrupted, calls the
active Query's `interrupt()`, closes its streaming input/Query, and rejects
pending permissions. A later delivery starts a fresh Query with `resume`, so an
operator interrupt or dead runtime cannot strand the member or lose its native
conversation.

The older raw fixtures still document useful crash facts: a killed process emits
no terminal result, and an unanswered/just-answered permission may re-raise with
fresh native ids on resume. The SDK now owns that control replay; Codor keeps its
semantic interaction reconciliation rather than depending on provider ids.

<!-- harn:assume adapters-own-their-model-catalog ref=claude-code-model-catalog-notes -->
## Model catalog

Claude Code has no stable zero-spend model-listing command suitable for the
existing background catalog interface, so `listModels()` retains the curated
aliases `haiku`, `sonnet`, `opus`, and `fable`. Aliases deliberately track the
latest tier; operators may still enter a full custom model id.
<!-- harn:end adapters-own-their-model-catalog -->

<!-- harn:assume live-inbox-capability-is-evidence-backed-v2 ref=claude-live-inbox-notes -->
## Live inbox

Claude remains one of two first-party adapters declaring `live_inbox: true`. The
exact existing command, `codor inbox --new --consume --format hook`, now runs
inside the SDK `PostToolUse` callback with the member environment. Its parsed
hook output is returned to Claude. Codex has its separate native `turn/steer`
channel; the other built-ins retain their documented false capability.
<!-- harn:end live-inbox-capability-is-evidence-backed-v2 -->

## Probe/spend record

The raw capture set was paid/probed once on 2026-07-10 and is unchanged. Phase
5b added no empirical query, CLI probe, or model/API request: all lifecycle,
permission, hook, usage, compaction, and failure tests use injected Query mocks
or parsed local fixtures.
