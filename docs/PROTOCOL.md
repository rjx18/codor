# Protocol

<!-- harn:assume human-facing-surfaces-call-rooms-channels ref=protocol-channel-equivalence -->
A channel (protocol: room) is the human-facing workspace described by these channel semantics.
<!-- harn:end human-facing-surfaces-call-rooms-channels -->
This is the spec other-harness adapters and all three surfaces implement
against. Wire format is JSON; schemas live in `@codor/protocol` (zod) once implementation
starts.

## 1. Members

```ts
Member {
  id: string            // stable ULID, never changes
  kind: 'human' | 'agent' | 'extension' | 'system' | 'bridge'
  handle: string        // unique per channel, /^[a-z0-9][a-z0-9-]{1,30}$/, renameable
                        // reserved (never assignable): 'all', 'switchboard'
  display_name: string  // free text shown in UI
  purpose?: string      // operator-authored role in this channel
  // agent + extension only:
  harness?: 'claude-code' | 'codex' | string   // adapter id, open set
  session_ref?: string  // harness-native session/rollout id (resume token)
  cwd?: string          // persisted launch dir — resume/revive MUST reuse it
  policy?: string       // sandbox/permission mode chip
  host?: string         // which switchboard machine owns the session
  state?: 'idle' | 'running' | 'queued' | 'awaiting_input' | 'paused' | 'dead'
        | 'unreachable'        // resident switchboard offline (multi-box)
        | 'custody_uncertain'  // attach lease lost but native process not confirmed dead —
                               // the daemon must NOT drive the session until confirmed
  parent?: MemberId     // extensions only: the member whose run spawned them
  // humans only — org access control (schema from day one, enforcement lands M5):
  role?: 'owner' | 'admin' | 'member' | 'observer'
  removed_ts?: string   // tombstone timestamp; attribution remains intact
}
```

- **An agent member is a session, not a harness.** Three Codex sessions in one channel are three
  members (`coder`, `reviewer`, `red-team`), each with its own `session_ref` and context.
- **Renames** change `handle`/`display_name`, never `id`. A rename posts a `system` message. Old
  messages keep resolving because mentions store `member_id`, not the handle text.
<!-- harn:assume member-removal-timestamp-protocol ref=member-removal-documentation -->
- **Removal tombstones dead members; it never deletes identity.** The `remove` act is valid only
  for a `dead` member and records `removed_ts` while retaining the row for historical message
  attribution. Removed members are absent from rosters, handle uniqueness, default recipients,
  and member surfaces, so a replacement may reuse the freed handle without retargeting old
  messages. A dead member with a resumable session is revived; one without a session is removed
  and respawned.
<!-- harn:end member-removal-timestamp-protocol -->
- **Extensions** (subagents) are auto-added when observed, `handle` derived from their task id
  (`claude-ext-7adw`), auto-retired (`dead`) when the parent run ends. Not addressable in v1: the
  parser treats `@<extension>` as plain text. Post-MVP they may accept mentions while alive.
- **Humans** are members too — agents can (and should) tag `@richard` to report or ask. Every
  channel is created with its **owner human member** seeded; the authenticated principal (pairing
  token or device key) maps to a human member, and that member is the `author` of everything it
  posts. A delivery addressed to a human is an **inbox/notification record** — it never spawns
  an adapter turn.
- **System and bridge members are non-addressable and post-only.** Every channel has a `system`
  member (`switchboard`) that authors system messages — which NEVER route (see §3
  eligibility). A `bridge` member relays an external platform (Slack/Telegram): its posts
  carry `origin{platform, external_id, sender_name}` for dedup and echo-suppression, and it
  can never answer asks, release holds, or be @-mentioned.
- **Roles gate human acts** (agents are governed by their harness policy chip instead):
  `observer` reads; `member` + posts, answers asks/approvals addressed to them, releases holds;
  `admin` + spawns/renames/kills/revives agents, sets brakes, manages the ledger, enables
  bridges; `owner` + manages keys, devices, roles, and channel lifecycle. Single-operator default:
  the seeded human is `owner`. This table is the one authoritative role matrix.

