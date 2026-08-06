import { HANDLE_REGEX, type Member } from './member.js';
import type { MentionSpan } from './message.js';
import type {
  ScopedMemberTarget,
  WorktreeRoutingCatalog,
  WorktreeRoutingTarget,
} from './worktree.js';

export interface ParsedBody {
  mentions: MentionSpan[];
  refs: number[];
  ledger_refs: string[];
  /** Handle-shaped tokens that matched no member (misaddressing signal). */
  unresolved: string[];
  /** Qualified mentions are also present in `mentions`, with `target` set. */
  qualified?: MentionSpan[];
  /** Strict qualified-token failures. A router must never fall back when present. */
  qualified_issues?: QualifiedMentionIssue[];
}

export type QualifiedMentionIssueReason =
  | 'malformed'
  | 'catalog-unavailable'
  | 'unknown-worktree'
  | 'unregistered-worktree'
  | 'removed-worktree'
  | 'ambiguous-worktree'
  | 'unknown-member'
  | 'removed-member'
  | 'ambiguous-member';
  // A handle can be stale or duplicated inside a path-free catalog. Keep
  // these failures distinct so the router can explain the refusal without
  // ever trying the origin roster as a fallback.

export interface QualifiedMentionIssue {
  token: string;
  selector: string;
  handle: string;
  start: number;
  end: number;
  reason: QualifiedMentionIssueReason;
}

export interface BodyParseOptions {
  /** The path-free active registry projection used to resolve qualified tokens. */
  qualifiedTargets?: readonly WorktreeRoutingTarget[] | WorktreeRoutingCatalog;
}

const RESERVED_TOKENS = new Set(['all', 'switchboard']);

/** A member the grammar can address: humans and agents in any state. */
// harn:assume extensions-not-addressable-v1 ref=extension-addressability-filter
export function isAddressable(member: Member): boolean {
  return member.kind === 'human' || member.kind === 'agent';
}
// harn:end extensions-not-addressable-v1

