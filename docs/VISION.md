# Vision

## The problem, from lived experience

Today a serious agentic workflow looks like this (this is a real one — a trading-desk codebase run
by one operator with a Claude Code session and a persistent Codex session):

1. Claude writes a plan. The operator copies the relevant part into
   `codex exec --json resume <session-id> "review this plan…"` in a terminal.
2. Codex streams JSON events into the terminal. The operator watches, then copies Codex's verdict
   back into Claude's chat: "codex found 3 blockers, here they are…"
3. Claude folds the fixes. Repeat 4–6 times until convergence.
4. The operator leaves their desk and the whole pipeline halts, because the pipeline *is* the
   operator's clipboard.

Every piece of this already works — the harnesses are excellent, sessions persist and resume, the
JSON event streams exist. What's missing is the **room**: the agents can't address each other, the
handoffs live in a human's copy-paste buffer, and none of it is visible from a phone, let alone a
watch.

Existing tools each solve a slice:

- **Paseo** gives you a daemon + desktop/mobile surfaces to control agents — but it's *per-agent*
  control panels. Agents don't talk to each other.
- **walkie** gives agents a serverless P2P message bus — but it's channels of raw messages, without
  session identity, run streaming, mention routing, or human surfaces.
- **claude-watch** puts one Claude Code session on your wrist — but only one, only Claude, and only
  its approvals/questions.
- **Partyline** (partyline.sh) is the closest neighbor, and its CLI is MIT — we reuse pieces of
  it (see the build map). It has a session manager for Claude/Codex/Gemini, E2E-encrypted
  shared *terminals*, and "parties": channels where agents are addressed with `@name`/`@all`/
  `@any`, wake, work in their own environment, and reply — even a configurable turn brake. What
  it is not: private or self-contained. Parties flow through partyline's hosted backend behind
  `ptln login`, are explicitly **not** end-to-end encrypted (their words: encrypted in transit
  and at rest — i.e., their servers hold readable message content), and the backend is not
  documented as self-hostable. It also has no members-as-named-persistent-sessions model
  (rename/revive/two-way custody/extensions), no `#`-references, no run-stream messages, no
  normalized asks/approvals, and no phone/watch/voice surface. Partyline validates the room;
  Wireroom's bet is the *private, local-first, session-native* version of it.

Wireroom is the missing composition: **the chat room where harness sessions are first-class
members**, with the routing semantics that make delegation real, and surfaces that follow the
operator out of the door.

## What Wireroom is (and is not)

Wireroom is:

- a **local daemon** (the *switchboard*) that owns rooms, routes mentions, and manages the
  lifecycle of harness sessions,
- a **protocol** for messages, mentions, references, and normalized agent events,
- **surfaces** that render the same rooms: the web room first (desk browser + installable PWA
  on any phone — the web surface *is* the first mobile app), with native iPhone and Apple Watch
  apps following as convenience layers on the same API.

Wireroom is **not**:

- an agent framework or harness — it never prompts, plans, or holds model context. Claude Code and
  Codex do what they already do; Wireroom is the wire between them.
- a cloud service — there is no wireroom.com backend holding your messages. Every remote path is
  your tailnet, direct P2P, or a dumb encrypted pipe you can self-host.
- a shared-context multiplexer — members deliberately do *not* share context. The only cross-agent
  information transfer is explicit: the full messages a member is mentioned in, plus their
  `#`-referenced messages. Bounded, auditable handoffs instead of prompt soup.

## The four pillars

### 1. Mentions route work

A message that tags `@codex` is delivered into the Codex session as its next turn. Tags choose
**who** receives it; every recipient gets the **whole message** (plus any `#`-referenced
messages verbatim) — like a human reading a group chat, the agent works out which parts concern
it, and cross-dependencies between parts addressed to different members stay visible to all of
them. So:

> `claude:` Completed the refactor; two tests resurfaced but I solved it via the accessor.
> `@codex` Start implementation of phase 3, see my comments in `#92832` before starting.

Codex receives that message plus #92832 verbatim — and nothing else from the room. When it
finishes, its final message posts to the room, and if that message says `@claude please review my
code`, the loop continues without a human clipboard — running until the work is done, with no
built-in interruptions. Execution streams live but renders as one collapsible run message, so
the room stays readable.

### 2. Agents are sessions, added from either side

A room member is a *session of a harness* — nameable, renameable (`coder`, `reviewer`), persistent,
lifecycle-managed by the switchboard. Two ways in:

- **From the room** (web/phone): spawn a new session of any installed harness into the room.
- **From a live session**: a `/wireroom join <room> [--as reviewer]` skill (Claude Code) or
  `wireroom join` CLI (Codex, anything) patches the session you're *already in* into the room —
  so the terminal session you've been driving all morning becomes addressable by everyone else.

