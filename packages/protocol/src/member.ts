import { z } from 'zod';

import { MemberIdSchema } from './ids.js';

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
// harn:end reserved-handles-rejected

export const MemberSchema = z
  .object({
    id: MemberIdSchema,
    kind: MemberKindSchema,
    handle: HandleSchema,
    display_name: z.string(),
    // agent + extension only:
    harness: z.string().min(1).optional(), // adapter id, open set
    session_ref: z.string().min(1).optional(), // harness-native resume token
    cwd: z.string().min(1).optional(), // persisted launch dir — resume/revive MUST reuse it
    policy: z.string().min(1).optional(), // sandbox/permission mode chip
    host: z.string().min(1).optional(), // which switchboard machine owns the session
    state: MemberStateSchema.optional(),
    custody: CustodySchema.optional(),
    parent: MemberIdSchema.optional(), // extensions only: spawning member
    // humans only (enforcement lands M5):
    role: RoleSchema.optional(),
    // conventions trailer bookkeeping (persisted so restarts don't re-spam):
    conventions_sent: z.boolean().default(false),
    misaddressed: z.boolean().default(false),
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
  });
export type Member = z.infer<typeof MemberSchema>;
