import {
  effectiveDefaultAgent,
  isAddressable,
  type Member,
  type Message,
  parseBody,
  type ParsedBody,
  type RoomConfig,
  type ScopedMemberTarget,
  type WorktreeRoutingCatalog,
  type WorktreeRoutingTarget,
} from '@codor/protocol';

export { isAddressable, parseBody } from '@codor/protocol';
export type { ParsedBody } from '@codor/protocol';

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

// harn:assume substantive-routing-excludes-acknowledgements ref=substantive-run-eligibility
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
      message.ack !== true &&
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
// harn:end substantive-routing-excludes-acknowledgements

// ── recipient resolution ────────────────────────────────────────────────

export interface RoutingContext extends EligibilityContext {
  /** Full room roster. */
  members: Member[];
  /** Current channel metadata used by the fresh-channel default chain. */
  roomConfig: RoomConfig;
  /** Author id of the latest FINALIZED agent message, if any ever finished. */
  latestFinalizedAgentAuthor?: string;
  /**
   * For agent-authored messages: author of the delivery that triggered the
   * run (for a batched turn, the author of the LAST delivery in the batch).
   */
  triggerAuthor?: string | RoutedRecipient;
  /** Stable scope of the message being replied to, when it is foreign. */
  replyAuthor?: RoutedRecipient;
  /** Persisted scope from a replied-to message, even if it is now stale. */
  replyTarget?: ScopedMemberTarget;
  // harn:assume qualified-member-target-identity-is-durable ref=qualified-routing-resolution
  /** Path-free registered worktree projection used by the shared parser. */
  qualifiedTargets?: readonly WorktreeRoutingTarget[] | WorktreeRoutingCatalog;
  /** Full target-room member rows stay daemon-side; the protocol catalog carries only identity. */
  qualifiedMembers?: ReadonlyMap<string, Member>;
  // harn:end qualified-member-target-identity-is-durable
}

export interface RoutedRecipient {
  member: Member;
  target?: ScopedMemberTarget;
}

