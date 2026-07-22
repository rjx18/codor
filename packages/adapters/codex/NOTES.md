# Codex app-server behavioral contract (installed Codex 0.144.5)

Phase 5c replaces the retired per-turn `codex exec --json` driver with one
long-lived `codex app-server` process per Codor member. This phase made no live
Codex invocation and no model/API call. The contract below was pinned from the
locally installed `@openai/codex` package metadata (0.144.5), the matching
`rust-v0.144.5` first-party app-server protocol source, and fixture-only fake
server tests.

<!-- harn:assume codex-app-server-contract-is-pinned-to-0-144-5 ref=codex-app-server-contract-notes -->
## Process and transport

Codor starts exactly:

```text
codex app-server
```

stdin and stdout carry one JSON object per line. Requests and responses use a
numeric `id`; notifications omit it. Codex 0.144.5 does not require a
`"jsonrpc":"2.0"` field, so Codor does not send one.

Every replacement process performs this handshake once:

1. `initialize` with `clientInfo:{name:"codor",title:"Codor",version:"0.1.0"}`
2. `initialized` notification
3. `thread/resume` when `session_ref` already exists, otherwise `thread/start`
   immediately before the first turn
4. any number of `turn/start` calls on that thread

The `thread/start` response's `thread.id` is stored unchanged as `session_ref`.
An attached/revived member passes its persisted id directly to `thread/resume`.
The process is retained only while cwd, model, policy, thinking, and merged
member environment remain unchanged. Exit, crash, or identity mismatch closes
that transport; the next delivery starts a new process and resumes the same
thread id.

Codex app-server can issue requests to its client. Runtime approvals remain out
of scope: every thread/turn uses `approvalPolicy:"never"`, and an unexpected
`item/commandExecution/requestApproval` or `item/fileChange/requestApproval`
is explicitly declined rather than parked or converted to a Codor card.

## Exact 0.144.5 request shapes

All active v2 fields are camelCase:

- `thread/start`: `cwd`, optional `model`, `approvalPolicy`, `sandbox`
- `thread/resume`: the same fields plus required `threadId`
- `turn/start`: `threadId`, `input:[{type:"text",text,text_elements:[]}]`,
  `cwd`, optional `model`/`effort`, `approvalPolicy`, `sandboxPolicy`
- `turn/interrupt`: `threadId`, `turnId`

The canonical policy mappings are:

| Codor policy | thread sandbox | turn sandboxPolicy | approvalPolicy |
| --- | --- | --- | --- |
| `read-only` | `read-only` | `{type:"readOnly"}` | `never` |
| `workspace-write` | `workspace-write` | `{type:"workspaceWrite",networkAccess:false}` | `never` |
| `full-access` | `danger-full-access` | `{type:"dangerFullAccess"}` | `never` |

Thinking is the 0.144.5 `turn/start.effort` value (`low`, `medium`, `high`,
`xhigh`, `max`, or `ultra`). Model is supplied on thread start/resume and every
turn so a replacement process cannot silently drop the durable member config.

## Notifications and normalized events

The adapter consumes these v2 notifications for the member's root `threadId`:

- `turn/started` identifies the interruptible turn.
- `item/started` / `item/completed` map `agentMessage`, `reasoning`,
  `commandExecution`, `fileChange`, `mcpToolCall`, and `dynamicToolCall` into
  bounded normalized run items. Unknown future item types are ignored.
- `thread/tokenUsage/updated` produces `usage_updated` and supplies the latest
  terminal `agent_usage` snapshot.
- canonical `contextCompaction` items and compatibility `thread/compacted`
  produce Phase 4 compaction timeline items.
- `turn/completed.turn.status` is authoritative for completed, failed, or
  interrupted. Failure detail comes from `turn.error.message` and is emitted as
  `run.completed.error`, never as reply text.

Token usage is the exact 0.144.5 camelCase shape:

```json
{
  "tokenUsage": {
    "last": {
      "totalTokens": 7000,
      "inputTokens": 6000,
      "cachedInputTokens": 3000,
      "outputTokens": 1000
    },
    "modelContextWindow": 200000
  }
}
```

