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

Codex app-server can issue requests to its client. Runtime approvals ARE
bridged: non-yolo policies use `approvalPolicy:"on-request"`, so
`item/commandExecution/requestApproval` and `item/fileChange/requestApproval`
are surfaced as Codor approval cards (`approval.raised`) and parked by their
native `approvalId` (or `itemId`) until the operator answers via
`respondInteraction`. Operator choices map to the pinned 0.144.5 v2 decisions:
allow-once→`accept`, allow-for-session→`acceptForSession`, deny→`decline`; turn
teardown, client loss, and a request with no matching active turn (a non-null
`turnId` must exactly equal the established active turn id; a request bearing one
while the id is still the pre-turn placeholder is rejected) resolve
`cancel`/`decline`.

`item/permissions/requestApproval` is also bridged as an `approval.raised` card
that discloses the FULL requested profile (network + every fileSystem shape:
read/write/entries/globs). allow-once→`{permissions:<requested>,scope:"turn"}`,
allow-for-session→`scope:"session"`, deny/no-turn/teardown→`{permissions:{},
scope:"turn"}`; `strictAutoReview` is always false/omitted and never combined
with session scope.

`mcpServer/elicitation/request` is bridged for `url` mode only, honoring Codex's
own security boundary: the URL is surfaced only when HTTPS with a host and no
embedded credentials, framed as untrusted from the named MCP server and kept
inert (Codor never fetches or previews it); acceptance means the operator
completed it, not that Codor validated it. Response is the pinned `{action,
content:null, _meta:null}`: accept/decline by the operator, `cancel` on
teardown/stale/no-turn (including a between-turn null-`turnId` elicitation), and
an immediate `decline` for `form`/`openai/form` modes or an unsafe URL. The
elicitation card carries `serverName` + a stable elicitation id in its semantic
detail so two simultaneous elicitations never coalesce. Parking for permissions
and elicitation is keyed collision-proof by the JSON-RPC request id namespaced by
method + client generation.

`item/tool/requestUserInput` stays UNBRIDGED (experimental; needs a text-input
card and `capabilities.ask=true`) — the transport's immediate JSON-RPC error is
converted by 0.144.5 to empty answers rather than blocking. `full-access` stays
`approvalPolicy:"never"` with `danger-full-access` (--yolo runs unattended).

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
| `read-only` | `read-only` | `{type:"readOnly"}` | `on-request` |
| `workspace-write` | `workspace-write` | `{type:"workspaceWrite",networkAccess:false}` | `on-request` |
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
- `turn/plan/updated` is the authoritative agent task-checklist notification (below).

<!-- harn:assume normalized-agent-task-updates-are-bounded-and-authoritative ref=codex-plan-task-contract -->
### Task checklist: `turn/plan/updated`

The pinned 0.144.5 app-server emits `turn/plan/updated` as the ONLY task-checklist
source. Its params are `{ threadId, turnId, explanation?, plan: [{ step, status }] }`
where `status` is `pending`, `inProgress`, or `completed`. The adapter accepts it only
for the retained `threadId` (enforced by `routeNotification`) and only when `turnId`
equals the `currentTurnId` established by `turn/started`; it maps `step` to task
content, `inProgress` to `in_progress`, `plan-<index>` ids, and the optional
`explanation` to non-authoritative display context. An empty plan clears. A missing
active turn, mismatched turn/thread, unknown status, or malformed/over-bound plan emits
no task update. `item/plan/delta` (streamed plan-mode content), final answer text,
reasoning, and shell commands are explicitly NOT task-list sources.
<!-- harn:end normalized-agent-task-updates-are-bounded-and-authoritative -->

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
  surfaces. Codor bridges runtime command/file-change approvals (above) and
  active-turn steering (live inbox), but goals, rollback, subagents, and slash
  routing are intentionally not added. Manual compaction is exposed as an
  operator-only act (see `compactSession`).

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

Startup and authorized Refresh enumerate the installed app-server's `model/list`
in the background. The probe initializes the connection, requests pages with
`includeHidden: false`, follows `nextCursor`, and uses each visible entry's
`model` value (`id` is accepted for older responses). Concurrent discovery calls
share one probe. There is no Codor-owned list of model names.

The probe has a ten-second total enumeration deadline and at most 100 pages.
It closes its transport and confirms process exit, escalating its own child from
SIGTERM to SIGKILL if necessary (at most two additional seconds for cleanup).
It never creates a thread or starts a turn. Ordinary catalog API requests serve
the existing catalog and discovery-pending flag while this happens.

The existing executable, daemon cwd and environment are inherited unchanged,
including `CODEX_HOME`; no model, provider, catalog or context-window override is
added. Richard's custom Astra catalog/context setting is therefore untouched.
A pinned native catalog is still a snapshot: Refresh reports the installed
runtime's effective picker and cannot discover models excluded by that file.
Updating arbitrary user catalogs is outside this adapter's responsibility.

Older CLIs without `model/list`, malformed output and failed/timed-out probes
fall back to the existing custom-model entry when no catalog is available; an
existing last successful daemon catalog remains usable on failure. A successful
empty native catalog replaces the old list. A chosen model is still passed to
app-server unchanged, and native rejection remains an ordinary turn error.
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