function targetCatalogContains(
  target: ScopedMemberTarget,
  qualifiedTargets: RoutingContext['qualifiedTargets'],
): boolean {
  if (qualifiedTargets === undefined) return false;
  const targets = 'targets' in qualifiedTargets ? qualifiedTargets.targets : qualifiedTargets;
  return targets.some((candidate) =>
    candidate.worktree_id === target.worktree_id
    && candidate.conversation_id === target.conversation_id
    && candidate.alias === target.alias
    && candidate.members.some((member) =>
      member.member_id === target.member_id && member.handle === target.handle),
  );
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
  /** Qualified recipients retain their stable worktree/conversation target. */
  agentTargets?: RoutedRecipient[];
  humanTargets?: RoutedRecipient[];
  /** A strict qualified token failed; callers must refuse the whole post. */
  qualified_refusal?: string;
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
  const parsed = message.ack === true
    ? { mentions: [], refs: [], ledger_refs: [], unresolved: [] }
    : parseBody(message.body, ctx.members, { qualifiedTargets: ctx.qualifiedTargets });
  if (!isRoutable(message, ctx)) return { ...NO_ROUTE, parsed };

  const byId = new Map(ctx.members.map((m) => [m.id, m]));
  const qualifiedById = ctx.qualifiedMembers ?? new Map<string, Member>();
  const recipients: RoutedRecipient[] = [];
  const qualifiedMentions = parsed.qualified ?? [];
  const qualifiedIssues = parsed.qualified_issues ?? [];
  // harn:assume invalid-qualified-targets-never-fallback ref=qualified-routing-refusal
  let qualified_refusal = qualifiedIssues.length > 0
    ? `qualified target refused: ${qualifiedIssues.map((issue) => `${issue.token} (${issue.reason})`).join(', ')}`
    : undefined;
  // harn:end invalid-qualified-targets-never-fallback
  for (const span of parsed.mentions) {
    const member = span.target === undefined
      ? byId.get(span.member_id)
      : qualifiedById.get(span.member_id);
    if (!member) {
      if (span.target !== undefined) {
        qualified_refusal = qualified_refusal === undefined
          ? `qualified target refused: ${span.target.alias}:@${span.target.handle} (target member unavailable)`
          : `${qualified_refusal}; ${span.target.alias}:@${span.target.handle} (target member unavailable)`;
      }
      continue;
    }
    const isSelf = span.member_id === message.author && (
      span.target === undefined
      || message.author_target === undefined
      || span.target.worktree_id === message.author_target.worktree_id
    );
    if (isSelf) continue;
    const key = `${span.target?.worktree_id ?? 'local'}:${member.id}`;
    if (!recipients.some((r) => `${r.target?.worktree_id ?? 'local'}:${r.member.id}` === key)) {
      recipients.push({ member, ...(span.target !== undefined && { target: span.target }) });
    }
  }

  // harn:assume default-recipient-fallback-chain ref=substantive-default-recipient
  // Zero valid mentions → human/bridge messages default to the author of the
  // latest FINALIZED agent message, then the live configured starting agent,
  // then a sole live agent (running placeholders never become "latest");
  // agent messages default to whoever triggered the run (last delivery of a
  // batch). No candidate → room commentary, delivered to nobody.
  const hasQualifiedIntent = qualifiedMentions.length > 0 || qualifiedIssues.length > 0;
  if (
    recipients.length === 0
    && !hasQualifiedIntent
    && ctx.replyTarget !== undefined
    && (
      ctx.replyAuthor === undefined
      || !targetCatalogContains(ctx.replyTarget, ctx.qualifiedTargets)
    )
  ) {
    qualified_refusal = `qualified target refused: ${ctx.replyTarget.alias}:@${ctx.replyTarget.handle} (stale scoped reply)`;
  }
  if (recipients.length === 0 && !hasQualifiedIntent && qualified_refusal === undefined) {
    const authorKind = ctx.author!.kind;
    const trigger = ctx.triggerAuthor;
    const triggerMember = trigger === undefined
      ? undefined
      : typeof trigger === 'string'
        ? byId.get(trigger)
        : trigger.target === undefined
          ? byId.get(trigger.member.id)
          : targetCatalogContains(trigger.target, ctx.qualifiedTargets)
            ? trigger.member
            : undefined;
    if (typeof trigger !== 'string' && trigger?.target !== undefined
      && !targetCatalogContains(trigger.target, ctx.qualifiedTargets)) {
      qualified_refusal = `qualified target refused: ${trigger.target.alias}:@${trigger.target.handle} (stale scoped trigger)`;
    }
    const fallback = authorKind === 'agent'
      ? triggerMember
      : (ctx.replyAuthor?.member ?? effectiveDefaultAgent({
          members: ctx.members,
          latestFinalizedAgentId: ctx.latestFinalizedAgentAuthor,
          startingAgentHandle: ctx.roomConfig.starting_agent_handle,
        }));
    if (fallback && fallback.id !== message.author && isAddressable(fallback)) {
      recipients.push({
        member: fallback,
        ...((authorKind === 'agent' && typeof trigger !== 'string' && trigger?.target !== undefined)
          ? { target: trigger.target }
          : (authorKind !== 'agent' && ctx.replyAuthor?.target !== undefined
            ? { target: ctx.replyAuthor.target }
            : {})),
      });
    }
  }
  // harn:end default-recipient-fallback-chain

  // harn:assume human-deliveries-are-inbox-records ref=recipient-split
  // Humans never get turns: the daemon materializes the humans list as inbox
  // records (read_ts lifecycle, WS inbox frames); only agents produce
  // queued deliveries that feed adapter turns.
  const agentTargets = recipients.filter((r) => r.member.kind === 'agent');
  const humanTargets = recipients.filter((r) => r.member.kind === 'human');
  const agents = agentTargets.map((r) => r.member);
  const humans = humanTargets.map((r) => r.member);
  // harn:end human-deliveries-are-inbox-records

  // A qualified refusal is atomic: even a valid sibling mention is not allowed
  // to escape as a partial fanout when the addressed target set is invalid.
  if (qualified_refusal !== undefined) {
    return {
      ...NO_ROUTE,
      routable: true,
      parsed,
      commentary: true,
      qualified_refusal,
      agentTargets: [],
      humanTargets: [],
    };
  }

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
    ...(qualified_refusal !== undefined && { qualified_refusal }),
    ...((parsed.qualified !== undefined || recipients.some((recipient) => recipient.target !== undefined)) && {
      agentTargets,
      humanTargets,
    }),
  };
}

// ── payload composition ─────────────────────────────────────────────────

export interface ResolvedRef {
  id: number;
  author_handle: string;
  ts: string; // ISO-8601; rendered at minute precision
  body: string; // run refs: final_text, never the event blob
}

export interface DeliveryBriefingContext {
  /** Omitted for grouped rounds, where unmentioned final results close the group. */
  conventions?: {
    untaggedGoesTo?: string;
    ledger?: boolean;
  };
  roster?: { handle: string; kind: Member['kind']; purpose?: string }[];
}