`last.totalTokens` becomes `contextWindowUsedTokens` and
`modelContextWindow` becomes `contextWindowMaxTokens`; they are emitted only as
a pair. Codex reports no dollar cost here, so the adapter never invents
`totalCostUsd` or legacy `cost_usd`.

Codex 0.144.5 documents `thread/compacted` as deprecated in favor of the
`contextCompaction` item, but can expose both completion channels. Following
Paseo, per-turn unpaired counters suppress the second completion regardless of
arrival order. Item start emits `loading`; the single completion emits
`completed`. Auto-compaction reports `trigger:"auto"`.

Manual compaction IS in this adapter (`compactSession`). `thread/compact/start`
returns `{}` immediately and the work runs as a STANDALONE native turn, so the
sequence to observe is: `turn/started` (its `turn.id` is the compact turn) ->
`item/started` + `item/completed` for the canonical `contextCompaction` item
(both carry `threadId` and `turnId`, with top-level `startedAtMs` and
`completedAtMs` respectively) -> any
`thread/tokenUsage/updated` for that `turnId` -> the authoritative
`turn/completed`. The re-baseline is whatever that correlated usage reported;
`thread/compacted` is exactly `{threadId, turnId}` and is compatibility
evidence only — it never carries usage and never settles a compaction.

## Deliberate divergences from Paseo

- Paseo accepts historical snake_case aliases such as
  `model_context_window`/`total_tokens`. Codor pins the installed 0.144.5 wire
  and accepts only `modelContextWindow`/`totalTokens`; a future alias requires
  captured or first-party contract evidence.
- Paseo carries several legacy `codex/event/*` notification shims and loads a
  much broader persisted timeline. Codor consumes the canonical v2 methods
  needed by its existing normalized contract and tolerates unknown methods.
- Paseo uses `thread/loaded/list` before some resumes because it manages a
  larger provider session surface. A fresh Codor process directly issues
  `thread/resume` for its one persisted member thread.
- Paseo exposes runtime approvals, steering, goals, rollback, and subagent
  surfaces. Those are intentionally not added here. Codor keeps its existing
  spawn-time-only approval capability and no slash routing. Manual compaction is
  the exception: it is exposed, as an operator-only act (see `compactSession`).

The in-memory fake app-server copies Paseo's harness shape: paired PassThrough
streams, automatic request responses, notification injection, server-request
round trips, and explicit crash/exit controls. `app-server-turn.jsonl` contains
the immutable contract-derived item, usage, compaction, and terminal objects.
No unit test launches `codex`.
<!-- harn:end codex-app-server-contract-is-pinned-to-0-144-5 -->

## Historical exec captures

The raw scrubbed files under `fixtures/` remain unchanged evidence from the
retired `codex exec --json` implementation (0.144.1): success/resume, sandbox
refusal, tool/file items, interrupt, process kill, and failures. Their parser
tests remain so provenance does not rot, but those dotted event names and
per-turn process behavior are no longer the active adapter contract.

The spend-gated `live.spec.ts` now exercises two turns through app-server when
`CODOR_LIVE_SMOKE=1`. It was not enabled in Phase 5c.

<!-- harn:assume adapters-own-their-model-catalog ref=codex-model-catalog-notes -->
## Model catalog

The adapter does not perform model discovery on request paths. The curated
catalog remains the existing documented set: `gpt-5.6-luna`, `gpt-5.6-terra`,
`gpt-5.6-sol`, and `gpt-5.5`. App-server receives the selected id as `model`;
provider/model rejection becomes an ordinary failed turn. No model call was
made while migrating the transport.
<!-- harn:end adapters-own-their-model-catalog -->

<!-- harn:assume live-inbox-capability-is-evidence-backed-v2 ref=codex-live-inbox-notes -->
## Live inbox

The retained app-server routes active Codor inbox input through `turn/steer`
with the current `threadId` and required `expectedTurnId`. Only a response naming
that same turn acknowledges delivery; idle races and RPC failures leave the
message queued for the next ordinary turn. The adapter therefore declares
`live_inbox:true` without changing spawn-time approvals or starting another
turn.
<!-- harn:end live-inbox-capability-is-evidence-backed-v2 -->
