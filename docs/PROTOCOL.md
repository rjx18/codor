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
  // humans only — org access control (schema from day one, enforcement lands M5):
  role?: 'owner' | 'admin' | 'member' | 'observer'
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

**Mentions select recipients; content is never split.** Every recipient receives the *full*
message body plus all resolved references. Agents are trusted to read the whole message and work
out which parts concern them — exactly like a human in a group chat. (An earlier draft delivered
per-mention segments; dropped: harder to reason about, and messages often have dependencies
between the parts addressed to different members.)

Parsing rules, applied to `body` (fenced code blocks and inline code are skipped):

1. `@handle` — a mention, valid anywhere in the message. Valid only if `handle` resolves to a
   live, addressable member of the room; otherwise it's plain text (no guessing, no fuzzy
   match). The recipient set is the union of valid mentions (duplicates collapse).
2. `#N` — a reference. Each distinct `N` is recorded in `refs`, resolved once, and attached to
   every delivery of this message. A reference includes the target message's body verbatim (for
   `run` messages: `final_text`, not the event blob). One level deep — referenced messages' own
   refs are not chased.
3. `[[note-name]]` — a **ledger reference** (see §6): resolves to that note in the room's ledger
   and attaches its current content to every delivery, exactly like a `#N` ref. Unresolvable
   names stay plain text.
4. **Default recipient.** A message with zero valid mentions is delivered to the **last agent
   member that posted in the room**; if no agent has ever posted, it's room commentary
   (delivered to nobody). Agent-authored messages default to *the member whose message
   triggered their run* (usually the tagger), so a plain "done, all tests pass" flows back to
   whoever delegated.
5. **Fan-out.** Multiple mentions produce one delivery per recipient, each carrying the
   identical full payload: `@codex xxx then @claude yyy` → both receive the whole message; the
   header tells each who else got it.
6. Self-mentions are ignored (an agent tagging itself doesn't re-trigger itself). `@all` is
   reserved (post-MVP broadcast). Escaping: `` `@codex` `` (backticks) renders the literal.

### Delivery payload

What actually lands in each recipient session's next turn — exact template (identical for every
recipient of the message except the `you=` field):