export interface PayloadContext extends DeliveryBriefingContext {
  room: string;
  message: Message;
  authorHandle: string;
  authorKind: Member['kind'];
  // harn:assume cross-worktree-output-stays-in-origin ref=qualified-author-rendering
  /** Foreign execution attribution shown without exposing a local filesystem path. */
  authorTarget?: ScopedMemberTarget;
  // harn:end cross-worktree-output-stays-in-origin
  /** All recipient handles, mention order — identical on every delivery. */
  toHandles: string[];
  refs: ResolvedRef[];
  ledgerRefs?: { name: string; body: string }[];
  awaitingReply?: boolean;
  /**
   * Conventions trailer, included on a member's FIRST delivery in a channel and
   * again after it misaddressed. `untaggedGoesTo` is the ordinary default reply
   * target; grouped rounds omit it because mentionless results close the group.
   */
}

const minuteUtc = (ts: string): string => `${ts.slice(0, 16)}Z`;

// harn:assume roster-briefing-refreshes-on-membership ref=roster-payload-block
export function composeDeliveryBriefing(ctx: DeliveryBriefingContext): string {
  let payload = '';
  if (ctx.roster) {
    payload += '\n[roster:\n';
    for (const member of ctx.roster) {
      payload += `@${member.handle} (${member.kind}${member.purpose ? `, ${member.purpose}` : ''})\n`;
    }
    payload += ']\n';
  }
  if (ctx.conventions) {
    // harn:assume collaboration-briefing-enforces-single-channel-handoff ref=collaboration-handoff-conventions
    // harn:assume agent-briefings-distinguish-invocation-from-discussion ref=explicit-invocation-conventions
    const untagged = ctx.conventions.untaggedGoesTo === undefined
      ? ''
      : ` An untagged reply goes to @${ctx.conventions.untaggedGoesTo}.`;
    payload +=
      `\n[conventions: your normal final reply posts to the channel automatically. ` +
      `An @mention invokes that member and auto-sends your message; write the member's ` +
      `plain name without @ when merely discussing them.${untagged} ` +
      `Reference messages as #N.${ctx.conventions.ledger ? ' Cite ledger notes as [[name]].' : ''} ` +
      `When delegating channel work, keep it with channel members rather than internal subagents: ` +
      `assign one member by tagging them once. After handoff, do not poll, monitor, remind, or ` +
      `re-tag them; the worker returns by tagging you once only on completion or a genuine blocker. ` +
      `Use codor post only for necessary interim output while continuing, or output sent outside ` +
      `the normal response path; use codor post --wait only for one genuinely blocking direct answer. ` +
      `Use codor search --runs before asking about unseen referenced context. ` +
      `Use <ACK_OK> as your entire reply only when a message needs no action and no answer; ` +
      `never append it after doing work or as a sign-off.]\n`;
    // harn:end agent-briefings-distinguish-invocation-from-discussion
    // harn:end collaboration-briefing-enforces-single-channel-handoff
  }
  return payload;
}
// harn:end roster-briefing-refreshes-on-membership

// harn:assume ledger-home-only-refs-travel ref=ledger-aware-payload
/**
 * The exact bytes a recipient session receives — pinned by goldens in
 * router.spec.ts. Keep payloads lean: sessions pay tokens for every byte.
 */
export function composePayload(ctx: PayloadContext, you: string): string {
  const to = ctx.toHandles.map((h) => `@${h}`).join(' ');
  // harn:assume codor-delivery-header-identifies-channel ref=delivery-header-template
  // harn:assume awaiting-reply-marker-is-delivery-context ref=awaiting-reply-header
  const headerKind = ctx.awaitingReply ? 'chat, awaiting reply' : ctx.authorKind;
  const from = ctx.authorTarget === undefined
    ? `@${ctx.authorHandle}`
    : `~${ctx.authorTarget.alias}:@${ctx.authorHandle}`;
  let payload =
    `[codor channel=${ctx.room} msg=#${ctx.message.id} from=${from} (${headerKind})\n` +
    ` to=${to} · you=@${you}]\n` +
    `\n` +
    `${ctx.message.body}\n`;
  // harn:end awaiting-reply-marker-is-delivery-context
  // harn:end codor-delivery-header-identifies-channel
  for (const ref of ctx.refs) {
    payload +=
      `\n--- referenced #${ref.id} · @${ref.author_handle} · ${minuteUtc(ref.ts)} ---\n` +
      `${ref.body}\n` +
      `--- end reference ---\n`;
  }
  for (const ref of ctx.ledgerRefs ?? []) {
    payload +=
      `\n--- ledger [[${ref.name}]] ---\n` +
      `${ref.body}\n` +
      `--- end ledger note ---\n`;
  }
  payload += composeDeliveryBriefing(ctx);
  return payload;
}
// harn:end ledger-home-only-refs-travel

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