## 2. Messages

```ts
Message {
  id: number            // per-channel monotonic int — this is what #refs point at
  room: RoomId
  author: MemberId
  kind: 'chat' | 'run' | 'ask' | 'approval' | 'system'
  body: string          // markdown
  mentions: MentionSpan[]  // resolved at post/finalize time, see §3
  refs: number[]        // #ids referenced anywhere in body
  ledger_refs: string[] // [[note]] names referenced (§6)
  reply_to?: number     // threading hint for surfaces; does not affect routing
  run?: RunSummary      // kind='run' only
  ask?: AskCard         // kind='ask'|'approval' only
  origin?: BridgeOrigin // bridge-authored only; unique per (bridge member, platform, external_id)
  ack?: boolean         // exact ACK_OK turn; defaults false
  ts: string            // ISO-8601, switchboard clock
  seq: number           // channel change-sequence at last insert/update (see sync note below)
}

BridgeOrigin { platform: 'slack' | 'telegram' | string, external_id: string, sender_name: string }

MentionSpan { member_id: string, start: number, end: number }  // resolved spans — survive renames

AskCard {
  interaction_id: string       // correlates with the adapter's pending native request
  kind: 'ask' | 'approval'
  prompt: string
  options?: { label: string, description?: string }[]
  multi?: boolean
  tool?: string                // approvals: the tool/command being requested
  detail?: string              // approvals: command text / input summary
}

RunSummary {
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  started_ts: string; ended_ts?: string
  stalled_since?: string   // watchdog flag: no events for stall_minutes — informational only
  tool_calls: number
  usage?: { input_tokens, output_tokens, cost_usd? }   // as reported by the harness
  events_ref: string    // pointer to the JSONL event blob (see ARCHITECTURE §storage)
  final_text?: string   // the agent's closing message — this is the visible body
}
```

**Runs are one message — and the reply IS that message.** When an agent starts a turn, the
switchboard posts a `run` message immediately (`status: running`) and streams events into its
blob; surfaces render a live header (elapsed, current tool, cost) and expand-on-click. On
completion the SAME message is finalized in place: `final_text` becomes its body, and its
mentions/refs are parsed **from that finalized message** for onward routing. One turn, one
message, one permanent `#N` — no duplicate "reply" message is ever created.

<!-- harn:assume acknowledgement-marker-protocol ref=ack-protocol-documentation -->
**`<ACK_OK>` ends acknowledgement cascades.** Every agent briefing instructs the member to
respond with exactly `<ACK_OK>` when a message needs no substantive reply. A finalized
`final_text` is an acknowledgement only when `trim()` equals that marker case-sensitively;
containment does not count. The same run message keeps its verbatim body and is stored with
`ack: true`, but mention parsing and onward routing are skipped and it cannot become the latest
finalized default recipient. Surfaces render it as one muted `✓ @handle acknowledged` line;
the run journal remains available from the permalink.
<!-- harn:end acknowledgement-marker-protocol -->

**Asks and approvals block the run, with a crash-safe state machine.**

```ts
PendingInteraction {
  id: string; room: RoomId; member_id: MemberId      // the blocked agent
  message_id: number                              // the ask/approval card message
  native_id: string; kind: 'ask' | 'approval'
  targets: MemberId[]      // humans whose inbox gets it — the trigger-chain's human, else
                           // every human with role ≥ member (first answer wins)
  state: 'pending' | 'answered' | 'acked' | 'orphaned'
  answer?: unknown; answered_by?: MemberId; answered_ts?: string
}
```

