import { describe, expect, it } from 'vitest';

import {
  RepositoryRecordSchema,
  RegisteredWorktreeSchema,
  WorktreeAdoptRequestSchema,
  WorktreeCreateRequestSchema,
  WorktreeDiscoveryResponseSchema,
  WorktreeLifecycleResponseSchema,
  WorktreeListResponseSchema,
  WorktreeRoomKeySchema,
  WorktreeRoutingCatalogSchema,
} from './worktree.js';

const repository = {
  id: '01J00000000000000000000000',
  room: 'eng',
  common_path: '/tmp/repo/.git',
  primary_path: '/tmp/repo',
  primary_git_admin_id: '/tmp/repo/.git',
  created_ts: '2026-08-06T00:00:00.000Z',
  updated_ts: '2026-08-06T00:00:00.000Z',
};

const worktree = {
  id: '01J00000000000000000000001',
  repository_id: repository.id,
  room: repository.room,
  conversation_id: 'wt-01j00000000000000000000001',
  alias: 'review-a',
  path: '/tmp/repo/review a',
  git_admin_id: '/tmp/repo/.git/worktrees/review-a',
  primary: false,
  source: 'adopted',
  lifecycle: 'active',
  availability: 'available',
  locked: false,
  head: '0123456789abcdef0123456789abcdef01234567',
  branch: 'review-a',
  registered_ts: repository.created_ts,
  updated_ts: repository.updated_ts,
};

// harn:assume registered-worktree-identities-are-durable ref=worktree-protocol-regression
// harn:assume registered-worktrees-materialize-stable-conversations ref=worktree-conversation-protocol-regression
describe('native worktree protocol', () => {
  it('accepts bounded durable repository and worktree records', () => {
    expect(RepositoryRecordSchema.parse(repository)).toEqual(repository);
    expect(RegisteredWorktreeSchema.parse(worktree)).toEqual(worktree);
    expect(WorktreeLifecycleResponseSchema.parse({ repository, worktree })).toEqual({
      repository,
      worktree,
    });
    const roomKey = {
      room: worktree.conversation_id,
      generation: 1,
      sealed_key: 'sealed-child-key',
    };
    expect(WorktreeRoomKeySchema.parse(roomKey)).toEqual(roomKey);
    expect(WorktreeLifecycleResponseSchema.parse({ repository, worktree, room_key: roomKey }))
      .toEqual({ repository, worktree, room_key: roomKey });
  });

  it('rejects relative paths, main aliases, malformed ids, and invalid lifecycle values', () => {
    expect(WorktreeAdoptRequestSchema.safeParse({ path: 'relative/repo' }).success).toBe(false);
    expect(WorktreeCreateRequestSchema.safeParse({
      alias: '', branch: 'feature', path: '/tmp/target',
    }).success).toBe(false);
    expect(RegisteredWorktreeSchema.safeParse({ ...worktree, alias: '--not-safe' }).success).toBe(false);
    expect(RegisteredWorktreeSchema.safeParse({ ...worktree, id: 'not-an-ulid' }).success).toBe(false);
    expect(RegisteredWorktreeSchema.safeParse({ ...worktree, alias: 'Main' }).success).toBe(false);
    expect(RegisteredWorktreeSchema.safeParse({ ...worktree, lifecycle: 'active-ish' }).success).toBe(false);
    expect(RegisteredWorktreeSchema.safeParse({ ...worktree, conversation_id: 'not a room' }).success)
      .toBe(false);
    expect(WorktreeRoomKeySchema.safeParse({
      room: worktree.conversation_id, generation: 0, sealed_key: 'key',
    }).success).toBe(false);
  });

  it('keeps discovery candidates separate from registered projections', () => {
    const response = {
      repository,
      registered: [worktree],
      discovered: [
        {
          path: repository.primary_path,
          git_admin_id: repository.primary_git_admin_id,
          primary: true,
          availability: 'available',
          locked: false,
        },
        {
          path: '/tmp/repo/unselected',
          git_admin_id: '/tmp/repo/.git/worktrees/unselected',
          primary: false,
          availability: 'available',
          locked: false,
        },
      ],
    };
    expect(WorktreeListResponseSchema.parse(response).discovered).toHaveLength(2);
    expect(WorktreeDiscoveryResponseSchema.parse(response).registered).toHaveLength(1);
  });
});
// harn:end registered-worktrees-materialize-stable-conversations
// harn:end registered-worktree-identities-are-durable

