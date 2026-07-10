# Protocol

The room semantics. This is the spec other-harness adapters and all three surfaces implement
against. Wire format is JSON; schemas live in `@wireroom/protocol` (zod) once implementation
starts.

## 1. Members

```ts
Member {
  id: string            // stable ULID, never changes
  kind: 'human' | 'agent' | 'extension'
  handle: string        // unique per room, kebab-case, used in @mentions — renameable
  display_name: string  // free text shown in UI
  // agent + extension only:
  harness?: 'claude-code' | 'codex' | string   // adapter id, open set
  session_ref?: string  // harness-native session/rollout id (resume token)
  host?: string         // which switchboard machine owns the session
  state?: 'idle' | 'running' | 'queued' | 'awaiting_input' | 'paused' | 'dead'
  parent?: MemberId     // extensions only: the member whose run spawned them
}
```

- **An agent member is a session, not a harness.** Three Codex sessions in one room are three
  members (`coder`, `reviewer`, `red-team`), each with its own `session_ref` and context.
- **Renames** change `handle`/`display_name`, never `id`. A rename posts a `system` message. Old
  messages keep resolving because mentions store `member_id`, not the handle text.
- **Extensions** (subagents) are auto-added when observed, `handle` derived from their task id
  (`claude-ext-7adw`), auto-retired (`dead`) when the parent run ends. Not addressable in v1: the
  parser treats `@<extension>` as plain text. Post-MVP they may accept mentions while alive.
- **Humans** are members too — agents can (and should) tag `@richard` to report or ask.

## 2. Messages

```ts
Message {
  id: number            // per-room monotonic int — this is what #refs point at
  room: RoomId
  author: MemberId
  kind: 'chat' | 'run' | 'ask' | 'approval' | 'system'
  body: string          // markdown
  mentions: Segment[]   // resolved routing, see §3
  refs: number[]        // #ids referenced anywhere in body
  reply_to?: number     // threading hint for surfaces; does not affect routing
  run?: RunSummary      // kind='run' only
  ask?: AskCard         // kind='ask' only
  ts: string            // ISO-8601, switchboard clock
}

RunSummary {
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  started_ts: string; ended_ts?: string
  tool_calls: number
  usage?: { input_tokens, output_tokens, cost_usd? }   // as reported by the harness
  events_ref: string    // pointer to the JSONL event blob (see ARCHITECTURE §storage)
  final_text?: string   // the agent's closing message — this is the visible body
}
```

**Runs are one message.** When an agent starts a turn, the switchboard posts a `run` message
immediately (`status: running`) and streams events into its blob; surfaces render a live header
(elapsed, current tool, cost) and expand-on-click. On completion the same message is finalized
with `final_text` as its body. The room timeline never contains raw tool spam.

**Asks** (`kind: 'ask'`) carry a normalized question card: `{ prompt, options?: [{label,
description}], multi?: bool }`. Only humans may answer; the answer posts as a `chat` reply and the
switchboard feeds it back to the blocked session. **Approvals** are the same shape with
`options: [allow once | allow always | deny]` plus the tool/command being requested.

## 3. Mention grammar and routing

Parsing rules, applied to `body` (fenced code blocks and inline code are skipped):

1. `@handle` — a mention. Valid only if `handle` resolves to a live, addressable member of the
   room; otherwise it's plain text (no guessing, no fuzzy match).
2. Each mention opens a **segment**: from just after the tag to just before the next mention or
   end-of-message. The segment is what the mentioned member receives.
3. **Preamble** — text before the first mention — is room commentary. Everyone (human) can read
   it in the room; no agent receives it. This is deliberate: it's where status is narrated
   without inflating anyone's context.
4. `#N` — a reference. Wherever it appears, `N` is recorded in `refs`; references inside a
   segment are resolved and attached to *that* segment's delivery. A reference includes the
   target message's body verbatim (for `run` messages: `final_text`, not the event blob). One
   level deep — referenced messages' own refs are not chased.
5. **Default recipient.** A message with zero valid mentions is routed whole-body to the **last
   agent member that posted in the room**; if none exists, it's commentary. Agent-authored
   messages default to *the member whose message triggered their run* (usually the tagger),
   which makes plain "done, all tests pass" replies flow back to whoever delegated.
6. **Fan-out.** Multiple mentions produce independent deliveries, one per segment, in message
   order: `@codex xxx then @claude yyy` → Codex gets `xxx then`, Claude gets `yyy`. Mentioning
   the same member twice concatenates its segments into one delivery.
7. Self-mentions are ignored. `@all` is reserved (post-MVP broadcast). Escaping: `` `@codex` ``
   (backticks) renders the literal.

### Delivery payload

What actually lands in the recipient session's next turn — exact template:

```text
[wireroom room=traderjoe-eng msg=#93107 from=@richard (human)]

Start implementation of phase 3, see my comments in #92832 before starting.

--- referenced #92832 · @claude · 2026-07-10T02:14Z ---
The rebalance path still used stale closes; phase 3 must gate on fresh marks
before submitting. (…full body verbatim…)
--- end reference ---

[conventions: your reply posts to the room. Tag @claude / @richard to address
them; an untagged reply goes to @richard. Reference messages as #N.]
```

The conventions trailer is included on an agent's **first** delivery in a room and thereafter
only if it has misaddressed (posted an unresolvable mention). Keep payloads lean — sessions pay
tokens for every byte.

### Queueing

Harness sessions are single-threaded. Per-member FIFO inbox: deliveries to a `running` member
queue (`state: queued` shown in the room). On idle, **all queued deliveries for that member are
batched into one turn**, ordered, each with its `[wireroom …]` header — one resume call, no
interleaving ambiguity. A `paused` or `dead` member holds its queue; the room shows the backlog.

### Loop guards and budgets

Protocol-level, enforced by the switchboard (see VISION §principles — spend is a signal):

- **Hop budget**: max consecutive agent→agent deliveries with no human-authored message
  (default 8). On breach: the delivery is *held*, room gets a `system` message, humans get a
  push ("loop paused after 8 hops — release?"). Releasing grants another window.
- **Room spend meter**: cumulative `usage.cost_usd` per day, warning and hard-stop thresholds
  (defaults $10 warn / $25 stop, configurable). Hard-stop behaves like a hop-budget hold.
- **Turn timeout**: a run with no events for N minutes (default 30) is flagged `stalled` in the
  room; never auto-killed — operators kill, software doesn't.

## 4. Normalized events (adapter output)

Adapters translate harness-native streams into `WireEvent`s; the switchboard journals them into
the run blob and fans out live to surfaces:

```
run.started        { member, trigger_msg }
run.item           { type: 'tool_call'|'tool_result'|'reasoning_summary'|'text_delta'|
                     'commit'|'file_change', payload }        // rendered inside expanded runs
ask.raised         { card }                                   // blocks the run
approval.raised    { card }                                   // blocks the run
run.completed      { final_text, usage, status }
member.state       { member, state }                          // idle/running/queued/…
extension.started  { parent, ext_member }                     // subagent observed
extension.ended    { ext_member, summary? }
```

## 5. Harness feature matrix

What each adapter maps from; the normalization column is the contract surfaces rely on.

| Capability | Claude Code | Codex CLI | Normalized as |
| --- | --- | --- | --- |
| Headless drive + resume | Agent SDK `query({resume})` / `claude -p --resume <id> --output-format stream-json` | `codex exec --json [--sandbox …] resume <rollout-id> "<prompt>"` | adapter `deliver()` |
| Event stream | stream-json / SDK messages | `--json` JSONL events | `run.item` |
| Ask-user | `AskUserQuestion` (options, multi-select) | — (none) | `ask.raised` card; Codex: plain replies suffice, nothing raised |
| Permissions | permission modes + SDK `canUseTool` callback | sandbox modes (`read-only` ↔ `--dangerously-bypass…`), set at spawn | `approval.raised` (Claude, runtime) + a static **policy chip** on the member (both) |
| Subagents | Task tool; hooks (`SubagentStart/Stop`) + transcript JSONL | — | `extension.*` (Claude); n/a |
| Usage/cost | result usage block | token counts in events | `run.completed.usage` → room meter |
| Join-from-live-session | `/wireroom` skill + hooks (see ARCHITECTURE §ownership) | `wireroom join` CLI reading `~/.codex/sessions` | member with `session_ref` |
| Interrupt | SDK interrupt / SIGINT | SIGINT on child | member action `interrupt` |

**Extensibility:** an adapter is ~one file implementing `spawn / attach / deliver / interrupt`
(ARCHITECTURE §adapters). Zed's **Agent Client Protocol (ACP)** is evaluated in M0 as a shortcut:
where a maintained ACP adapter exists for a harness (Claude Code has one; others growing), our
adapter can be a thin ACP client instead of a CLI driver — reuse over rebuild.

## 6. Invariants

1. A recipient receives its segment + attached refs and **nothing else** — never the preamble,
   never other members' segments, never room history.
2. `Message.id` is dense and monotonic per room; `#N` is permanent (edits are new messages;
   there is no message deletion inside a room, only room deletion).
3. Every non-commentary message resolves to ≥1 recipient at post time; the composer surfaces
   the implied default so the human always sees where it will go before sending.
4. The switchboard never fabricates member speech. Everything attributed to a member came out of
   its session or its human's keyboard/microphone.
5. All state needed to rebuild a room (messages, members, session_refs, blobs) lives on the
   switchboard host. Clients are caches.