The adapter raises → switchboard persists (`pending`), posts the card, member goes
`awaiting_input`. A human answers → `answered`, `respondInteraction(session, interaction_id,
answer): Promise<void>` resolves on adapter acknowledgement → `acked` and the run resumes. The
answer is recorded as an **audit reply on the card (`reply_to`), which never routes** — the
router must not queue a second turn at the blocked agent. **Crash boundaries** (both probed as
conformance fixtures before schemas lock): restart with a still-`pending` interaction — if
resuming the session re-raises the request it re-correlates, else `orphaned` (expired card,
redeliver option); restart with an `answered`-but-not-`acked` interaction — the persisted
answer is replayed via `respondInteraction` if the session still blocks on it (replay must be
idempotent), marked `acked` if the turn demonstrably proceeded, and `orphaned` (hold, never
auto-resend an approval) when neither can be established. Probed reality (P0.2 fixtures,
Claude Code): a re-raised request carries FRESH native ids (`request_id`, `tool_use_id`) and
only appears once a new turn is nudged — re-correlation must match on (member, tool,
question content), never on native ids; the pre-crash answer is never persisted by the
harness, and replaying it against the re-raised request is idempotent. Asks raised mid
agent-to-agent chain target the chain's originating human. Approvals carry `tool`/`detail` and options
`allow once | allow always | deny`.

**Sync.** A per-channel **change log** `(seq, entity, entity_id)` records every insert and
in-place update across ALL client-visible entities — messages (incl. run finalization),
members, human inbox records, meters, channel config. Clients reconnect with `since_seq` and
receive hydrated changed rows from one consistent snapshot; `seq` is the only delta-sync
cursor. Hydration entity frames retain the client's requested cursor, then a final
`sync_complete {seq}` frame commits the snapshot cursor. Disconnecting before that final frame
therefore replays the partial hydration rather than skipping unseen rows.

**Human inbox lifecycle.** A delivery addressed to a human is an inbox record with `read_ts?`;
the `mark_read` act sets it; unread counts derive from it; inbox changes flow through the
change log like everything else.

## 3. Mention grammar and routing

**Routing eligibility comes first.** Routed: `chat` messages authored by a human, agent, or
bridge member (bridge posts carry external humans' words), and **finalized** `run` messages.
Never routed: `system` messages (ledger notices, renames, holds), `ask`/`approval` cards,
audit replies on cards, and anything authored by the `system` member — none of these can ever
trigger an agent turn. A bridge can author routable messages but is never a recipient.
**An empty-bodied finalized run still finalizes and displays, but never routes**, whether its
status is `completed` or `interrupted`: it has no explicit recipient and applying the untagged
default caused two live agents to enter an endless empty acknowledgement loop during M0
acceptance.

**Mentions select recipients; content is never split.** Every recipient receives the *full*
message body plus all resolved references. Agents are trusted to read the whole message and work
out which parts concern them — exactly like a human in a group chat. (An earlier draft delivered
per-mention segments; dropped: harder to reason about, and messages often have dependencies
between the parts addressed to different members.)

Parsing rules, applied to `body` (fenced code blocks and inline code are skipped):

1. `@handle` — a mention, valid anywhere in the message. Valid only if `handle` resolves to an
   **addressable** member of the channel; otherwise it's plain text (no guessing, no fuzzy match).
   Addressable = humans and agents in any state (`dead`/`paused` members queue deliveries until
   revived/unpaused); NOT addressable = extensions and the reserved `@all`. Mentions are stored
   as resolved spans `{member_id, start, end}`, so occurrence order is kept and renames never
   break old messages. The recipient set is the union of valid mentions (duplicates collapse).
2. `#N` — a reference. Each distinct `N` is recorded in `refs`, resolved once, and attached to
   every delivery of this message. A reference includes the target message's body verbatim (for
   `run` messages: `final_text`, not the event blob). One level deep — referenced messages' own
   refs are not chased.
3. `[[note-name]]` — a **ledger reference** (see §6): resolves to that note in the channel's ledger
   and attaches its current content to every delivery, exactly like a `#N` ref. Unresolvable
   names stay plain text.
