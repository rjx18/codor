import { z } from 'zod';

import { ThinkingLevelSchema } from './adapter.js';
import { MemberIdSchema, TimestampSchema } from './ids.js';

export const MemberKindSchema = z.enum(['human', 'agent', 'extension', 'system', 'bridge']);
export type MemberKind = z.infer<typeof MemberKindSchema>;

export const MemberStateSchema = z.enum([
  'idle',
  'running',
  'queued',
  'awaiting_input',
  'paused',
  'dead',
  'unreachable', // resident switchboard offline (multi-box)
  'custody_uncertain', // attach lease lost, native process not confirmed dead — do not drive
]);
export type MemberState = z.infer<typeof MemberStateSchema>;

export const CustodySchema = z.enum(['owned', 'mirrored']);
export type Custody = z.infer<typeof CustodySchema>;

export const RoleSchema = z.enum(['owner', 'admin', 'member', 'observer']);
export type Role = z.infer<typeof RoleSchema>;

// harn:assume reserved-handles-rejected ref=handle-schema
export const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{1,30}$/;
export const RESERVED_HANDLES = ['all', 'switchboard'] as const;

/** Any syntactically valid handle (includes the reserved ones). */
export const HandleSchema = z.string().regex(HANDLE_REGEX);
export type Handle = z.infer<typeof HandleSchema>;

/**
 * A handle a real member may take: syntactically valid AND not reserved.
 * `all` is the post-MVP broadcast channel; `switchboard` is the system member.
 * All assignment paths (spawn, rename, join) validate against THIS schema.
 */
export const AssignableHandleSchema = HandleSchema.refine(
  (handle) => !(RESERVED_HANDLES as readonly string[]).includes(handle),
  { message: 'handle is reserved' },
);

// harn:assume starting-agent-name-derives-one-valid-identity-v6 ref=starting-agent-handle-derivation
/** Derives the strict member handle shown beneath a friendly starting-agent name. */
export function deriveAssignableHandle(name: string): string | undefined {
  const ascii = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const bounded = ascii.slice(0, 31).replace(/-+$/g, '');
  const candidate = bounded.length >= 2 ? bounded : 'agent';
  return AssignableHandleSchema.safeParse(candidate).success ? candidate : undefined;
}
// harn:end starting-agent-name-derives-one-valid-identity-v6
// harn:end reserved-handles-rejected

// harn:assume normalized-agent-usage-telemetry-with-estimates ref=agent-usage-telemetry-schema
/** Provider-neutral turn and context telemetry. Percentages are deliberately
 * absent: clients derive presentation from the reported used/max pair. */
export const AgentUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalCostUsd: z.number().nonnegative().optional(),
    contextWindowMaxTokens: z.number().int().positive().optional(),
    contextWindowUsedTokens: z.number().int().nonnegative().optional(),
    /** True when derived from session artifacts (pre-turn peek), not reported
     * live by the engine. Absence means engine-reported. */
    estimated: z.literal(true).optional(),
  })
  .strict()
  .superRefine((usage, ctx) => {
    if (
      (usage.contextWindowMaxTokens === undefined) !==
      (usage.contextWindowUsedTokens === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['contextWindowUsedTokens'],
        message: 'context window maximum and used tokens must be reported together',
      });
    }
  });
export type AgentUsage = z.infer<typeof AgentUsageSchema>;
// harn:end normalized-agent-usage-telemetry-with-estimates

// harn:assume agent-usage-limits-reported-not-guessed ref=agent-limit-schema
/** One harness-reported rate-limit window (e.g. claude-code's five_hour /
 *  weekly). Only ever what the harness said — never derived or aged. */
export const AgentLimitSchema = z.object({
  window: z.string().min(1), // harness-native window name, open set
  status: z.string().min(1).optional(), // e.g. allowed / allowed_warning / rejected
  resets_at: TimestampSchema.optional(),
  used_percent: z.number().min(0).max(100).optional(),
}).loose();
export type AgentLimit = z.infer<typeof AgentLimitSchema>;
// harn:end agent-usage-limits-reported-not-guessed

// harn:assume normalized-agent-task-updates-are-bounded-and-authoritative ref=agent-task-schema
/** Bounded normalized agent task-list truth. Adapters map only authoritative
 *  native structured checklists into these; content/active forms are trimmed. */
export const AgentTaskStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
export type AgentTaskStatus = z.infer<typeof AgentTaskStatusSchema>;

export const AgentTaskPrioritySchema = z.enum(['low', 'medium', 'high']);
export type AgentTaskPriority = z.infer<typeof AgentTaskPrioritySchema>;

const trimmedText = (max: number): z.ZodString => z.string().trim().min(1).max(max);
const uniqueTaskIds = <T extends { id: string }>(items: T[]): boolean =>
  new Set(items.map((task) => task.id)).size === items.length;

export const AgentTaskSchema = z.object({
  id: z.string().min(1).max(128),
  content: trimmedText(500),
  status: AgentTaskStatusSchema,
  active_form: trimmedText(500).optional(),
  priority: AgentTaskPrioritySchema.optional(),
});
export type AgentTask = z.infer<typeof AgentTaskSchema>;

export const AgentTaskListSchema = z.object({
  items: z.array(AgentTaskSchema).max(100).refine(uniqueTaskIds, { message: 'task ids must be unique' }),
  explanation: trimmedText(1000).optional(), // display context only — never authoritative task content
});
export type AgentTaskList = z.infer<typeof AgentTaskListSchema>;

