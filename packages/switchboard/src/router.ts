import {
  HANDLE_REGEX,
  type Member,
  type MentionSpan,
  type Message,
  type RoomConfig,
} from '@wireroom/protocol';

/**
 * The pure router — PROTOCOL §3 as functions over (message, room state).
 * No IO, no store: the daemon feeds it context and materializes its output.
 */

// ── eligibility ─────────────────────────────────────────────────────────

export interface EligibilityContext {
  /** The room member row for the message author. */
  author: Member | undefined;
  /** The message this one replies to, when reply_to is set. */
  repliedTo?: Message;
}

// harn:assume routing-eligibility-gate ref=eligibility-gate
/**
 * Routing eligibility comes FIRST. Routed: `chat` authored by a human,
 * agent, or bridge member, and FINALIZED `run` messages. Never routed:
 * `system` messages, `ask`/`approval` cards, anything authored by the
 * system member, and chat replies to a card (audit replies) — none of
 * these may ever trigger an agent turn. A finalized run with an EMPTY body
 * (interrupted turn, or a model deliberately replying with nothing) is not
 * routable either: an empty body can mention nobody, so routing it could
 * only fire the untagged default — which live-looped two agents through
 * endless empty acknowledgment turns (found in M0 acceptance).
 */
export function isRoutable(message: Message, ctx: EligibilityContext): boolean {
  if (!ctx.author) return false;
  if (ctx.author.kind === 'system' || ctx.author.kind === 'extension') return false;
  if (message.kind === 'system' || message.kind === 'ask' || message.kind === 'approval') {
    return false;
  }
  if (message.kind === 'run') {
    return (
      message.run !== undefined &&
      message.run.status !== 'running' &&
      message.body.trim() !== ''
    );
  }
  // chat: audit replies on cards never route
  if (
    message.reply_to !== undefined &&
    ctx.repliedTo !== undefined &&
    (ctx.repliedTo.kind === 'ask' || ctx.repliedTo.kind === 'approval')
  ) {
    return false;
  }
  return true;
}
// harn:end routing-eligibility-gate

// ── body grammar ────────────────────────────────────────────────────────

export interface ParsedBody {
  mentions: MentionSpan[];
  refs: number[];
  ledger_refs: string[];
  /** Handle-shaped tokens that matched no member (misaddressing signal). */
  unresolved: string[];
}

const RESERVED_TOKENS = new Set(['all', 'switchboard']);

/** A member the grammar can address: humans and agents in ANY state. */
export function isAddressable(member: Member): boolean {
  return member.kind === 'human' || member.kind === 'agent';
}