4. **Default recipient.** A human-authored (or bridge-relayed) message with zero valid
   mentions is delivered to the author of the **latest FINALIZED agent message** in the channel
   (a still-running placeholder never counts); if no agent has ever finished a turn, it's channel
   commentary (delivered to nobody).
   Agent-authored messages default to *the member whose message triggered their run* (for a
   batched turn: the author of the last delivery in the batch), so a plain "done, all tests
   pass" flows back to whoever delegated.
   **Misaddressing:** `parseBody` also returns unresolved handle-shaped tokens (`@word` that
   matches no member); a finalized agent message containing one sets the member's
   `misaddressed` flag (clears after its next delivery re-includes the conventions trailer).
5. **Fan-out.** Multiple mentions produce one delivery per recipient, each carrying the
   identical full payload: `@codex xxx then @claude yyy` → both receive the whole message; the
   header tells each who else got it.
6. Self-mentions are ignored (an agent tagging itself doesn't re-trigger itself). `@all` is
   reserved (post-MVP broadcast). Escaping: `` `@codex` `` (backticks) renders the literal.

### Delivery payload

What actually lands in each recipient session's next turn — exact template (identical for every
recipient of the message except the `you=` field):

```text
[codor channel=traderjoe-eng msg=#93107 from=@richard (human)
 to=@codex @claude · you=@codex]

Nice work overnight. @codex Start implementation of phase 3, see my comments
in #92832 before starting. @claude while codex does that, draft the M4 test plan.

--- referenced #92832 · @claude · 2026-07-10T02:14Z ---
The rebalance path still used stale closes; phase 3 must gate on fresh marks
before submitting. (…full body verbatim…)
--- end reference ---

[conventions: your reply posts to the channel. Tag @claude / @richard to address
them; an untagged reply goes to @richard. Reference messages as #N.]
```

The conventions trailer is included on an agent's **first** delivery in a channel and thereafter
only if it has misaddressed (posted an unresolvable mention). Both facts are persisted per
member (`conventions_sent`, `misaddressed` flags), so restarts don't re-spam. Keep payloads
lean — sessions pay tokens for every byte.

### Queueing

Harness sessions are single-threaded. Per-member FIFO inbox: deliveries to a `running` member
queue (`state: queued` shown in the channel). On idle, **all queued deliveries for that member are
batched into one turn**, ordered, each with its `[codor …]` header — one resume call, no
interleaving ambiguity. A batched turn's default-reply target (rule 4) is the author of the
**last** delivery in the batch. A `paused` or `dead` member holds its queue; the channel shows the
backlog.

**Delivery is exactly-once or held — never silently twice.** Before a turn starts, the
switchboard writes an attempt record (delivery → `delivering`, bound to the run message id); a
delivery is `consumed` only when `run.completed` lands. On crash/restart, an in-flight
delivery is reconciled against the run blob and the harness's native transcript: provably
completed → finalize; provably never started (no events, clean spawn failure) → retry once;
ambiguous → `held` with a system message for the operator to release or redeliver.

### Visibility and optional brakes

**Default: agents run until the work is done.** Agent→agent chains are the product, not a
hazard — the switchboard never interrupts them out of the box. What it does do is make spend
and progress impossible to miss, and offer opt-in brakes per channel:

- **Channel spend meter** (always on, never blocking): cumulative `usage.cost_usd` and turn count
  for the day, live in the channel header on every surface.
- **Turn brake** (opt-in, off by default): max consecutive agent→agent deliveries with no
  human-authored message. On breach the next delivery is *held*, the channel gets a `system`
  message, and humans get a push ("paused after N hops — release?"). For channels where you want a
  checkpoint, not a leash.
