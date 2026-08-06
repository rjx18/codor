import { z } from 'zod';

import { HandleSchema, MemberKindSchema } from './member.js';
import { MemberIdSchema, RoomIdSchema, TimestampSchema } from './ids.js';

// harn:assume registered-worktree-identities-are-durable ref=worktree-protocol-contract
/** A worktree/repository id is a Codor identity, not a Git branch or path. */
export const RepositoryIdSchema = z.ulid();
export const WorktreeIdSchema = z.ulid();

/** Cross-platform absolute paths are accepted at the wire boundary. The
 * switchboard canonicalizes existing paths before it invokes Git or persists
 * them; this schema only prevents relative path selectors. */
export const WorktreePathSchema = z.string().min(1).refine(
  (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'),
  'worktree paths must be absolute',
);

/** Aliases are display/routing selectors, never command fragments. */
export const WorktreeAliasSchema = z.string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

/** Branches are checked with Git as well as this bounded wire shape. */
export const WorktreeBranchSchema = z.string()
  .min(1)
  .max(255)
  .refine((value) => !value.startsWith('-'), 'branch names may not start with a dash');

export const WorktreeSourceSchema = z.enum(['main', 'adopted', 'created']);
export const WorktreeLifecycleSchema = z.enum(['active', 'unregistered', 'removed']);
export const WorktreeAvailabilitySchema = z.enum(['available', 'missing', 'locked', 'prunable']);
export type WorktreeSource = z.infer<typeof WorktreeSourceSchema>;
export type WorktreeLifecycle = z.infer<typeof WorktreeLifecycleSchema>;
export type WorktreeAvailability = z.infer<typeof WorktreeAvailabilitySchema>;

// harn:assume qualified-member-target-identity-is-durable ref=qualified-member-target-protocol
/**
 * A qualified route carries only stable Codor identities and bounded display
 * snapshots. It deliberately contains no path, branch, or Git administrative
 * identifier: routing never performs discovery and never exposes filesystem
 * state to a conversation.
 */
export const ScopedMemberTargetSchema = z.object({
  worktree_id: WorktreeIdSchema,
  conversation_id: RoomIdSchema,
  member_id: MemberIdSchema,
  alias: WorktreeAliasSchema,
  handle: HandleSchema,
});
export type ScopedMemberTarget = z.infer<typeof ScopedMemberTargetSchema>;

/** Safe member identity used by qualified completion and the routing parser. */
export const WorktreeRoutingMemberSchema = z.object({
  member_id: MemberIdSchema,
  handle: HandleSchema,
  kind: MemberKindSchema,
  display_name: z.string().optional(),
  purpose: z.string().optional(),
});
export type WorktreeRoutingMember = z.infer<typeof WorktreeRoutingMemberSchema>;

/** One registered worktree's path-free qualified-routing projection. */
export const WorktreeRoutingTargetSchema = z.object({
  worktree_id: WorktreeIdSchema,
  conversation_id: RoomIdSchema,
  alias: WorktreeAliasSchema,
  primary: z.boolean(),
  lifecycle: z.literal('active'),
  members: z.array(WorktreeRoutingMemberSchema),
});
export type WorktreeRoutingTarget = z.infer<typeof WorktreeRoutingTargetSchema>;

export const WorktreeRoutingTombstoneSchema = z.object({
  worktree_id: WorktreeIdSchema,
  conversation_id: RoomIdSchema,
  alias: WorktreeAliasSchema,
  lifecycle: z.enum(['unregistered', 'removed']),
});
export type WorktreeRoutingTombstone = z.infer<typeof WorktreeRoutingTombstoneSchema>;

export const WorktreeRoutingCatalogSchema = z.object({
  room: RoomIdSchema,
  targets: z.array(WorktreeRoutingTargetSchema),
  tombstones: z.array(WorktreeRoutingTombstoneSchema),
});
export type WorktreeRoutingCatalog = z.infer<typeof WorktreeRoutingCatalogSchema>;
// harn:end qualified-member-target-protocol

const CommitHashSchema = z.string().regex(/^[0-9a-f]{40}$/i);

export const RepositoryRecordSchema = z.object({
  id: RepositoryIdSchema,
  room: RoomIdSchema,
  common_path: WorktreePathSchema,
  primary_path: WorktreePathSchema,
  primary_git_admin_id: WorktreePathSchema,
  created_ts: TimestampSchema,
  updated_ts: TimestampSchema,
});
export type RepositoryRecord = z.infer<typeof RepositoryRecordSchema>;

export const RegisteredWorktreeSchema = z.object({
  id: WorktreeIdSchema,
  repository_id: RepositoryIdSchema,
  room: RoomIdSchema,
  // harn:assume registered-worktrees-materialize-stable-conversations ref=worktree-conversation-protocol
  /** Main points at the existing room; a secondary points at its hidden child room. */
  conversation_id: RoomIdSchema,
  alias: WorktreeAliasSchema,
  path: WorktreePathSchema,
  git_admin_id: WorktreePathSchema,
  primary: z.boolean(),
  source: WorktreeSourceSchema,
  lifecycle: WorktreeLifecycleSchema,
  availability: WorktreeAvailabilitySchema,
  locked: z.boolean(),
  head: CommitHashSchema.optional(),
  branch: z.string().min(1).optional(),
  registered_ts: TimestampSchema,
  updated_ts: TimestampSchema,
  unregistered_ts: TimestampSchema.optional(),
  removed_ts: TimestampSchema.optional(),
});
export type RegisteredWorktree = z.infer<typeof RegisteredWorktreeSchema>;
// harn:end registered-worktrees-materialize-stable-conversations

export const WorktreeDiscoveryCandidateSchema = z.object({
  path: WorktreePathSchema,
  git_admin_id: WorktreePathSchema,
  primary: z.boolean(),
  availability: WorktreeAvailabilitySchema,
  locked: z.boolean(),
  head: CommitHashSchema.optional(),
  branch: z.string().min(1).optional(),
  registered_id: WorktreeIdSchema.optional(),
  alias: WorktreeAliasSchema.optional(),
  conversation_id: RoomIdSchema.optional(),
});
export type WorktreeDiscoveryCandidate = z.infer<typeof WorktreeDiscoveryCandidateSchema>;

export const WorktreeListResponseSchema = z.object({
  repository: RepositoryRecordSchema.nullable(),
  registered: z.array(RegisteredWorktreeSchema),
  discovered: z.array(WorktreeDiscoveryCandidateSchema),
});
export type WorktreeListResponse = z.infer<typeof WorktreeListResponseSchema>;

export const WorktreeAdoptRequestSchema = z.object({
  path: WorktreePathSchema,
  alias: z.string().trim().min(1).max(128).optional(),
});
export type WorktreeAdoptRequest = z.infer<typeof WorktreeAdoptRequestSchema>;

export const WorktreeCreateRequestSchema = z.object({
  alias: z.string().trim().min(1).max(128),
  branch: WorktreeBranchSchema,
  path: WorktreePathSchema,
});
export type WorktreeCreateRequest = z.infer<typeof WorktreeCreateRequestSchema>;

// harn:assume child-files-voice-and-keys-are-isolated ref=conversation-key-response
/** A room key envelope is returned only when the caller has a paired browser device. */
export const WorktreeRoomKeySchema = z.object({
  room: RoomIdSchema,
  generation: z.number().int().positive(),
  sealed_key: z.string().min(1),
});
export type WorktreeRoomKey = z.infer<typeof WorktreeRoomKeySchema>;

export const WorktreeLifecycleResponseSchema = z.object({
  repository: RepositoryRecordSchema,
  worktree: RegisteredWorktreeSchema,
  room_key: WorktreeRoomKeySchema.optional(),
});
export type WorktreeLifecycleResponse = z.infer<typeof WorktreeLifecycleResponseSchema>;
// harn:end registered-worktree-identities-are-durable

// harn:assume worktree-discovery-never-registers-candidates ref=worktree-discovery-contract
export const WorktreeDiscoveryResponseSchema = WorktreeListResponseSchema;
export type WorktreeDiscoveryResponse = WorktreeListResponse;
// harn:end worktree-discovery-never-registers-candidates

// harn:assume worktree-creation-registers-only-a-new-secondary ref=worktree-create-contract
export const WorktreeCreateResponseSchema = WorktreeLifecycleResponseSchema;
// harn:end worktree-creation-registers-only-a-new-secondary

// harn:assume worktree-removal-is-clean-and-branch-preserving ref=worktree-remove-contract
export const WorktreeUnregisterResponseSchema = WorktreeLifecycleResponseSchema;
export const WorktreeRemoveResponseSchema = WorktreeLifecycleResponseSchema;
// harn:end worktree-removal-is-clean-and-branch-preserving
