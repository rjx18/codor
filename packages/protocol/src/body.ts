import { HANDLE_REGEX, type Member } from './member.js';
import type { MentionSpan } from './message.js';

export interface ParsedBody {
  mentions: MentionSpan[];
  refs: number[];
  ledger_refs: string[];
  /** Handle-shaped tokens that matched no member (misaddressing signal). */
  unresolved: string[];
}

const RESERVED_TOKENS = new Set(['all', 'switchboard']);

/** A member the grammar can address: humans and agents in any state. */
export function isAddressable(member: Member): boolean {
  return member.kind === 'human' || member.kind === 'agent';
}

/** Replaces fenced blocks and inline code with spaces while preserving offsets. */
function blankCodeSpans(body: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ');
  return body.replace(/```[\s\S]*?(```|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}

// harn:assume body-parser-shared-across-router-and-web ref=shared-body-parser
/** The single PROTOCOL SS3 body grammar used by routing and destination preview. */
export function parseBody(body: string, members: Member[]): ParsedBody {
  const byHandle = new Map(members.map((member) => [member.handle, member]));
  const scan = blankCodeSpans(body);

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

  return { mentions, refs, ledger_refs, unresolved: [...new Set(unresolved)] };
}
// harn:end body-parser-shared-across-router-and-web
