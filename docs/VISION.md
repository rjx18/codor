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

Partyline is the missing composition: **the chat room where harness sessions are first-class
members**, with the routing semantics that make delegation real, and surfaces that follow the
operator out of the door.

## What Partyline is (and is not)

Partyline is:

- a **local daemon** (the *switchboard*) that owns rooms, routes mentions, and manages the
  lifecycle of harness sessions,
- a **protocol** for messages, mentions, references, and normalized agent events,
- three **surfaces** — web, iPhone, Apple Watch — that render the same rooms.

Partyline is **not**:

- an agent framework or harness — it never prompts, plans, or holds model context. Claude Code and
  Codex do what they already do; Partyline is the wire between them.
- a cloud service — there is no partyline.com backend holding your messages. Every remote path is
  your tailnet, direct P2P, or a dumb encrypted pipe you can self-host.
- a shared-context multiplexer — members deliberately do *not* share context. The only cross-agent
  information transfer is explicit: the text of a mention plus any `#`-referenced messages.
  Bounded, auditable handoffs instead of prompt soup.

## The four pillars

### 1. Mentions route work

A message that tags `@codex` is delivered into the Codex session as its next turn — specifically,
everything *after* the tag (text before the tag is room commentary, invisible to the recipient).
`#92832` after the tag pulls that message's full content in as context. So:

> `claude:` Completed the refactor; two tests resurfaced but I solved it via the accessor.
> `@codex` Start implementation of phase 3, see my comments in `#92832` before starting.

Codex receives the phase-3 instruction plus message #92832 verbatim — and nothing else. When it
finishes, its final message posts to the room, and if that message says `@claude please review my
code`, the loop continues without a human clipboard. Execution streams live but renders as one
collapsible run message, so the room stays readable.

### 2. Agents are sessions, added from either side

A room member is a *session of a harness* — nameable, renameable (`coder`, `reviewer`), persistent,
lifecycle-managed by the switchboard. Two ways in:

- **From the room** (web/phone): spawn a new session of any installed harness into the room.
- **From a live session**: a `/partyline join <room> [--as reviewer]` skill (Claude Code) or
  `partyline join` CLI (Codex, anything) patches the session you're *already in* into the room —
  so the terminal session you've been driving all morning becomes addressable by everyone else.

Subagents spawned by a member appear automatically as **extensions** (e.g. `claude-ext-7adw`),
short-lived members whose output is visible (collapsed under the parent's run) but who vanish when
their task ends.

### 3. One protocol across harnesses, down to your wrist

Harnesses differ: Claude Code has `AskUserQuestion` and permission prompts; Codex has sandbox
modes and no ask-user at all. Partyline normalizes everything into one event vocabulary — message,
run, ask, approval, state — so every surface renders every harness. The Apple Watch surface is the
proof: any agent's question or approval arrives as an actionable notification, and your dictated
reply routes back to the right session. Where a harness lacks a feature, the normalization
degrades gracefully (Codex has no ask-user, so a plain reply *is* the answer — nothing to build).

### 4. Every message has a recipient

No dead-letter messages: a message with no tag goes to the **last agent that replied** in the room.
A message with several tags fans out — `@codex xxx then @claude yyy` delivers `xxx…` to Codex and
`yyy…` to Claude as separate turns. Deterministic, boring, exactly what you'd expect from a party
line with an operator on it.

## A day in the life

**07:40, at the desk.** You open the `traderjoe-eng` room on the web. Overnight, `claude` finished
M1 and tagged `@codex-reviewer`; the review run is collapsed mid-room, verdict: two findings.
`claude` already folded one. One message from `claude` is addressed to you: a design question with
three options (an ask card).

**07:42.** You tap option B. `claude` resumes, finishes, tags `@codex-coder` to start M2.

**08:15, on the train.** Phone buzzes — not for every message (you muted run chatter), but because
`codex-coder` hit its hop budget: six agent-to-agent handoffs without a human message. You skim the
last three run summaries, reply "budget +10, keep going," and mute until lunch.

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
   member model already covers it, presence/auth polish comes after MVP.
3. **The self-hoster** (always): everything runs on hardware they control; the open-source release
   must be genuinely runnable without any hosted component.

## Design principles

- **Reuse-first.** Where good open source exists — P2P transport, agent drivers, watch bridge,
  push gateway, crypto — depend on it or vendor it, and write only room semantics and glue. The
  build map in ARCHITECTURE.md marks every component *depend / fork / pattern*.
- **The harness is the product; Partyline is the wire.** Never intercept, rewrite, or "improve"
  agent turns. Deliver exactly what was addressed, render exactly what happened.
- **Explicit context transfer.** If an agent needs to know something, someone must have said it to
  them (or referenced it). This is a feature: it keeps every session's context bounded and every
  handoff auditable.
- **Spend is a first-class signal.** Agent-to-agent loops burn real money. Hop budgets, per-room
  cost meters, and pause-on-budget are protocol-level, not an afterthought.
- **Local-first, zero plaintext in the cloud.** See PRIVACY.md; this constraint outranks features.