- **Spend brake** (opt-in, off by default): daily cost threshold that holds like the turn brake.
- **Stall flag** (always on, never killing): a run with no events for N minutes (default 30) is
  flagged `stalled` in the channel; operators kill, software doesn't.

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
extension.started  { parent, ext_member }                     // harness-native parent/agent ids
extension.ended    { ext_member, summary? }                    // mapped to MemberIds by switchboard
```

<!-- harn:assume normalized-run-item-payload-contract ref=normalized-run-item-documentation -->
`run.item.payload` has a standalone normalized schema for each `item_type`:

```ts
tool_call         { call_id: string, tool: string, title: string,
                    detail?: string, input?: unknown }
tool_result       { call_id: string, status: 'ok' | 'error',
                    output_text?: string,
                    diff?: { path: string, unified: string },
                    image?: { media_type: string, data_b64: string },
                    duration_ms?: number, raw?: unknown }
text_delta        { text: string }
reasoning_summary { text: string }
file_change       { path: string, change: 'created' | 'modified' | 'deleted',
                    diff?: { path: string, unified: string } }
commit            { sha?: string, message?: string }
```

The schemas allow unknown extra keys and preserve plain JSON so deep redaction still applies.
`parseRunItemPayload(item_type, payload)` is the single safe-parse path used by first-party
adapter tests and surfaces. `WireEventSchema` deliberately keeps the transport payload as
`unknown`: a malformed third-party adapter item degrades to generic rendering instead of
failing a live turn. First-party adapters must parse at their source boundary.

`call_id` pairs a tool result with its call. `title` is the human-readable one-line command or
path. File-editing adapters emit unified diffs when native evidence permits. Inline images are
capped at 2 MiB and output text at 256 KiB by adapters; oversized content is replaced or
truncated with an explicit marker. A tool result's untruncated `raw` value is journal-only and
must be stripped from live `run_event` frames.
<!-- harn:end normalized-run-item-payload-contract -->

## 5. Harness feature matrix

What each adapter maps from; the normalization column is the contract surfaces rely on.

Adapters are **plain CLI drivers by design** — every agent runs exactly as it would in a
terminal (`claude -p`, `codex exec`), spawned as a subprocess, spoken to over stdin/stdout
JSONL. No harness SDKs: nothing to couple to, and any coding agent with a headless mode and a
resumable session becomes integrable the same way.

Adapters declare honest capabilities:
`{resume, discover, interactiveAttach, ask, extensions: boolean, approvals: 'runtime'|'spawn-time'}`
— and expose `respondInteraction(session, interaction_id, answer)` when `ask`/runtime
approvals are true. A harness without `resume` cannot back a persistent member (no revive, no
join, no attach); it may only serve one-shot ephemeral members, and surfaces label it so.

| Capability | Claude Code | Codex CLI | Normalized as |
| --- | --- | --- | --- |
| Headless drive + resume | `claude -p --resume <session-id> --output-format stream-json --input-format stream-json` | `codex exec --json [--sandbox …] resume <rollout-id> "<prompt>"` | adapter `deliver()` |
| Event stream | stream-json JSONL on stdout | `--json` JSONL: `thread.started` (thread_id), `item.*` (agent messages, plain shell tool calls — commands run via the unified-exec tool emit NO item; stream tool visibility is best-effort, probed P0.2), `turn.completed` (usage) / `turn.failed` / `error` | `run.item` |
| Ask-user | `AskUserQuestion` — surfaced as a control request on the stream-json control protocol; answered via `respondInteraction` on stdin | — (none) | `ask.raised` card; Codex: plain replies suffice, nothing raised |
| Permissions | permission modes; runtime prompts via the stream-json control protocol (enabled by `--permission-prompt-tool stdio` — required, not a fallback; probed P0.2); answered via `respondInteraction` | sandbox modes (`read-only` ↔ `--dangerously-bypass…`), set at spawn | `approval.raised` (Claude, runtime) + a static **policy chip** on the member (both) |
| Subagents | **hooks are authoritative** (`SubagentStart`/`SubagentStop`: agent id + transcript path, injected via `--settings`); Task/Agent tool-calls in the stream are enrichment only | — | `extension.*` (Claude); n/a |
| Usage/cost | result usage block (tokens + cost_usd) | `turn.completed` usage — **tokens only, no dollar cost**; spend meters show tokens for such harnesses and $-brakes count only cost-reporting members | `run.completed.usage` → channel meter |
| Join-from-live-session | `/codor` skill + hooks (see ARCHITECTURE §ownership) | `codor join` CLI reading `~/.codex/sessions` | member with `session_ref` |
| Jump-into-member (attach TUI) | `claude --resume <session-id>` in your terminal | `codex resume <rollout-id>` | `codor attach <member>`; member goes mirrored until you exit |
| Interrupt | SIGINT on child | SIGINT on child | member action `interrupt` |

**Extensibility:** an adapter is ~one file implementing `spawn / attach / deliver / interrupt`
(ARCHITECTURE §adapters). Zed's **Agent Client Protocol (ACP)** was evaluated in M0 (P0.2):
verdict NO as a replacement driver layer — it exposes no subagent visibility by design and
only coarse usage — so CLI drivers stay; ACP remains a candidate future fourth adapter
(details in ARCHITECTURE §adapters and the reuse map).

## 6. The ledger — shared memory as a graph

Partyline's "context threads" idea (shared decisions, constraints, contracts that any member can
read and extend), rebuilt local-first and graph-shaped:

- **Storage is an Obsidian-compatible vault**: a directory of markdown notes with `[[wikilink]]`
  edges, living beside the channel store (`~/.codor/rooms/<room>/ledger/`). No database, no
  service — the graph *is* the link structure. Open it in Obsidian and you get the graph view
  for free; agents read and write it as plain files.
- **The switchboard bootstraps it**: enabling the ledger on a channel initializes the vault
  (folders, templates for `decision`, `constraint`, `contract`, index note) and tells agent
  members where it lives and how to cite it (`[[name]]`) in their conventions trailer.
- **Reads are refs** (§3): citing `[[risk-limits]]` in a message attaches that note to the
  delivery — same explicit-context-transfer rule as everything else, no ambient injection.
- **Writes are auditable**: agents append/edit notes via `codor ledger` (or direct file
  edits in their cwd — it's their machine); the switchboard watches the vault and posts a
  compact `system` message on change ("@claude updated [[marker-semantics]]"), so the channel sees
  memory evolve.
- **Multi-box safe by construction**: the vault exists only on the channel's home switchboard
  (ARCHITECTURE §multi-box). Refs are resolved at delivery time by the home router, so members
  on other machines receive note content inside their payloads and never need the files;
  remote writes route through `codor ledger` to the home. One writer authority, zero sync.
- **Optional graph backend** (post-MVP): a temporal knowledge-graph engine (e.g. Graphiti) can
  index the same vault for time-aware queries; the vault stays the source of truth.

## 7. Invariants

1. A recipient receives the full message it was mentioned in, plus that message's refs, and
   **nothing else** — never ambient channel history. Context transfer is always an explicit act:
   say it, or reference it with `#N`.
2. `Message.id` is dense and monotonic per channel; `#N` is permanent (edits are new messages;
   there is no message deletion inside a channel, only channel deletion).
<!-- harn:assume literal-draft-recipient-visible-before-send ref=literal-draft-recipient-invariant -->
3. Every non-commentary message resolves to ≥1 recipient at post time. When an available
   latest finalized non-ack agent is the default, the composer materializes that destination
   as one literal, editable `@handle` mention on the first non-`@` input into an empty draft.
   It inserts at most once per draft, so deleting the mention never silently restores it.
<!-- harn:end literal-draft-recipient-visible-before-send -->
4. The switchboard never fabricates member speech. Everything attributed to a member came out of
   its session or its human's keyboard/microphone.
5. All state needed to rebuild a channel (messages, members, session_refs, blobs) lives on the
   switchboard host. Clients are caches.