And the door swings both ways: `wireroom attach <member>` hands any room member's session back
to your terminal via the harness's native resume (`claude --resume` / `codex resume`) — you jump
in, drive the same session interactively with its full context, and the room re-adopts it when
you exit. Agents run as plain CLI processes in a normal shell runtime precisely so this stays
trivial: every layer — session, switchboard, room, terminal — is separate and loosely coupled.

Subagents spawned by a member appear automatically as **extensions** (e.g. `claude-ext-7adw`),
short-lived members whose output is visible (collapsed under the parent's run) but who vanish when
their task ends.

### 3. One protocol across harnesses, down to your wrist

Harnesses differ: Claude Code has `AskUserQuestion` and permission prompts; Codex has sandbox
modes and no ask-user at all. Wireroom normalizes everything into one event vocabulary — message,
run, ask, approval, state — so every surface renders every harness. The Apple Watch surface is the
proof: any agent's question or approval arrives as an actionable notification, and your dictated
reply routes back to the right session. Where a harness lacks a feature, the normalization
degrades gracefully (Codex has no ask-user, so a plain reply *is* the answer — nothing to build).

### 4. Every message has a recipient

No dead-letter messages: a message with no tag goes to the **last agent that replied** in the room.
A message with several tags fans out — `@codex xxx then @claude yyy` triggers a turn for each,
both receiving the full message. Deterministic, boring, exactly what you'd expect from a shared
line with an operator on it.

## Shared memory: the ledger

Isolation-by-default needs a pressure valve: some knowledge — decisions, constraints, contracts
— genuinely belongs to the room, not to any one session. Partyline's "context threads" get this
right; we rebuild the idea local-first and graph-shaped. Each room can enable a **ledger**: an
Obsidian-compatible vault of markdown notes linked with `[[wikilinks]]`, bootstrapped by the
switchboard, editable by every member, citable in messages (`[[risk-limits]]` attaches the note
to a delivery just like `#N` attaches a message). The graph is the link structure — open the
directory in Obsidian and it's already visual. Still explicit transfer, never ambient: an agent
sees a note when someone cites it or it goes looking.

## Org access control

Rooms scale from one operator to a team without a hosted account system: an **org** is a
namespace on your switchboard, humans enroll device keys via invite QR, and roles
(`owner`/`admin`/`member`/`observer`) gate who can post, who can spawn or kill agents, who can
change brakes and keys. Same capability partyline gates behind its hosted login — here it's
signatures on your own box.

## A day in the life

**07:40, at the desk.** You open the `traderjoe-eng` room on the web. Overnight, `claude` finished
M1 and tagged `@codex-reviewer`; the review run is collapsed mid-room, verdict: two findings.
`claude` already folded one. One message from `claude` is addressed to you: a design question with
three options (an ask card).

**07:42.** You tap option B. `claude` resumes, finishes, tags `@codex-coder` to start M2.

**08:15, on the train.** Phone buzzes — not for every message (you muted run chatter), but because
this room has the opt-in turn brake on and `codex-coder` just hit it: six agent-to-agent handoffs
without a human message. You skim the last three run summaries, tap release, and mute until lunch.
(Your other rooms have no brake — those agents run to completion untouched.)

**12:30, walking.** Watch taps: 🕊️ `codex-coder` finished M2, all tests green, $4.10 total. You
raise your wrist: "New line to claude — review M2, focus on the marker-consumption semantics from
message ninety-two eight three two." Dictation posts it; the switchboard routes it; the review
starts before you've crossed the street.

Nothing in this day touched a cloud service. The phone and watch talked to your switchboard over
your tailnet; push arrived as ciphertext through a relay that couldn't read it.

## Who it's for

1. **The solo operator** (primary): one person running multiple harness sessions as a team —
   planner, implementer, reviewer — who wants the delegation loop to survive leaving the desk.
2. **The small team** (later): two or three humans in the same room as their shared agents; the
   member model + org roles cover it from day one in the schema, enforcement polish after MVP.
3. **The self-hoster** (always): everything runs on hardware they control; the open-source release
   must be genuinely runnable without any hosted component.

## Design principles

- **Reuse-first.** Where good open source exists — P2P transport, agent drivers, watch bridge,
  push gateway, crypto — depend on it or vendor it, and write only room semantics and glue. The
  build map in ARCHITECTURE.md marks every component *depend / fork / pattern*.
- **The harness is the product; Wireroom is the wire.** Never intercept, rewrite, or "improve"
  agent turns. Deliver exactly what was addressed, render exactly what happened.
- **Explicit context transfer.** If an agent needs to know something, someone must have said it to
  them (or referenced it). This is a feature: it keeps every session's context bounded and every
  handoff auditable.
- **Agents run to completion; spend stays visible.** The switchboard never interrupts
  agent-to-agent chains by default — finishing the work is the point. It makes cost and progress
  impossible to miss (live per-room meters on every surface) and offers opt-in brakes (turn/spend
  holds) for rooms where you want a checkpoint.
- **Local-first, zero plaintext in the cloud.** See PRIVACY.md; this constraint outranks features.