```text
[wireroom room=traderjoe-eng msg=#93107 from=@richard (human)
 to=@codex @claude · you=@codex]

Nice work overnight. @codex Start implementation of phase 3, see my comments
in #92832 before starting. @claude while codex does that, draft the M4 test plan.

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

### Visibility and optional brakes

**Default: agents run until the work is done.** Agent→agent chains are the product, not a
hazard — the switchboard never interrupts them out of the box. What it does do is make spend
and progress impossible to miss, and offer opt-in brakes per room:

- **Room spend meter** (always on, never blocking): cumulative `usage.cost_usd` and turn count
  for the day, live in the room header on every surface.
- **Turn brake** (opt-in, off by default): max consecutive agent→agent deliveries with no
  human-authored message. On breach the next delivery is *held*, the room gets a `system`
  message, and humans get a push ("paused after N hops — release?"). For rooms where you want a
  checkpoint, not a leash.
- **Spend brake** (opt-in, off by default): daily cost threshold that holds like the turn brake.
- **Stall flag** (always on, never killing): a run with no events for N minutes (default 30) is
  flagged `stalled` in the room; operators kill, software doesn't.

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

Adapters are **plain CLI drivers by design** — every agent runs exactly as it would in a
terminal (`claude -p`, `codex exec`), spawned as a subprocess, spoken to over stdin/stdout
JSONL. No harness SDKs: nothing to couple to, and any coding agent with a headless mode and a
resumable session becomes integrable the same way.

| Capability | Claude Code | Codex CLI | Normalized as |
| --- | --- | --- | --- |
| Headless drive + resume | `claude -p --resume <session-id> --output-format stream-json --input-format stream-json` | `codex exec --json [--sandbox …] resume <rollout-id> "<prompt>"` | adapter `deliver()` |
| Event stream | stream-json JSONL on stdout | `--json` JSONL events | `run.item` |
| Ask-user | `AskUserQuestion` — surfaced as a control request on the stream-json control protocol | — (none) | `ask.raised` card; Codex: plain replies suffice, nothing raised |
| Permissions | permission modes; runtime prompts via the stream-json control protocol (`--permission-prompt-tool` fallback) | sandbox modes (`read-only` ↔ `--dangerously-bypass…`), set at spawn | `approval.raised` (Claude, runtime) + a static **policy chip** on the member (both) |
| Subagents | Task tool-calls in the stream; hooks (`SubagentStart/Stop`) + transcript JSONL | — | `extension.*` (Claude); n/a |
| Usage/cost | result usage block | token counts in events | `run.completed.usage` → room meter |
| Join-from-live-session | `/wireroom` skill + hooks (see ARCHITECTURE §ownership) | `wireroom join` CLI reading `~/.codex/sessions` | member with `session_ref` |
| Jump-into-member (attach TUI) | `claude --resume <session-id>` in your terminal | `codex resume <rollout-id>` | `wireroom attach <member>`; member goes mirrored until you exit |
| Interrupt | SIGINT on child | SIGINT on child | member action `interrupt` |

**Extensibility:** an adapter is ~one file implementing `spawn / attach / deliver / interrupt`
(ARCHITECTURE §adapters). Zed's **Agent Client Protocol (ACP)** is evaluated in M0 as a shortcut:
where a maintained ACP adapter exists for a harness (Claude Code has one; others growing), our
adapter can be a thin ACP client instead of a CLI driver — reuse over rebuild.

## 6. The ledger — shared memory as a graph

Partyline's "context threads" idea (shared decisions, constraints, contracts that any member can
read and extend), rebuilt local-first and graph-shaped:

- **Storage is an Obsidian-compatible vault**: a directory of markdown notes with `[[wikilink]]`
  edges, living beside the room store (`~/.wireroom/rooms/<room>/ledger/`). No database, no
  service — the graph *is* the link structure. Open it in Obsidian and you get the graph view
  for free; agents read and write it as plain files.
- **The switchboard bootstraps it**: enabling the ledger on a room initializes the vault
  (folders, templates for `decision`, `constraint`, `contract`, index note) and tells agent
  members where it lives and how to cite it (`[[name]]`) in their conventions trailer.
- **Reads are refs** (§3): citing `[[risk-limits]]` in a message attaches that note to the
  delivery — same explicit-context-transfer rule as everything else, no ambient injection.
- **Writes are auditable**: agents append/edit notes via `wireroom ledger` (or direct file
  edits in their cwd — it's their machine); the switchboard watches the vault and posts a
  compact `system` message on change ("@claude updated [[marker-semantics]]"), so the room sees
  memory evolve.
- **Multi-box safe by construction**: the vault exists only on the room's home switchboard
  (ARCHITECTURE §multi-box). Refs are resolved at delivery time by the home router, so members
  on other machines receive note content inside their payloads and never need the files;
  remote writes route through `wireroom ledger` to the home. One writer authority, zero sync.
- **Optional graph backend** (post-MVP): a temporal knowledge-graph engine (e.g. Graphiti) can
  index the same vault for time-aware queries; the vault stays the source of truth.

## 7. Invariants

1. A recipient receives the full message it was mentioned in, plus that message's refs, and
   **nothing else** — never ambient room history. Context transfer is always an explicit act:
   say it, or reference it with `#N`.
2. `Message.id` is dense and monotonic per room; `#N` is permanent (edits are new messages;
   there is no message deletion inside a room, only room deletion).
3. Every non-commentary message resolves to ≥1 recipient at post time; the composer surfaces
   the implied default so the human always sees where it will go before sending.
4. The switchboard never fabricates member speech. Everything attributed to a member came out of
   its session or its human's keyboard/microphone.
5. All state needed to rebuild a room (messages, members, session_refs, blobs) lives on the
   switchboard host. Clients are caches.