export const AgentTaskPatchSchema = z
  .object({
    id: z.string().min(1).max(128),
    content: trimmedText(500).optional(),
    status: AgentTaskStatusSchema.optional(),
    active_form: trimmedText(500).optional(),
    priority: AgentTaskPrioritySchema.optional(),
  })
  .refine(
    (patch) => patch.content !== undefined || patch.status !== undefined ||
      patch.active_form !== undefined || patch.priority !== undefined,
    { message: 'patch must change at least one field besides id' },
  );
export type AgentTaskPatch = z.infer<typeof AgentTaskPatchSchema>;

/** A complete authoritative snapshot (`replace`, empty clears) or an id-based
 *  `upsert` batch. Duplicate ids or any over-bound/malformed member rejects the
 *  whole update rather than partially landing it. */
export const AgentTaskUpdateSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('replace'),
    items: z.array(AgentTaskSchema).max(100).refine(uniqueTaskIds, { message: 'task ids must be unique' }),
    explanation: trimmedText(1000).optional(),
  }),
  z.object({
    op: z.literal('upsert'),
    items: z.array(AgentTaskPatchSchema).min(1).max(100).refine(uniqueTaskIds, { message: 'task ids must be unique' }),
  }),
]);
export type AgentTaskUpdate = z.infer<typeof AgentTaskUpdateSchema>;
// harn:end normalized-agent-task-updates-are-bounded-and-authoritative

export const MemberSchema = z
  .object({
    id: MemberIdSchema,
    kind: MemberKindSchema,
    handle: HandleSchema,
    display_name: z.string(),
    // harn:assume member-purpose-protocol-metadata ref=member-purpose-field
    purpose: z.string().optional(),
    // harn:end member-purpose-protocol-metadata
    // agent + extension only:
    harness: z.string().min(1).optional(), // adapter id, open set
    session_ref: z.string().min(1).optional(), // harness-native resume token
    cwd: z.string().min(1).optional(), // persisted launch dir — resume/revive MUST reuse it
    policy: z.string().min(1).optional(), // sandbox/permission mode chip
    // harn:assume durable-agent-runtime-configuration ref=durable-agent-runtime-schema
    // Member state, not spawn-time arguments. The harness holds nothing: every turn is
    // a fresh subprocess whose argv is re-derived from the session, so a rebuild that
    // loses these downgrades the agent to its harness default without saying so.
    // Absent means exactly that — the harness default — never a guess.
    model: z.string().min(1).optional(),
    thinking: ThinkingLevelSchema.optional(),
    // harn:end durable-agent-runtime-configuration
    host: z.string().min(1).optional(), // which switchboard machine owns the session
    // harn:assume agent-usage-limits-reported-not-guessed ref=agent-limit-schema
    // Last-known harness-reported rate-limit windows; absent when the harness
    // reports none. Provider status, not configuration — refreshed by reports.
    limits: z.array(AgentLimitSchema).optional(),
    // harn:end agent-usage-limits-reported-not-guessed
    // harn:assume member-task-projection-is-durable-and-session-scoped ref=member-task-projection-schema
    // Current bounded task checklist, materialized from run.tasks updates and
    // scoped to the native session. A durable projection — never journal evidence.
    tasks: AgentTaskListSchema.optional(),
    // harn:end member-task-projection-is-durable-and-session-scoped
    // harn:assume normalized-agent-usage-telemetry-with-estimates ref=agent-usage-telemetry-schema
    // harn:assume last-agent-usage-is-transient-and-seeded ref=last-usage-member-projection
    lastUsage: AgentUsageSchema.optional(),
    // harn:end last-agent-usage-is-transient-and-seeded
    // harn:end normalized-agent-usage-telemetry-with-estimates
    state: MemberStateSchema.optional(),
    custody: CustodySchema.optional(),
    parent: MemberIdSchema.optional(), // extensions only: spawning member
    // humans only (enforcement lands M5):
    role: RoleSchema.optional(),
    // conventions trailer bookkeeping (persisted so restarts don't re-spam):
    conventions_sent: z.boolean().default(false),
    misaddressed: z.boolean().default(false),
    // harn:assume roster-briefing-refreshes-on-membership ref=roster-stale-member-field
    roster_stale: z.boolean().default(true),
    // harn:end roster-briefing-refreshes-on-membership
    // harn:assume member-removal-timestamp-protocol ref=member-removal-field
    removed_ts: TimestampSchema.optional(),
    // harn:end member-removal-timestamp-protocol
    // harn:assume waiting-is-visible-member-state ref=member-waiting-field
    // What this member is blocked on, if anything. Transient — it lives for the duration of
    // a turn and is never persisted.
    //
    // An agent that is merely quiet is indistinguishable from an agent that is stuck, and
    // the operator is the one who has to tell them apart. `peers` is who it waits on,
    // `reason` is what would release it, `until_ts` is when it gives up. Absent means it is
    // not waiting — which is what every member frame has meant until now.
    waiting: z
      .object({
        peers: z.array(MemberIdSchema).min(1),
        reason: z.enum(['reply', 'mention', 'any']),
        since_ts: TimestampSchema,
        until_ts: TimestampSchema,
      })
      .optional(),
    // harn:end waiting-is-visible-member-state
  })
  .superRefine((member, ctx) => {
    if (
      member.kind !== 'system' &&
      (RESERVED_HANDLES as readonly string[]).includes(member.handle)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['handle'],
        message: `handle '${member.handle}' is reserved for the system member`,
      });
    }
    if (member.kind === 'human' && member.role === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['role'],
        message: 'human members require a role',
      });
    } else if (member.kind !== 'human' && member.role !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['role'],
        message: 'only human members may have a role',
      });
    }
  });
export type Member = z.infer<typeof MemberSchema>;