/** Replaces fenced blocks and inline code with spaces while preserving offsets. */
function blankCodeSpans(body: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ');
  return body.replace(/```[\s\S]*?(```|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}

function blankRanges(body: string, ranges: readonly { start: number; end: number }[]): string {
  if (ranges.length === 0) return body;
  // JavaScript regex offsets are UTF-16 code-unit offsets. Splitting by code
  // point (`[...body]`) shifts every range after a non-BMP character and can
  // expose the inner @handle of an already-owned qualified token.
  const chars = body.split('');
  for (const range of ranges) {
    for (let index = range.start; index < range.end && index < chars.length; index++) {
      if (chars[index] !== '\n') chars[index] = ' ';
    }
  }
  return chars.join('');
}

function targetList(
  qualifiedTargets: BodyParseOptions['qualifiedTargets'],
): readonly WorktreeRoutingTarget[] | undefined {
  if (qualifiedTargets === undefined) return undefined;
  return 'targets' in qualifiedTargets ? qualifiedTargets.targets : qualifiedTargets;
}

function targetCatalog(
  qualifiedTargets: BodyParseOptions['qualifiedTargets'],
): WorktreeRoutingCatalog | undefined {
  if (qualifiedTargets === undefined || !('tombstones' in qualifiedTargets)) return undefined;
  return qualifiedTargets;
}

// harn:assume body-parser-shared-across-router-and-web ref=shared-body-parser
/** The single PROTOCOL SS3 body grammar used by routing and destination preview. */
export function parseBody(
  body: string,
  members: Member[],
  options: BodyParseOptions = {},
): ParsedBody {
  const byHandle = new Map(members.map((member) => [member.handle, member]));
  const coded = blankCodeSpans(body);

  // harn:assume qualified-member-target-identity-is-durable ref=qualified-body-grammar
  const qualified: MentionSpan[] = [];
  const qualified_issues: QualifiedMentionIssue[] = [];
  const occupied: { start: number; end: number }[] = [];
  const targets = targetList(options.qualifiedTargets);
  const catalog = targetCatalog(options.qualifiedTargets);
  // Scan the whole suspicious token once. A prefix-only regex lets malformed
  // suffixes (`~main:@codex.foo`, `~main: @codex`) escape and then be parsed as
  // local mentions. The candidate owns the complete non-space token; a small
  // punctuation suffix is left outside the span so ordinary prose remains
  // byte-compatible.
  const candidateRe = /(^|[^\w`])~[^\s`]+/g;
  const validPrefixRe = /^~([a-z0-9][a-z0-9._-]*):@([a-z0-9][a-z0-9-]*)/;
  const malformedPartsRe = /^~([^:\s]+):\s*@([^\s]*)/;
  const punctuationOnly = /^[.,!?;:)\]}]*$/;
  for (const match of coded.matchAll(candidateRe)) {
    const start = match.index + match[1]!.length;
    let candidateEnd = start + match[0]!.length - match[1]!.length;
    // Whitespace in a qualified selector is malformed, but it still belongs
    // to the qualified token and must hide the inner local mention.
    const spacedHandle = coded.slice(candidateEnd).match(/^\s+@[^\s`]+/);
    if (coded[candidateEnd - 1] === ':' && spacedHandle !== null) {
      candidateEnd += spacedHandle[0].length;
    }
    const candidate = coded.slice(start, candidateEnd);
    const valid = validPrefixRe.exec(candidate);
    let end = candidateEnd;
    let selector = '';
    let handle = '';
    let malformed = false;
    if (valid !== null && punctuationOnly.test(candidate.slice(valid[0].length))) {
      end = start + valid[0].length;
      selector = valid[1]!;
      handle = valid[2]!;
    } else {
      malformed = true;
      const parts = malformedPartsRe.exec(candidate);
      selector = parts?.[1] ?? candidate.slice(1).split(':', 1)[0] ?? '';
      handle = parts?.[2] ?? '';
    }
    const token = body.slice(start, end);
    occupied.push({ start, end });
    if (malformed) {
      qualified_issues.push({ token, selector, handle, start, end, reason: 'malformed' });
      continue;
    }
    if (targets === undefined) {
      qualified_issues.push({ token, selector, handle, start, end, reason: 'catalog-unavailable' });
      continue;
    }
    const matchingTargets = targets.filter((candidateTarget) => candidateTarget.alias === selector);
    if (matchingTargets.length > 1) {
      qualified_issues.push({ token, selector, handle, start, end, reason: 'ambiguous-worktree' });
      continue;
    }
    const target = matchingTargets[0];
    if (target === undefined) {
      const tombstone = catalog?.tombstones.find((candidateTombstone) => candidateTombstone.alias === selector);
      qualified_issues.push({
        token,
        selector,
        handle,
        start,
        end,
        reason: tombstone?.lifecycle === 'unregistered'
          ? 'unregistered-worktree'
          : tombstone?.lifecycle === 'removed'
            ? 'removed-worktree'
            : 'unknown-worktree',
      });
      continue;
    }
    const matchingMembers = target.members.filter((candidateMember) =>
      candidateMember.handle === handle && (candidateMember.kind === 'human' || candidateMember.kind === 'agent'));
    if (matchingMembers.length > 1) {
      qualified_issues.push({ token, selector, handle, start, end, reason: 'ambiguous-member' });
      continue;
    }
    const targetMember = matchingMembers[0];
    if (targetMember === undefined) {
      const removed = target.removed_members?.some((candidateMember) => candidateMember.handle === handle);
      qualified_issues.push({
        token,
        selector,
        handle,
        start,
        end,
        reason: removed ? 'removed-member' : 'unknown-member',
      });
      continue;
    }
    const scoped: ScopedMemberTarget = {
      worktree_id: target.worktree_id,
      conversation_id: target.conversation_id,
      member_id: targetMember.member_id,
      alias: target.alias,
      handle: targetMember.handle,
    };
    qualified.push({
      member_id: targetMember.member_id,
      target: scoped,
      start,
      end,
    });
  }
  // harn:end qualified-member-target-identity-is-durable

  const scan = blankRanges(coded, occupied);

  const mentions: MentionSpan[] = [];
  const unresolved: string[] = [];
  const mentionRe = /(^|[^\w`@])@([a-z0-9][a-z0-9-]*)/g;
  for (const match of scan.matchAll(mentionRe)) {
    const handle = match[2]!;
    const start = match.index + match[1]!.length;
    if (!HANDLE_REGEX.test(handle) || RESERVED_TOKENS.has(handle)) continue;
    const member = byHandle.get(handle);
    if (member && isAddressable(member)) {
      mentions.push({ member_id: member.id, start, end: start + handle.length + 1 });
    } else if (!member) {
      unresolved.push(handle);
    }
  }

  const refs: number[] = [];
  for (const match of scan.matchAll(/(^|[^\w#])#(\d+)/g)) {
    const id = Number(match[2]);
    if (id > 0 && !refs.includes(id)) refs.push(id);
  }

  const ledger_refs: string[] = [];
  for (const match of scan.matchAll(/\[\[([^\[\]\n]+)\]\]/g)) {
    const name = match[1]!.trim();
    if (name !== '' && !ledger_refs.includes(name)) ledger_refs.push(name);
  }

  const parsed: ParsedBody = { mentions, refs, ledger_refs, unresolved: [...new Set(unresolved)] };
  if (qualified.length > 0 || qualified_issues.length > 0) {
    parsed.mentions = [...mentions, ...qualified].sort((left, right) => left.start - right.start);
    parsed.qualified = qualified;
    parsed.qualified_issues = qualified_issues;
  }
  return parsed;
}
// harn:end body-parser-shared-across-router-and-web
