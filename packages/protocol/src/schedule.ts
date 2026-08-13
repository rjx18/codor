import { z } from 'zod';

import { MemberIdSchema, MessageIdSchema, RoomIdSchema, TimestampSchema } from './ids.js';
import { HandleSchema } from './member.js';
import { MentionSpanSchema } from './message.js';
import {
  ScopedMemberTargetSchema,
  WorktreeAliasSchema,
  WorktreeIdSchema,
} from './worktree.js';

export const MAX_SCHEDULE_DIRECTIVE_CHARS = 256;
export const MAX_SCHEDULE_BODY_BYTES = 65_536;
export const MAX_SCHEDULE_HORIZON_MS = 365 * 24 * 60 * 60 * 1_000;

export const ScheduleIdSchema = z.string().min(1).max(128);
export const ScheduleStateSchema = z.enum(['pending', 'sending', 'sent', 'failed', 'cancelled']);

export const ScheduledTargetSchema = z.object({
  member_id: MemberIdSchema,
  conversation_id: RoomIdSchema,
  handle: HandleSchema,
  display_name: z.string().min(1).max(256).optional(),
  worktree_id: WorktreeIdSchema.optional(),
  alias: WorktreeAliasSchema.optional(),
}).superRefine((target, ctx) => {
  if ((target.worktree_id === undefined) !== (target.alias === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['worktree_id'],
      message: 'qualified scheduled targets require both worktree_id and alias',
    });
  }
});
export type ScheduledTarget = z.infer<typeof ScheduledTargetSchema>;

// harn:assume scheduled-state-streams-through-room-seq-v2 ref=schedule-protocol-schema-v2
export const ScheduleSchema = z.object({
  id: ScheduleIdSchema,
  room: RoomIdSchema,
  origin_room: RoomIdSchema.optional(),
  author_id: MemberIdSchema,
  author_handle: z.string().min(1).max(64),
  /** Stable execution identity when an agent schedules from a qualified worktree. */
  author_target: ScopedMemberTargetSchema.optional(),
  target: ScheduledTargetSchema,
  body: z.string().max(MAX_SCHEDULE_BODY_BYTES).refine(
    (body) => new TextEncoder().encode(body).byteLength <= MAX_SCHEDULE_BODY_BYTES,
    'scheduled body exceeds 65536 UTF-8 bytes',
  ),
  mentions: z.array(MentionSpanSchema).length(1),
  refs: z.array(MessageIdSchema).optional(),
  ledger_refs: z.array(z.string()).optional(),
  due_ts: TimestampSchema,
  host_offset_minutes: z.number().int().min(-14 * 60).max(14 * 60),
  state: ScheduleStateSchema,
  created_ts: TimestampSchema,
  updated_ts: TimestampSchema,
  claimed_ts: TimestampSchema.optional(),
  completed_ts: TimestampSchema.optional(),
  error: z.string().max(1_000).optional(),
  delivered_message_id: MessageIdSchema.optional(),
}).superRefine((schedule, ctx) => {
  if (schedule.author_target !== undefined && schedule.author_target.member_id !== schedule.author_id) {
    ctx.addIssue({
      code: 'custom',
      path: ['author_target', 'member_id'],
      message: 'qualified schedule author target must match author_id',
    });
  }
});
export type Schedule = z.infer<typeof ScheduleSchema>;
// harn:end scheduled-state-streams-through-room-seq-v2

export interface ParseScheduleDirectiveOptions {
  now?: Date;
  hostOffsetMinutes?: number;
}

export interface ScheduleCanonicalizationOptions {
  /** Fixed instant for deterministic browser/CLI tests; defaults to now. */
  now?: Date;
  /** Submitting client numeric UTC offset, in minutes east of UTC. */
  offsetMinutes?: number;
}

export interface ParsedScheduleDirective {
  kind: 'send_in' | 'send_at';
  directive: string;
  clean_body: string;
  due_ts: string;
  host_offset_minutes: number;
}

const fail = (message: string): never => {
  throw new Error(message);
};

function relativeMilliseconds(value: string): number {
  const part = /(\d+)([dhms])/g;
  const ranks: Record<string, number> = { d: 4, h: 3, m: 2, s: 1 };
  const multipliers: Record<string, number> = {
    d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000,
  };
  let offset = 0;
  let total = 0;
  let previousRank = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  for (const match of value.matchAll(part)) {
    if (match.index !== offset) fail('malformed scheduling directive: invalid relative duration');
    const unit = match[2]!;
    if (seen.has(unit) || ranks[unit]! >= previousRank) {
      fail('malformed scheduling directive: duration units must be ordered d/h/m/s');
    }
    const amount = Number(match[1]);
    total += amount * multipliers[unit]!;
    if (!Number.isSafeInteger(total)) fail('malformed scheduling directive: relative duration is too large');
    seen.add(unit);
    previousRank = ranks[unit]!;
    offset = match.index + match[0].length;
  }
  if (offset !== value.length || offset === 0 || total <= 0) {
    fail('malformed scheduling directive: invalid relative duration');
  }
  return total;
}