/** Replaces fenced blocks and inline code with spaces (offsets preserved). */
function blankCodeSpans(body: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ');
  return body.replace(/```[\s\S]*?(```|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}

/**
 * PROTOCOL §3 parsing rules over `body` — fenced/inline code is skipped.
 * Mentions resolve to addressable members only; reserved tokens (`@all`,
 * `@switchboard`) are plain text and are NOT typos; anything else
 * handle-shaped that misses the roster lands in `unresolved`.
 */
export function parseBody(body: string, members: Member[]): ParsedBody {
  const byHandle = new Map(members.map((m) => [m.handle, m]));
  const scan = blankCodeSpans(body);

  const mentions: MentionSpan[] = [];
  const unresolved: string[] = [];
  const mentionRe = /(^|[^\w`@])@([a-z0-9][a-z0-9-]*)/g;
  for (const match of scan.matchAll(mentionRe)) {
    const handle = match[2]!;
    const start = match.index + match[1]!.length;
    if (!HANDLE_REGEX.test(handle)) continue;
    if (RESERVED_TOKENS.has(handle)) continue; // reserved → plain text, not a typo
    const member = byHandle.get(handle);
    if (member && isAddressable(member)) {
      mentions.push({ member_id: member.id, start, end: start + handle.length + 1 });
    } else if (!member) {
      unresolved.push(handle);
    }
    // non-addressable members (extensions/system/bridge) → plain text
  }

  const refs: number[] = [];
  for (const match of scan.matchAll(/(^|[^\w#])#(\d+)/g)) {
    const id = Number(match[2]);
    if (id > 0 && !refs.includes(id)) refs.push(id);
  }

  const ledger_refs: string[] = [];
  for (const match of scan.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const name = match[1]!.trim();
    if (name !== '' && !ledger_refs.includes(name)) ledger_refs.push(name);
  }

  return { mentions, refs, ledger_refs, unresolved: [...new Set(unresolved)] };
}

// ── recipient resolution ────────────────────────────────────────────────

export interface RoutingContext extends EligibilityContext {
  /** Full room roster. */
  members: Member[];
  /** Author id of the latest FINALIZED agent message, if any ever finished. */
  latestFinalizedAgentAuthor?: string;
  /**
   * For agent-authored messages: author of the delivery that triggered the
   * run (for a batched turn, the author of the LAST delivery in the batch).
   */
  triggerAuthor?: string;
}

export interface RouteResult {
  routable: boolean;
  parsed: ParsedBody;
  /** Agent recipients — each becomes a queued delivery feeding a turn. */
  agents: Member[];
  /** Human recipients — inbox records only, never turns. */
  humans: Member[];
  /** True when nothing resolves: room commentary, delivered to nobody. */
  commentary: boolean;
  /** Finalized agent message contained unresolvable handle-shaped tokens. */
  misaddressed: boolean;
}

const NO_ROUTE: Omit<RouteResult, 'parsed'> = {
  routable: false,
  agents: [],
  humans: [],
  commentary: false,
  misaddressed: false,
};

/**
 * Mentions select recipients; content is never split. The recipient set is
 * the union of valid mentions (duplicates collapse, self-mentions ignored);
 * a mentionless message falls back to the default recipient rule.
 */
export function resolveRecipients(message: Message, ctx: RoutingContext): RouteResult {
  const parsed = parseBody(message.body, ctx.members);
  if (!isRoutable(message, ctx)) return { ...NO_ROUTE, parsed };

  const byId = new Map(ctx.members.map((m) => [m.id, m]));
  const recipients: Member[] = [];
  for (const span of parsed.mentions) {
    if (span.member_id === message.author) continue; // self-mentions ignored
    const member = byId.get(span.member_id);
    if (member && !recipients.some((r) => r.id === member.id)) recipients.push(member);
  }

  // harn:assume default-recipient-latest-finalized ref=default-recipient
  // Zero valid mentions → human/bridge messages default to the author of the
  // latest FINALIZED agent message (running placeholders never count);
  // agent messages default to whoever triggered the run (last delivery of a
  // batch). No candidate → room commentary, delivered to nobody.
  if (recipients.length === 0) {
    const authorKind = ctx.author!.kind;
    const fallbackId =
      authorKind === 'agent' ? ctx.triggerAuthor : ctx.latestFinalizedAgentAuthor;
    const fallback = fallbackId === undefined ? undefined : byId.get(fallbackId);
    if (fallback && fallback.id !== message.author && isAddressable(fallback)) {
      recipients.push(fallback);
    }
  }
  // harn:end default-recipient-latest-finalized

  // harn:assume human-deliveries-are-inbox-records ref=recipient-split
  // Humans never get turns: the daemon materializes the humans list as inbox
  // records (read_ts lifecycle, WS inbox frames); only agents produce
  // queued deliveries that feed adapter turns.
  const agents = recipients.filter((r) => r.kind === 'agent');
  const humans = recipients.filter((r) => r.kind === 'human');
  // harn:end human-deliveries-are-inbox-records

  const misaddressed =
    ctx.author!.kind === 'agent' &&
    (message.kind !== 'run' || message.run?.status !== 'running') &&
    parsed.unresolved.length > 0;

  return {
    routable: true,
    parsed,
    agents,
    humans,
    commentary: recipients.length === 0,
    misaddressed,
  };
}

// ── payload composition ─────────────────────────────────────────────────

export interface ResolvedRef {
  id: number;
  author_handle: string;
  ts: string; // ISO-8601; rendered at minute precision
  body: string; // run refs: final_text, never the event blob
}

export interface PayloadContext {
  room: string;
  message: Message;
  authorHandle: string;
  authorKind: Member['kind'];
  /** All recipient handles, mention order — identical on every delivery. */
  toHandles: string[];
  refs: ResolvedRef[];
  /**
   * Conventions trailer, included on a member's FIRST delivery in a room and
   * again after it misaddressed. `others` = the other parties it can tag;
   * `untaggedGoesTo` = its default reply target (the message author).
   */
  conventions?: { others: string[]; untaggedGoesTo: string };
}

const minuteUtc = (ts: string): string => `${ts.slice(0, 16)}Z`;

// harn:assume delivery-payload-template-exact ref=payload-template
/**
 * The exact bytes a recipient session receives — pinned by goldens in
 * router.spec.ts. Keep payloads lean: sessions pay tokens for every byte.
 */
export function composePayload(ctx: PayloadContext, you: string): string {
  const to = ctx.toHandles.map((h) => `@${h}`).join(' ');
  let payload =
    `[wireroom room=${ctx.room} msg=#${ctx.message.id} from=@${ctx.authorHandle} (${ctx.authorKind})\n` +
    ` to=${to} · you=@${you}]\n` +
    `\n` +
    `${ctx.message.body}\n`;
  for (const ref of ctx.refs) {
    payload +=
      `\n--- referenced #${ref.id} · @${ref.author_handle} · ${minuteUtc(ref.ts)} ---\n` +
      `${ref.body}\n` +
      `--- end reference ---\n`;
  }
  if (ctx.conventions) {
    const tags = ctx.conventions.others.map((h) => `@${h}`).join(' / ');
    payload +=
      `\n[conventions: your reply posts to the room. Tag ${tags} to address ` +
      `them; an untagged reply goes to @${ctx.conventions.untaggedGoesTo}. ` +
      `Reference messages as #N.]\n`;
  }
  return payload;
}
// harn:end delivery-payload-template-exact

// harn:assume whole-message-delivery ref=payload-fanout
/**
 * Fan-out: one payload per recipient, byte-identical except the `you=`
 * field — the whole body plus all resolved refs, never per-mention slices.
 */
export function composeDeliveryPayloads(
  ctx: PayloadContext,
  recipients: Member[],
): Map<string, string> {
  const payloads = new Map<string, string>();
  for (const recipient of recipients) {
    payloads.set(recipient.id, composePayload(ctx, recipient.handle));
  }
  return payloads;
}
// harn:end whole-message-delivery

// ── brakes ──────────────────────────────────────────────────────────────

export interface BrakeStats {
  /** Consecutive agent→agent deliveries since the last human message. */
  consecutiveAgentDeliveries: number;
  /** Cost accumulated today from cost-reporting members. */
  spendTodayUsd: number;
}

export type BrakeVerdict =
  | { hold: false }
  | { hold: true; reason: 'turn_brake' | 'spend_brake' };

// harn:assume brakes-opt-in-hold ref=brake-evaluation
/**
 * Opt-in brakes (PROTOCOL §3): with the default null config NOTHING holds —
 * chains run until the work is done. A configured turn brake holds the next
 * delivery once the agent→agent chain reaches the limit; a spend brake
 * holds once today's cost reaches the threshold.
 */
export function evaluateBrakes(config: RoomConfig, stats: BrakeStats): BrakeVerdict {
  if (config.turn_brake !== null && stats.consecutiveAgentDeliveries >= config.turn_brake) {
    return { hold: true, reason: 'turn_brake' };
  }
  if (config.spend_brake_usd !== null && stats.spendTodayUsd >= config.spend_brake_usd) {
    return { hold: true, reason: 'spend_brake' };
  }
  return { hold: false };
}
// harn:end brakes-opt-in-hold