it('rejects duplicate stable identities and an active/removed member collision', () => {
  const target = {
    worktree_id: worktree.id,
    conversation_id: worktree.conversation_id,
    alias: worktree.alias,
    primary: false,
    lifecycle: 'active' as const,
    members: [{ member_id: '01J00000000000000000000003', handle: 'richard', kind: 'human' as const }],
  };
  expect(WorktreeRoutingCatalogSchema.safeParse({
    room: repository.room,
    targets: [target, { ...target, worktree_id: '01J00000000000000000000006', alias: 'other' }],
    tombstones: [],
  }).success).toBe(false);
  const withRemovedMember = WorktreeRoutingCatalogSchema.parse({
    room: repository.room,
    targets: [{
      ...target,
      removed_members: [{ member_id: '01J00000000000000000000005', handle: 'old-agent', kind: 'agent' as const }],
    }],
    tombstones: [],
  });
  expect(withRemovedMember.targets[0]?.removed_members).toEqual([{
    member_id: '01J00000000000000000000005', handle: 'old-agent', kind: 'agent',
  }]);
  expect(WorktreeRoutingCatalogSchema.safeParse({
    room: repository.room,
    targets: [{ ...target, primary: true, alias: 'review-a' }],
    tombstones: [],
  }).success).toBe(false);
  expect(WorktreeRoutingCatalogSchema.safeParse({
    room: repository.room,
    targets: [{
      ...target,
      removed_members: [{ member_id: '01J00000000000000000000003', handle: 'richard', kind: 'human' as const }],
    }],
    tombstones: [],
  }).success).toBe(false);
});

// harn:assume worktree-discovery-never-registers-candidates ref=worktree-discovery-regression
describe('discovery contract', () => {
  it('does not make a discovery response look like an adoption', () => {
    const response = WorktreeDiscoveryResponseSchema.parse({
      repository: null,
      registered: [],
      discovered: [{
        path: '/tmp/unselected',
        git_admin_id: '/tmp/repo/.git/worktrees/unselected',
        primary: false,
        availability: 'available',
        locked: false,
      }],
    });
    expect(response.registered).toEqual([]);
    expect(response.discovered[0]?.registered_id).toBeUndefined();
  });
});
// harn:end worktree-discovery-never-registers-candidates

// harn:assume qualified-member-target-identity-is-durable ref=qualified-member-target-protocol-regression
describe('qualified routing projection protocol', () => {
  it('accepts stable main and secondary targets while excluding filesystem metadata', () => {
    const catalog = WorktreeRoutingCatalogSchema.parse({
      room: repository.room,
      targets: [
        {
          worktree_id: '01J00000000000000000000000',
          conversation_id: repository.room,
          alias: 'main',
          primary: true,
          lifecycle: 'active',
          members: [{
            member_id: '01J00000000000000000000002',
            handle: 'richard',
            kind: 'human',
          }],
        },
        {
          worktree_id: worktree.id,
          conversation_id: worktree.conversation_id,
          alias: worktree.alias,
          primary: false,
          lifecycle: 'active',
          members: [{
            member_id: '01J00000000000000000000003',
            handle: 'richard',
            kind: 'human',
          }],
        },
      ],
      tombstones: [{
        worktree_id: '01J00000000000000000000004',
        conversation_id: 'wt-removed',
        alias: 'old-review',
        lifecycle: 'removed',
      }],
    });
    expect(catalog.targets.map((target) => target.alias)).toEqual(['main', 'review-a']);
    expect(JSON.stringify(catalog)).not.toMatch(/path|branch|git_admin/i);
  });

});
// harn:end qualified-member-target-identity-is-durable