function absoluteMilliseconds(value: string, nowMs: number, offsetMinutes: number): number {
  const clock = /^(?:(0?[1-9]|1[0-2]):([0-5]\d)(?::([0-5]\d))?\s*([AaPp][Mm])|([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?)$/.exec(value);
  if (clock) {
    let hour: number;
    let minute: number;
    let second: number;
    if (clock[4]) {
      hour = Number(clock[1]) % 12 + (clock[4].toLowerCase() === 'pm' ? 12 : 0);
      minute = Number(clock[2]);
      second = Number(clock[3] ?? 0);
    } else {
      hour = Number(clock[5]);
      minute = Number(clock[6]);
      second = Number(clock[7] ?? 0);
    }
    const offsetMs = offsetMinutes * 60_000;
    const local = new Date(nowMs + offsetMs);
    let due = Date.UTC(
      local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute, second,
    ) - offsetMs;
    if (due <= nowMs) due += 86_400_000;
    return due;
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    fail('malformed scheduling directive: send_at ISO input requires an explicit offset or Z');
  }
  const due = Date.parse(value);
  if (!Number.isFinite(due)) fail('malformed scheduling directive: invalid send_at instant');
  return due;
}

// harn:assume scheduling-directive-is-bounded-and-canonical ref=scheduled-directive-parser
export function parseScheduleDirective(
  body: string,
  options: ParseScheduleDirectiveOptions = {},
): ParsedScheduleDirective | undefined {
  const leading = body.match(/^\s*/)?.[0].length ?? 0;
  const first = body.slice(leading);
  if (!/^\[send_(?:in|at)(?:=|\b)/i.test(first)) return undefined;
  const close = first.indexOf(']');
  if (close < 0 || close + 1 > MAX_SCHEDULE_DIRECTIVE_CHARS) {
    fail('malformed scheduling directive: directive is incomplete or over 256 characters');
  }
  const directive = first.slice(0, close + 1);
  const match = /^\[(send_in|send_at)=([^\]\r\n]+)\]$/.exec(directive);
  const directiveMatch = match ?? fail('malformed scheduling directive');
  const cleanBody = first.slice(close + 1).trim();
  if (cleanBody.length === 0) fail('scheduled message body must not be empty');
  if (new TextEncoder().encode(cleanBody).byteLength > MAX_SCHEDULE_BODY_BYTES) {
    fail('scheduled message body exceeds 65536 UTF-8 bytes');
  }
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) fail('invalid scheduler clock');
  const offsetMinutes = options.hostOffsetMinutes ?? -now.getTimezoneOffset();
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < -840 || offsetMinutes > 840) {
    fail('invalid scheduler host offset');
  }
  const kind = directiveMatch[1]!.toLowerCase() as 'send_in' | 'send_at';
  const value = directiveMatch[2]!;
  const dueMs = kind === 'send_in'
    ? nowMs + relativeMilliseconds(value)
    : absoluteMilliseconds(value, nowMs, offsetMinutes);
  if (dueMs <= nowMs) fail('scheduled instant must be strictly in the future');
  if (dueMs - nowMs > MAX_SCHEDULE_HORIZON_MS) {
    fail('scheduled instant exceeds the 365 day horizon');
  }
  return {
    kind,
    directive,
    clean_body: cleanBody,
    due_ts: new Date(dueMs).toISOString(),
    host_offset_minutes: offsetMinutes,
  };
}

// harn:assume friendly-schedule-clocks-canonicalize-at-client-boundary ref=client-schedule-canonicalizer
/**
 * Canonicalize only the friendly, clock-only `send_at` form at the submitting
 * client boundary. The switchboard remains authoritative: malformed,
 * incomplete, non-leading, relative, and already-offset directives are left
 * byte-for-byte unchanged so it can report the same protocol error or apply
 * its accepted semantics.
 */
export function canonicalizeScheduleRequest(
  body: string,
  options: ScheduleCanonicalizationOptions = {},
): string {
  const leading = body.match(/^\s*/)?.[0].length ?? 0;
  const first = body.slice(leading);
  const match = /^\[send_at=([^\]\r\n]+)\]/.exec(first);
  if (match === null) return body;
  const value = match[1]!;
  // Do not reinterpret explicit instants, send_in, case variants, or malformed
  // clock text. `parseScheduleDirective` below remains the single bounds/
  // future/horizon validator for the one friendly form we do recognize.
  const clockOnly = /^(?:(0?[1-9]|1[0-2]):([0-5]\d)(?::[0-5]\d)?\s*[AaPp][Mm]|(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)$/;
  if (!clockOnly.test(value)) return body;
  const now = options.now ?? new Date();
  const offsetMinutes = options.offsetMinutes ?? -now.getTimezoneOffset();
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < -840 || offsetMinutes > 840) return body;
  let parsed: ParsedScheduleDirective;
  try {
    parsed = parseScheduleDirective(body, { now, hostOffsetMinutes: offsetMinutes })
      ?? (() => { throw new Error('not a schedule'); })();
  } catch {
    return body;
  }
  const due = Date.parse(parsed.due_ts);
  if (!Number.isFinite(due)) return body;
  const local = new Date(due + offsetMinutes * 60_000);
  const pad = (part: number): string => String(part).padStart(2, '0');
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
  const explicit = `${local.getUTCFullYear().toString().padStart(4, '0')}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`
    + `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${offset}`;
  const directiveEnd = leading + match[0].length;
  return `${body.slice(0, leading)}[send_at=${explicit}]${body.slice(directiveEnd)}`;
}
// harn:end friendly-schedule-clocks-canonicalize-at-client-boundary
// harn:end scheduling-directive-is-bounded-and-canonical
