import { CHANNEL_ACCENTS, deriveRoomColor, worktreeSelectorFromBranch } from '@codor/protocol';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deterministicWorktreeConversationId, Store, type WorktreeObservation } from './store.js';
import { estimateCostUsd } from './pricing.js';

let dir: string;
let store: Store;

// harn:assume scheduled-state-machine-recovers-from-one-next-due-alarm ref=schedule-recovery-regression
// harn:assume scheduled-message-commit-is-exactly-once ref=exactly-once-schedule-regression
describe('durable scheduled-message store', () => {
  it('persists, atomically claims, cancels, and reopens schedules', () => {
    const { owner } = openRoom(store);
    const target = store.addMember('eng', {
      kind: 'agent', handle: 'sol', display_name: 'Sol', harness: 'fake', cwd: dir,
    });
    const schedule = store.createSchedule({
      room: 'eng', author_id: owner.id, author_handle: owner.handle,
      target: { member_id: target.id, conversation_id: 'eng', handle: target.handle },
      body: '@sol ship it', mentions: [{ member_id: target.id, start: 0, end: 4 }],
      due_ts: '2026-08-13T00:00:00.000Z', host_offset_minutes: 480,
    }, '2026-08-12T00:00:00.000Z');
    expect(store.claimDueSchedules('2026-08-13T00:00:00.000Z')).toEqual([
      expect.objectContaining({ id: schedule.id, state: 'sending' }),
    ]);
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.listRecoverableSchedules()).toEqual([
      expect.objectContaining({ id: schedule.id, state: 'sending' }),
    ]);
  });

});
// harn:end scheduled-message-commit-is-exactly-once
// harn:end scheduled-state-machine-recovers-from-one-next-due-alarm

const openRoom = (s: Store) =>
  s.createRoom({ id: 'eng', name: 'Engineering', owner: { handle: 'richard', display_name: 'Richard' } });

// harn:assume registered-worktree-identities-are-durable ref=worktree-store-schema
describe('registered worktree store schema', () => {
  it('creates the repository and active/tombstone tables without touching room sync state', () => {
    openRoom(store);
    const readonly = new Database(join(dir, 'test.sqlite'));
    const tables = readonly
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('repositories', 'worktrees') ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((table) => table.name)).toEqual(['repositories', 'worktrees']);
    readonly.close();
    expect(store.currentSeq('eng')).toBe(3);
  });
});
// harn:end registered-worktree-identities-are-durable

// harn:assume registered-worktree-identities-are-durable ref=worktree-store-lifecycle
describe('registered worktree store lifecycle', () => {
  const observations = () => {
    const main: WorktreeObservation = {
      path: join(dir, 'repo'),
      git_admin_id: join(dir, 'repo', '.git'),
      primary: true,
      availability: 'available',
      locked: false,
      head: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main',
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'repo child'),
      git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'),
      primary: false,
      availability: 'available',
      locked: false,
      head: main.head,
      branch: 'feature/child',
    };
    return { main, secondary };
  };

  it('persists stable main/secondary identities, tombstones, re-adoption, and reopen', () => {
    openRoom(store);
    const beforeSeq = store.currentSeq('eng');
    const { main, secondary } = observations();
    const first = store.registerWorktree(
      'eng',
      {
        common_path: join(dir, 'repo', '.git'),
        primary_path: main.path,
        primary_git_admin_id: main.git_admin_id,
      },
      main,
      secondary,
      'child-label',
      'adopted',
    );
    expect(first.worktree.alias).toBe(worktreeSelectorFromBranch('feature/child'));
    expect(first.worktree.conversation_id).toMatch(/^eng-feature-child-[a-f0-9]{8}$/);
    expect(first.worktree.conversation_id).not.toBe('eng');
    expect(store.listRegisteredWorktrees('eng').find((item) => item.primary)?.conversation_id)
      .toBe('eng');
    expect(store.getRoom(first.worktree.conversation_id)).toBeDefined();
    expect(store.listPublicRooms().map((room) => room.id)).toEqual(['eng']);
    expect(store.listMembers(first.worktree.conversation_id).map((member) => member.kind).sort())
      .toEqual(['human', 'system'].sort());
    expect(store.listRegisteredWorktrees('eng')).toHaveLength(2);
    expect(store.currentSeq('eng')).toBe(beforeSeq);

    const unregistered = store.unregisterWorktree('eng', first.worktree.id, '2026-08-06T00:01:00.000Z');
    expect(unregistered).toMatchObject({ lifecycle: 'unregistered', unregistered_ts: '2026-08-06T00:01:00.000Z' });
    const readopted = store.registerWorktree(
      'eng',
      {
        common_path: join(dir, 'repo', '.git'),
        primary_path: main.path,
        primary_git_admin_id: main.git_admin_id,
      },
      main,
      { ...secondary, path: join(dir, 'moved child') },
      'child-renamed',
      'adopted',
      '2026-08-06T00:02:00.000Z',
    );
    expect(readopted.worktree.id).toBe(first.worktree.id);
    expect(readopted.worktree.path).toBe(join(dir, 'moved child'));
    expect(readopted.worktree.lifecycle).toBe('active');

    const removed = store.removeWorktree('eng', first.worktree.id, '2026-08-06T00:03:00.000Z');
    expect(removed).toMatchObject({ lifecycle: 'removed', branch: 'feature/child' });
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getRepository('eng')?.id).toBe(first.repository.id);
    expect(store.getWorktree('eng', first.worktree.id)).toMatchObject({
      id: first.worktree.id,
      lifecycle: 'removed',
      removed_ts: '2026-08-06T00:03:00.000Z',
      branch: 'feature/child',
      conversation_id: first.worktree.conversation_id,
    });
    expect(store.getRoom(first.worktree.conversation_id)).toBeDefined();
    expect(store.listPublicRooms().map((room) => room.id)).toEqual(['eng']);
    expect(store.currentSeq('eng')).toBe(beforeSeq);
  });
});
// harn:end registered-worktree-identities-are-durable

// harn:assume registered-worktree-identities-are-durable ref=worktree-store-regression
describe('registered worktree store constraints', () => {
  it('keeps active aliases unique while allowing a tombstone to retain history', () => {
    openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false,
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false,
    };
    store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'same', 'created');
    const second: WorktreeObservation = { ...secondary, path: join(dir, 'child-two'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child-two') };
    expect(() => store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, second, 'same', 'created')).toThrow();
    expect(store.listRegisteredWorktrees('eng')).toHaveLength(2);
  });
});
// harn:end registered-worktree-identities-are-durable

// harn:assume registered-worktrees-materialize-stable-conversations ref=worktree-conversation-migration
// harn:assume registered-worktrees-materialize-stable-conversations ref=worktree-conversation-store-regression
describe('worktree conversation migration and identity', () => {
  it('backfills Phase 1 rows idempotently without rewriting the root transcript', () => {
    const { owner } = openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false, branch: 'main',
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false, branch: 'feature/child',
    };
    const rootMessage = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'root history' });
    const registered = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'child', 'adopted');
    const rootSeq = store.currentSeq('eng');
    store.close();

    const legacy = new Database(join(dir, 'test.sqlite'));
    legacy.exec('DROP INDEX worktrees_conversation_unique; ALTER TABLE worktrees DROP COLUMN conversation_id');
    legacy.exec(`
      DELETE FROM changes WHERE room_id = '${registered.worktree.conversation_id}';
      DELETE FROM room_read_cursors WHERE room = '${registered.worktree.conversation_id}';
      DELETE FROM rooms WHERE id = '${registered.worktree.conversation_id}';
    `);
    legacy.close();
    store = new Store(join(dir, 'test.sqlite'));

    expect(store.getMessage('eng', rootMessage.id)).toEqual(rootMessage);
    expect(store.currentSeq('eng')).toBe(rootSeq);
    const migrated = store.getWorktree('eng', registered.worktree.id)!;
    expect(migrated.conversation_id).toBe(registered.worktree.conversation_id);
    expect(store.getRoom(migrated.conversation_id)).toBeDefined();
    expect(store.listMembers(migrated.conversation_id).map((member) => member.id))
      .toEqual(store.listMembers('eng').map((member) => member.id));

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getWorktree('eng', registered.worktree.id)?.conversation_id)
      .toBe(migrated.conversation_id);
    expect(store.currentSeq('eng')).toBe(rootSeq);
  });

  it('keeps main and child room state independent across reopen', () => {
    const { owner } = openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false,
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false,
    };
    const registered = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'child', 'created');
    const child = registered.worktree.conversation_id;
    const mainAgent = store.addMember('eng', {
      kind: 'agent', handle: 'same-handle', display_name: 'Main Agent', state: 'idle',
    });
    const childAgent = store.addMember(child, {
      kind: 'agent', handle: 'same-handle', display_name: 'Child Agent', state: 'idle',
    });
    expect(mainAgent.id).not.toBe(childAgent.id);
    expect(store.getMember(child, owner.id)).toMatchObject({ id: owner.id, kind: 'human' });
    expect(store.listMembers(child).filter((member) => member.kind === 'agent')).toEqual([childAgent]);

    const mainMessage = store.postMessage('eng', { author: mainAgent.id, kind: 'chat', body: 'main-only' });
    const childMessage = store.postMessage(child, { author: childAgent.id, kind: 'chat', body: 'child-only' });
    expect(mainMessage.id).toBe(1);
    expect(childMessage.id).toBe(1);
    expect(store.listMessages('eng')).toEqual([mainMessage]);
    expect(store.listMessages(child)).toEqual([childMessage]);
    expect(store.roomSupport('eng', owner.id).summary.latest?.preview).toBe('main-only');
    expect(store.roomSupport(child, owner.id).summary.latest?.preview).toBe('child-only');
    expect(store.countUnreadMessages('eng', owner.id)).toBe(1);
    expect(store.countUnreadMessages(child, owner.id)).toBe(1);
    store.markRoomRead('eng', owner.id, store.currentSeq('eng'));
    expect(store.countUnreadMessages('eng', owner.id)).toBe(0);
    expect(store.countUnreadMessages(child, owner.id)).toBe(1);

    const day = '2026-08-06';
    store.bumpMeter('eng', day, { turns: 1, input_tokens: 10 });
    store.bumpMeter(child, day, { turns: 2, output_tokens: 20 });
    expect(store.getMeter('eng', day)).toMatchObject({ turns: 1, input_tokens: 10, output_tokens: 0 });
    expect(store.getMeter(child, day)).toMatchObject({ turns: 2, input_tokens: 0, output_tokens: 20 });

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.listMessages(child)).toMatchObject([{ id: 1, body: 'child-only' }]);
    expect(store.countUnreadMessages(child, owner.id)).toBe(1);
    expect(store.getMeter(child, day)).toMatchObject({ turns: 2, output_tokens: 20 });
  });
});
// harn:end registered-worktrees-materialize-stable-conversations
// harn:end registered-worktrees-materialize-stable-conversations

// harn:assume child-conversation-state-is-room-isolated ref=conversation-room-state-regression
// harn:assume child-conversation-state-is-room-isolated ref=conversation-read-cursor-seeding
describe('child conversation inherited identities and cursors', () => {
  it('seeds root humans in every child and adds later root humans without cloning rows', () => {
    const { owner } = openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false,
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false,
    };
    const registered = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'child', 'adopted');
    const child = registered.worktree.conversation_id;
    const childOwner = store.getMember(child, owner.id)!;
    expect(childOwner.id).toBe(owner.id);
    expect(store.getRoomReadSeq(child, owner.id)).toBe(store.currentSeq(child));

    const later = store.addMember('eng', {
      kind: 'human', handle: 'later-human', display_name: 'Later Human', role: 'member',
    });
    expect(store.getMember(child, later.id)).toMatchObject({ id: later.id, handle: 'later-human' });
    expect(store.listMembers(child).map((member) => member.id)).toContain(later.id);
    expect(store.getRoomReadSeq(child, later.id)).toBe(store.currentSeq(child));
    expect(store.listMembers(child).filter((member) => member.id === later.id)).toHaveLength(1);

    store.updateMember('eng', owner.id, { display_name: 'Richard Renamed' });
    expect(store.getMember(child, owner.id)?.display_name).toBe('Richard Renamed');
    expect(store.sync(child, 0).members.find((member) => member.id === owner.id)?.display_name)
      .toBe('Richard Renamed');
  });
});
// harn:end child-conversation-state-is-room-isolated
// harn:end child-conversation-state-is-room-isolated

// harn:assume qualified-member-target-identity-is-durable ref=qualified-routing-store-regression
describe('qualified routing store projection', () => {
  it('projects active scopes and tombstones from persisted rows without paths', () => {
    openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false, branch: 'main',
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false, branch: 'feature/child',
    };
    const registered = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'child', 'adopted');
    const child = registered.worktree.conversation_id;
    const childAgent = store.addMember(child, {
      kind: 'agent', handle: 'coder', display_name: 'Child Coder', state: 'idle',
    });
    const first = store.routingCatalog('eng');
    expect(first.room).toBe('eng');
    const childAlias = worktreeSelectorFromBranch('feature/child');
    expect(first.targets.map((target) => target.alias)).toEqual(['main', childAlias]);
    const target = first.targets.find((candidate) => candidate.alias === childAlias)!;
    expect(target.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ member_id: childAgent.id, handle: 'coder', kind: 'agent' }),
    ]));
    expect(JSON.stringify(first)).not.toMatch(/path|branch|git_admin/i);

    const refreshed = store.refreshWorktreeObservation('eng', registered.worktree.id, {
      ...secondary, path: join(dir, 'moved-child'),
    });
    expect(refreshed.id).toBe(registered.worktree.id);
    expect(store.routingCatalog('eng').targets.find((candidate) => candidate.alias === childAlias)?.worktree_id)
      .toBe(registered.worktree.id);

    const tombstone = store.unregisterWorktree('eng', registered.worktree.id);
    expect(store.routingCatalog('eng').targets.map((candidate) => candidate.alias)).toEqual(['main']);
    expect(store.routingCatalog('eng').tombstones).toEqual([
      expect.objectContaining({ alias: childAlias, lifecycle: 'unregistered' }),
    ]);
    expect(tombstone.conversation_id).toBe(child);
  });

  it('projects removed members as bounded tombstones and refuses stale scoped rows', () => {
    openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false, branch: 'main',
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false, branch: 'feature/child',
    };
    const registered = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'child', 'adopted');
    const child = registered.worktree.conversation_id;
    const childAgent = store.addMember(child, {
      kind: 'agent', handle: 'old-coder', display_name: 'Old Coder', state: 'idle',
    });
    const target = {
      worktree_id: registered.worktree.id, conversation_id: child, member_id: childAgent.id,
      alias: worktreeSelectorFromBranch('feature/child'), handle: 'old-coder',
    } as const;
    const message = store.postMessage('eng', {
      author: store.getMemberByHandle('eng', 'richard')!.id,
      kind: 'chat',
      body: 'stale target',
    });

    store.updateMember(child, childAgent.id, { removed_ts: '2026-08-06T00:10:00.000Z', state: 'dead' });
    const projected = store.routingCatalog('eng');
    expect(projected.targets.find((item) => item.alias === worktreeSelectorFromBranch('feature/child'))).toMatchObject({
      removed_members: [{ member_id: childAgent.id, handle: 'old-coder', kind: 'agent' }],
    });
    expect(projected.targets.find((item) => item.alias === 'child')?.members)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ handle: 'old-coder' })]));
    expect(store.routingTargetIsActive(target, 'eng')).toBe(false);
    expect(() => store.createDelivery('eng', {
      message_id: message.id, recipient: childAgent.id, target,
    })).toThrow(/qualified delivery target is not active/);
  });

  it('bounds removed-member tombstones deterministically before protocol validation', () => {
    openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false, branch: 'main',
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false, branch: 'feature/child',
    };
    const registered = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'child', 'adopted');
    const child = registered.worktree.conversation_id;
    const removed = Array.from({ length: 260 }, (_, index) => store.addMember(child, {
      kind: 'agent', handle: `old-${String(index)}`, display_name: `Old ${String(index)}`, state: 'idle',
    }));
    for (const member of removed) {
      store.updateMember(child, member.id, {
        removed_ts: '2026-08-06T00:00:00.000Z',
        state: 'dead',
      });
    }
    const projected = store.routingCatalog('eng').targets.find(
      (target) => target.alias === worktreeSelectorFromBranch('feature/child'),
    )!;
    const expected = removed.map((member) => member.id).sort().slice(0, 256);
    expect(projected.removed_members).toHaveLength(256);
    expect(projected.removed_members?.map((member) => member.member_id)).toEqual(expected);
  });

  it('rejects a scoped delivery whose origin belongs to another repository', () => {
    openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false,
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false,
    };
    const registered = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'child', 'adopted');
    const child = registered.worktree.conversation_id;
    const childAgent = store.addMember(child, {
      kind: 'agent', handle: 'foreign-check', display_name: 'Foreign Check', state: 'idle',
    });
    store.createRoom({ id: 'ops', name: 'Operations', owner: { handle: 'ops-owner', display_name: 'Ops Owner' } });
    const target = {
      worktree_id: registered.worktree.id, conversation_id: child, member_id: childAgent.id,
      alias: 'child', handle: childAgent.handle,
    } as const;
    const message = store.postMessage('ops', {
      author: store.getMemberByHandle('ops', 'ops-owner')!.id, kind: 'chat', body: 'foreign origin',
    });
    expect(store.routingTargetIsActive(target, 'ops')).toBe(false);
    expect(() => store.createDelivery('ops', {
      message_id: message.id, recipient: childAgent.id, target,
    })).toThrow(/qualified delivery target is not active/);
    expect(store.listDeliveries('ops')).toEqual([]);
    expect(store.listDeliveriesForTarget(child, childAgent.id)).toEqual([]);
  });

  const seedLegacyForeignDelivery = () => {
    const { owner } = openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false, branch: 'main',
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false, branch: 'feature/child',
    };
    const registered = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'child', 'adopted');
    const child = registered.worktree.conversation_id;
    const agent = store.addMember(child, {
      kind: 'agent', handle: 'legacy-agent', display_name: 'Legacy Agent', state: 'idle',
    });
    const target = {
      worktree_id: registered.worktree.id, conversation_id: child, member_id: agent.id,
      alias: 'child', handle: agent.handle,
    } as const;
    // A legacy cross-repository row: it lives in ops but points at the eng
    // repository tree, so no valid origin ever validates it against itself.
    store.createRoom({ id: 'ops', name: 'Operations', owner: { handle: 'ops-owner', display_name: 'Ops Owner' } });
    const message = store.postMessage('ops', {
      author: store.getMemberByHandle('ops', 'ops-owner')!.id, kind: 'chat', body: 'legacy foreign row',
    });
    const legacy = new Database(join(dir, 'test.sqlite'));
    legacy
      .prepare(
        `INSERT INTO deliveries (id, room, message_id, recipient, target_worktree_id,
           target_conversation_id, target_alias, target_handle, state, attempt_count,
           batch_id, run_msg_id, read_ts, interaction_resolved_ts, payload_snapshot,
           process_id, process_group_id, hop_count, queue_seq, group_id, group_round, ts)
         VALUES (?, 'ops', ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
           (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM deliveries), NULL, NULL, ?)`,
      )
      .run(
        `legacy-${message.id}`,
        message.id,
        agent.id,
        target.worktree_id,
        target.conversation_id,
        target.alias,
        target.handle,
        new Date().toISOString(),
      );
    legacy.close();
    return { owner, agent, target, message, foreignId: `legacy-${message.id}` };
  };

  it('settles a legacy cross-repository queued row with exactly one durable refusal', () => {
    const { foreignId } = seedLegacyForeignDelivery();
    expect(store.routingTargetIsActive(
      store.getDelivery('ops', foreignId)!.target!,
      'ops',
    )).toBe(false);

    const reason = 'registered target child:@legacy-agent is no longer valid';
    const settled = store.settleStaleScopedDelivery('ops', {
      deliveryId: foreignId,
      reason,
      settledTs: '2026-08-06T00:40:00.000Z',
    });
    expect(settled.settled).toBe(true);
    expect(settled.delivery.state).toBe('consumed');
    expect(settled.refusal).toMatchObject({ kind: 'system', body: `qualified target refused: ${reason}` });

    // The refusal is created by the transition itself: a repeat settles
    // nothing and says nothing, and the refusal stays only in the origin.
    const repeat = store.settleStaleScopedDelivery('ops', {
      deliveryId: foreignId,
      reason,
      settledTs: '2026-08-06T00:41:00.000Z',
    });
    expect(repeat.settled).toBe(false);
    expect(repeat.refusal).toBeUndefined();
    expect(store.listMessages('ops').filter((message) => message.kind === 'system')).toHaveLength(1);
    expect(store.listMessages('eng').filter((message) => message.kind === 'system')).toHaveLength(0);

    // A started row is rejected by this seam — it belongs to attempt settlement.
    store.updateDelivery('ops', foreignId, { state: 'delivering', run_msg_id: 1 });
    expect(() => store.settleStaleScopedDelivery('ops', {
      deliveryId: foreignId,
      reason,
      settledTs: '2026-08-06T00:42:00.000Z',
    })).toThrow(/already started/);
  });

  it('settles a started scoped attempt atomically with truthful group evidence', () => {
    const { owner, agent, target } = seedLegacyForeignDelivery();
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'group-alpha', display_name: 'Group Alpha', state: 'idle',
    });
    const root = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@group-alpha scoped round' });
    const group = store.createCollaborationGroup('eng', {
      groupId: 'scoped-attempt-group',
      rootMessageId: root.id,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'alpha round' },
        { memberId: agent.id, target, payloadSnapshot: 'scoped round' },
      ],
    });
    const scopedDelivery = group.deliveries[1]!;
    const run = store.postMessage('eng', {
      author: agent.id, author_target: target, kind: 'run', body: '',
      run: {
        status: 'running', started_ts: '2026-08-06T00:45:00.000Z', tool_calls: 0,
        events_ref: `runs/${String(root.id)}.jsonl`,
      },
    });
    store.updateDelivery('eng', scopedDelivery.id, {
      state: 'delivering', run_msg_id: run.id, attempt_count: 1,
    });
    // The durable target goes stale after the attempt started.
    store.unregisterWorktree('eng', target.worktree_id, '2026-08-06T00:46:00.000Z');

    const reason = 'registered target child:@legacy-agent is no longer valid';
    const settled = store.settleInvalidScopedAttempt('eng', {
      deliveryIds: [scopedDelivery.id],
      reason,
      settledTs: '2026-08-06T00:47:00.000Z',
    });
    expect(settled.settled).toBe(true);
    expect(settled.deliveries[0]?.state).toBe('consumed');
    // The binding is preserved as evidence even after consumption.
    expect(store.getDelivery('eng', scopedDelivery.id)?.run_msg_id).toBe(run.id);
    expect(settled.runs).toHaveLength(1);
    expect(store.getMessage('eng', run.id)?.run?.status).toBe('interrupted');
    expect(settled.participants).toHaveLength(1);
    expect(settled.participants[0]).toMatchObject({
      group_id: 'scoped-attempt-group',
      member_id: agent.id,
      terminal_status: 'interrupted',
    });
    expect(settled.refusal).toMatchObject({ kind: 'system', body: `qualified target refused: ${reason}` });

    // A repeated settle is a truthful no-op: no duplicate refusal, no reopened
    // run, no resurrected delivery.
    const repeat = store.settleInvalidScopedAttempt('eng', {
      deliveryIds: [scopedDelivery.id],
      reason,
      settledTs: '2026-08-06T00:48:00.000Z',
    });
    expect(repeat.settled).toBe(false);
    expect(repeat.refusal).toBeUndefined();
    expect(store.listMessages('eng').filter((message) =>
      message.kind === 'system' && message.body.includes('qualified target refused'))).toHaveLength(1);
    expect(store.getCollaborationRound('eng', 'scoped-attempt-group', 1)?.state).toBe('collecting');
  });
});
// harn:end qualified-member-target-identity-is-durable

// harn:assume cross-worktree-output-stays-in-origin ref=cross-worktree-origin-regression
describe('qualified origin storage', () => {
  it('round-trips scoped authors and deliveries while keeping transcripts room-local', () => {
    const { owner } = openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false,
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false,
    };
    const registered = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'child', 'created');
    const child = registered.worktree.conversation_id;
    const childAgent = store.addMember(child, {
      kind: 'agent', handle: 'coder', display_name: 'Child Coder', state: 'idle',
    });
    const target = {
      worktree_id: registered.worktree.id,
      conversation_id: child,
      member_id: childAgent.id,
      alias: registered.worktree.alias,
      handle: childAgent.handle,
    } as const;
    const origin = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '~child:@coder check this',
    });
    const attributed = store.postMessage('eng', {
      author: childAgent.id, author_target: target, kind: 'chat', body: 'child answer',
    });
    const delivery = store.createDelivery('eng', {
      message_id: origin.id, recipient: childAgent.id, target,
    });
    expect(attributed.author_target).toEqual(target);
    expect(delivery.target).toEqual(target);
    expect(store.listMessages('eng').map((message) => message.body)).toEqual([
      '~child:@coder check this', 'child answer',
    ]);
    expect(store.listMessages(child)).toEqual([]);

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getMessage('eng', attributed.id)?.author_target).toEqual(target);
    expect(store.getDelivery('eng', delivery.id)?.target).toEqual(target);
    expect(store.listDeliveriesForTarget(child, childAgent.id).map((item) => item.id)).toEqual([delivery.id]);

    expect(() => store.createDelivery('eng', {
      message_id: origin.id,
      recipient: childAgent.id,
      target: { ...target, handle: 'renamed' },
    })).toThrow(/qualified delivery target is not active/);
  });
});
// harn:end cross-worktree-output-stays-in-origin

// harn:assume target-member-turns-serialize-across-origins ref=cross-origin-turn-scheduler
describe('cross-origin target queue', () => {
  it('orders qualified deliveries by one durable queue across visible origins', () => {
    const { owner } = openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false,
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false,
    };
    const registered = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'child', 'adopted');
    const child = registered.worktree.conversation_id;
    const childAgent = store.addMember(child, {
      kind: 'agent', handle: 'coder', display_name: 'Child Coder', state: 'idle',
    });
    const second = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, { ...secondary, path: join(dir, 'second'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'second') }, 'second', 'adopted');
    const secondOrigin = second.worktree.conversation_id;
    const target = {
      worktree_id: registered.worktree.id, conversation_id: child, member_id: childAgent.id,
      alias: 'child', handle: childAgent.handle,
    } as const;
    const first = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'first' });
    const secondMessage = store.postMessage(secondOrigin, { author: owner.id, kind: 'chat', body: 'second' });
    const firstDelivery = store.createDelivery('eng', {
      message_id: first.id, recipient: childAgent.id, target,
    });
    const secondDelivery = store.createDelivery(secondOrigin, {
      message_id: secondMessage.id, recipient: childAgent.id, target,
    });
    expect(store.listDeliveriesForTarget(child, childAgent.id).map((item) => item.id))
      .toEqual([firstDelivery.id, secondDelivery.id]);
    expect(store.listDeliveries('eng', { recipient: childAgent.id })).toEqual([firstDelivery]);
  });
});
// harn:end target-member-turns-serialize-across-origins

// harn:assume agent-authority-follows-one-active-invocation ref=agent-active-invocation-regression
describe('durable active invocation lookup', () => {
  it('finds one target invocation and fails closed when two origins are active', () => {
    const { owner } = openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false,
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false,
    };
    const registered = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'child', 'created');
    const child = registered.worktree.conversation_id;
    const childAgent = store.addMember(child, {
      kind: 'agent', handle: 'coder', display_name: 'Child Coder', state: 'idle',
    });
    const second = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, { ...secondary, path: join(dir, 'second'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'second') }, 'second', 'adopted');
    const secondOrigin = second.worktree.conversation_id;
    const target = {
      worktree_id: registered.worktree.id, conversation_id: child, member_id: childAgent.id,
      alias: 'child', handle: childAgent.handle,
    } as const;
    const first = store.postMessage('eng', {
      author: childAgent.id, author_target: target, kind: 'run', body: '',
      run: { status: 'running', started_ts: '2026-08-06T00:00:00.000Z', tool_calls: 0, events_ref: 'runs/1.jsonl' },
    });
    const firstDelivery = store.createDelivery('eng', {
      message_id: first.id, recipient: childAgent.id, target,
    });
    store.updateDelivery('eng', firstDelivery.id, { state: 'delivering', run_msg_id: first.id });
    expect(store.listActiveInvocations(childAgent.id)).toEqual([{
      originRoom: 'eng', targetRoom: child, target,
    }]);

    const secondRun = store.postMessage(secondOrigin, {
      author: owner.id, kind: 'run', body: '',
      run: { status: 'running', started_ts: '2026-08-06T00:00:01.000Z', tool_calls: 0, events_ref: 'runs/2.jsonl' },
    });
    const secondDelivery = store.createDelivery(secondOrigin, {
      message_id: secondRun.id, recipient: childAgent.id, target,
    });
    store.updateDelivery(secondOrigin, secondDelivery.id, { state: 'delivering', run_msg_id: secondRun.id });
    expect(store.listActiveInvocations(childAgent.id)).toHaveLength(2);
  });
});
// harn:end agent-authority-follows-one-active-invocation

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codor-store-'));
  store = new Store(join(dir, 'test.sqlite'));
});

// harn:assume agent-member-credentials-stay-secret ref=member-credential-store-regression
describe('agent member credential storage', () => {
  it('persists only a replaceable hash and never projects it as member state', () => {
    openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'credentialed', display_name: 'Credentialed', state: 'idle',
    });
    const firstHash = 'a'.repeat(64);
    const secondHash = 'b'.repeat(64);

    expect(() => store.setAgentCredentialHash('eng', agent.id, 'raw-token-must-not-land-here'))
      .toThrow('must be a SHA-256 digest');

    store.setAgentCredentialHash('eng', agent.id, firstHash);
    expect(store.findAgentByCredentialHash(firstHash)).toEqual({
      room: 'eng',
      member: agent,
    });
    expect(store.getMember('eng', agent.id)).not.toHaveProperty('credential_hash');
    expect(JSON.stringify(store.listMembers('eng'))).not.toContain(firstHash);

    store.setAgentCredentialHash('eng', agent.id, secondHash);
    expect(store.findAgentByCredentialHash(firstHash)).toBeUndefined();
    expect(store.findAgentByCredentialHash(secondHash)?.member.id).toBe(agent.id);

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.findAgentByCredentialHash(secondHash)?.member.id).toBe(agent.id);
  });

  it('never assigns a member credential to a human', () => {
    const { owner } = openRoom(store);
    expect(() => store.setAgentCredentialHash('eng', owner.id, 'c'.repeat(64)))
      .toThrow('no active agent member');
  });
});
// harn:end agent-member-credentials-stay-secret

// harn:assume live-delivery-consumption-is-idempotent ref=consumption-store-regression
describe('queued delivery consumption', () => {
  // harn:assume agent-delivery-lifecycle-streams-v2 ref=steered-delivery-storage
  it('persists steering acknowledgement and migrates a legacy delivery table', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'steered-alpha', display_name: 'Steered Alpha', state: 'running',
    });
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'adjust course' });
    const delivery = store.createDelivery('eng', { message_id: message.id, recipient: alpha.id });
    const steeredTs = '2026-07-22T03:00:00.000Z';
    expect(store.updateDelivery('eng', delivery.id, {
      state: 'consumed', steered_ts: steeredTs,
    })).toMatchObject({ state: 'consumed', steered_ts: steeredTs });

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getDelivery('eng', delivery.id)).toMatchObject({
      state: 'consumed', steered_ts: steeredTs,
    });

    store.close();
    const legacy = new Database(join(dir, 'test.sqlite'));
    legacy.exec('ALTER TABLE deliveries DROP COLUMN steered_ts');
    legacy.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getDelivery('eng', delivery.id)?.steered_ts).toBeUndefined();
  });
  // harn:end agent-delivery-lifecycle-streams-v2

  it('is recipient-bound, idempotent, and wins cleanly before turn admission', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'beta', display_name: 'Beta', state: 'idle',
    });
    const message = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@alpha take this live',
    });
    const delivery = store.createDelivery('eng', {
      message_id: message.id, recipient: alpha.id,
    });
    const selected = store.listDeliveries('eng', { recipient: alpha.id, state: 'queued' });
    expect(selected.map((item) => item.id)).toEqual([delivery.id]);

    expect(() => store.consumeQueuedDelivery('eng', delivery.id, beta.id))
      .toThrow('is not addressed to member');
    const first = store.consumeQueuedDelivery('eng', delivery.id, alpha.id);
    expect(first).toEqual({ delivery: { ...delivery, state: 'consumed' }, message });
    expect(store.consumeQueuedDelivery('eng', delivery.id, alpha.id)).toEqual(first);

    const started = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: selected.map((item) => item.id),
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    });
    expect(started).toBeUndefined();
    expect(store.listMessages('eng', { limit: 100 }).filter((item) => item.kind === 'run'))
      .toEqual([]);
  });

  it('returns a non-queued delivery unchanged when turn admission won first', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'running',
    });
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'work' });
    const delivery = store.createDelivery('eng', {
      message_id: message.id, recipient: alpha.id,
    });
    store.updateDelivery('eng', delivery.id, { state: 'delivering' });

    expect(store.consumeQueuedDelivery('eng', delivery.id, alpha.id)).toEqual({
      delivery: { ...delivery, state: 'delivering' },
      message,
    });
  });
});
// harn:end live-delivery-consumption-is-idempotent

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('room seeding', () => {
  it('creates the owner human with role owner AND the system member atomically', () => {
    const { owner, system } = openRoom(store);
    expect(owner.kind).toBe('human');
    expect(owner.role).toBe('owner');
    expect(system.kind).toBe('system');
    expect(system.handle).toBe('switchboard');
    const members = store.listMembers('eng');
    expect(members).toHaveLength(2);
  });

  // harn:assume empty-database-desk-seeds-tutorial-atomically ref=bootstrap-welcome-transaction-regression
  it('optionally persists one authored Tutorial chat without changing ordinary room seeding', () => {
    const body = 'Welcome to the Desk';
    store.createRoom({
      id: 'desk',
      name: 'Desk',
      owner: { handle: 'richard', display_name: 'Richard' },
      bootstrapWelcome: {
        author: { handle: 'tutorial', display_name: 'Tutorial' },
        body,
      },
    });

    const tutorial = store.listMembers('desk').find((member) => member.handle === 'tutorial');
    expect(tutorial).toMatchObject({ kind: 'system', display_name: 'Tutorial' });
    expect(store.listMessages('desk')).toEqual([
      expect.objectContaining({ author: tutorial!.id, kind: 'chat', body }),
    ]);

    openRoom(store);
    expect(store.listMembers('eng').map((member) => member.handle).sort())
      .toEqual(['richard', 'switchboard']);
    expect(store.listMessages('eng')).toEqual([]);
  });

  it('rolls back the room and every seeded member when welcome insertion fails', () => {
    const blocker = new Database(join(dir, 'test.sqlite'));
    blocker.exec(`CREATE TRIGGER reject_bootstrap_welcome
      BEFORE INSERT ON messages
      WHEN NEW.room = 'broken'
      BEGIN SELECT RAISE(ABORT, 'injected welcome failure'); END`);
    blocker.close();

    expect(() => store.createRoom({
      id: 'broken',
      name: 'Broken',
      owner: { handle: 'richard', display_name: 'Richard' },
      bootstrapWelcome: {
        author: { handle: 'tutorial', display_name: 'Tutorial' },
        body: 'Welcome',
      },
    })).toThrow('injected welcome failure');
    expect(store.getRoom('broken')).toBeUndefined();
    expect(store.listMembers('broken')).toEqual([]);
    expect(store.listMessages('broken')).toEqual([]);
  });
  // harn:end empty-database-desk-seeds-tutorial-atomically

  it('the system handle stays reserved: no second member can take it', () => {
    openRoom(store);
    expect(() =>
      store.addMember('eng', { kind: 'agent', handle: 'switchboard', display_name: 'X' }),
    ).toThrow();
  });

  // harn:assume default-roster-channel-members-are-detached-ordered-snapshots ref=default-roster-room-seed-regression
  it('seeds ordered concrete initial agents atomically and rolls back invalid snapshots', () => {
    const seeded = store.createRoom({
      id: 'roster', name: 'Roster', owner: { handle: 'owner', display_name: 'Owner' },
      initialAgents: [
        {
          member: {
            kind: 'agent', handle: 'first-agent', display_name: 'First Agent', harness: 'fake',
            cwd: '/work/roster', policy: 'read-only', state: 'dead', custody: 'owned',
          },
        },
        {
          member: {
            kind: 'agent', handle: 'second-agent', display_name: 'Second Agent', harness: 'acp',
            cwd: '/work/roster', state: 'dead', custody: 'owned',
          },
          runtime: { acp_launch: { executable: '/usr/bin/acp', argv: ['--stdio'] } },
        },
      ],
    });
    expect(seeded.initialAgents.map((member) => member.handle))
      .toEqual(['first-agent', 'second-agent']);
    expect(seeded.initialAgents.every((member) => member.state === 'dead')).toBe(true);
    expect(store.getAgentRuntimeConfig('roster', seeded.initialAgents[1]!.id))
      .toEqual({ acp_launch: { executable: '/usr/bin/acp', argv: ['--stdio'] } });
    expect(store.getMember('roster', seeded.initialAgents[0]!.id)).not.toHaveProperty('acp_launch');

    expect(() => store.createRoom({
      id: 'invalid-roster', name: 'Invalid roster', owner: { handle: 'owner-2', display_name: 'Owner 2' },
      initialAgents: [{
        member: {
          kind: 'agent', handle: 'switchboard', display_name: 'Invalid', harness: 'fake',
          cwd: '/work/roster', state: 'dead', custody: 'owned',
        },
      }],
    })).toThrow();
    expect(store.getRoom('invalid-roster')).toBeUndefined();
    expect(store.listMembers('invalid-roster')).toEqual([]);
  });
  // harn:end default-roster-channel-members-are-detached-ordered-snapshots
});

// harn:assume channel-archive-is-durable-soft-state ref=channel-archive-store-regression
describe('channel archive soft state', () => {
  it('renames and archives transactionally, persists across reopen, and preserves records', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'worker', display_name: 'Worker', state: 'idle',
    });
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'retained' });
    const beforeRename = store.currentSeq('eng');

    expect(store.renameRoom('eng', 'Renamed')).toMatchObject({ name: 'Renamed' });
    expect(store.currentSeq('eng')).toBe(beforeRename + 1);
    expect(store.getChangesSince('eng', beforeRename)).toEqual([{
      room: 'eng', seq: beforeRename + 1, entity: 'room', entity_id: 'eng',
    }]);

    const beforeArchive = store.currentSeq('eng');
    const archived = store.archiveRoom('eng');
    expect(archived.config.archived_ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(store.currentSeq('eng')).toBe(beforeArchive + 1);
    expect(store.getChangesSince('eng', beforeArchive)).toEqual([{
      room: 'eng', seq: beforeArchive + 1, entity: 'room', entity_id: 'eng',
    }]);
    expect(store.getMember('eng', agent.id)).toBeDefined();
    expect(store.getMessage('eng', message.id)?.body).toBe('retained');
    expect(store.listRooms()).toHaveLength(1);
    expect(() => store.renameRoom('eng', 'Nope')).toThrow('cannot be renamed');
    expect(() => store.archiveRoom('eng')).toThrow('already archived');
    expect(() => store.updateRoomConfig('eng', { archived_ts: undefined })).toThrow('immutable');
    expect(store.getRoom('eng')?.config.archived_ts).toBe(archived.config.archived_ts);

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getRoom('eng')).toMatchObject({
      name: 'Renamed', config: { archived_ts: archived.config.archived_ts },
    });
    expect(store.getMember('eng', agent.id)).toBeDefined();
    expect(store.getMessage('eng', message.id)?.body).toBe('retained');
  });
});
// harn:end channel-archive-is-durable-soft-state

describe('ack and active member lifecycle storage', () => {
  it('roundtrips ack evidence and keeps removed identities outside active lookups', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Coder', purpose: 'Implements', state: 'dead',
    });
    const acknowledgement = store.postMessage('eng', {
      author: agent.id, kind: 'run', body: '<ACK_OK>', ack: true,
      run: { status: 'completed', started_ts: new Date().toISOString(), tool_calls: 0, events_ref: 'runs/1.jsonl' },
    });
    expect(store.getMessage('eng', acknowledgement.id)?.ack).toBe(true);
    expect(store.getMessage('eng', store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: 'plain',
    }).id)?.ack).toBeUndefined();

    const removed = store.updateMember('eng', agent.id, { removed_ts: new Date().toISOString() });
    expect(store.getMember('eng', agent.id)?.removed_ts).toBe(removed.removed_ts);
    expect(store.getMemberByHandle('eng', 'coder')).toBeUndefined();
    expect(store.listMembers('eng').some((member) => member.id === agent.id)).toBe(false);
    expect(store.listMembers('eng', { includeRemoved: true }).some((member) => member.id === agent.id))
      .toBe(true);
    expect(store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Replacement', state: 'idle',
    }).id).not.toBe(agent.id);
  });

  it('migrates legacy global handle uniqueness to active-only uniqueness', () => {
    store.close();
    const path = join(dir, 'legacy.sqlite');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_ts TEXT NOT NULL, config TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE members (
        id TEXT PRIMARY KEY, room TEXT NOT NULL REFERENCES rooms(id), kind TEXT NOT NULL,
        handle TEXT NOT NULL, display_name TEXT NOT NULL, harness TEXT, session_ref TEXT,
        cwd TEXT, policy TEXT, host TEXT, state TEXT, custody TEXT, parent TEXT, role TEXT,
        conventions_sent INTEGER NOT NULL DEFAULT 0, misaddressed INTEGER NOT NULL DEFAULT 0,
        UNIQUE (room, handle)
      );
      CREATE TABLE messages (
        room TEXT NOT NULL REFERENCES rooms(id), id INTEGER NOT NULL, author TEXT NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, mentions TEXT NOT NULL, refs TEXT NOT NULL,
        ledger_refs TEXT NOT NULL, reply_to INTEGER, run TEXT, ask TEXT, origin TEXT,
        ts TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (room, id)
      );
      INSERT INTO rooms VALUES ('eng', 'Engineering', '2026-07-11T00:00:00.000Z', '{}', 0);
      INSERT INTO members (id, room, kind, handle, display_name, state)
      VALUES ('01J00000000000000000000000', 'eng', 'agent', 'coder', 'Coder', 'dead');
    `);
    legacy.close();
    store = new Store(path);
    const old = store.getMember('eng', '01J00000000000000000000000')!;
    expect(old.roster_stale).toBe(true);
    store.updateMember('eng', old.id, { removed_ts: new Date().toISOString() });
    expect(store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Replacement', state: 'idle',
    })).toBeDefined();
  });
});

describe('message id allocation', () => {
  it('allocates dense monotonic per-room ids starting at 1', () => {
    const { owner } = openRoom(store);
    const first = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'one' });
    const second = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'two' });
    const third = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'three' });
    expect([first.id, second.id, third.id]).toEqual([1, 2, 3]);
  });

  it('ids are per-room: a second room starts at 1 again', () => {
    const { owner } = openRoom(store);
    store.createRoom({ id: 'ops', name: 'Ops', owner: { handle: 'richard', display_name: 'R' } });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'eng msg' });
    const opsOwner = store.listMembers('ops').find((m) => m.kind === 'human')!;
    expect(store.postMessage('ops', { author: opsOwner.id, kind: 'chat', body: 'ops msg' }).id).toBe(1);
  });
});

// harn:assume voice-message-metadata-is-bounded-and-additive ref=voice-message-storage-regression
describe('voice message metadata storage', () => {
  it('persists and hydrates voice metadata verbatim, absent by default', () => {
    const { owner } = openRoom(store);
    const plain = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'typed message' });
    expect(store.getMessage('eng', plain.id)?.voice).toBeUndefined();

    const voice = { duration_seconds: 4.5, levels: [0, 33, 66, 100] };
    const dictated = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'dictated words', voice });
    expect(dictated.voice).toEqual(voice);

    store.close(); // read back from disk, not memory
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getMessage('eng', dictated.id)?.voice).toEqual(voice);
    expect(store.getMessage('eng', plain.id)?.voice).toBeUndefined();
  });

  it('additively re-adds the voice column to a pre-existing database', () => {
    const { owner } = openRoom(store);
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'before migration' });
    store.close();

    const legacy = new Database(join(dir, 'test.sqlite'));
    legacy.exec('ALTER TABLE messages DROP COLUMN voice');
    legacy.close();

    store = new Store(join(dir, 'test.sqlite')); // migration re-adds the column
    const voice = { duration_seconds: 2, levels: [10, 20] };
    const dictated = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'after migration', voice });
    expect(store.getMessage('eng', dictated.id)?.voice).toEqual(voice);
  });
});
// harn:end voice-message-metadata-is-bounded-and-additive

describe('bridge origin persistence', () => {
  it('deduplicates retries by bridge member, platform, and external id', () => {
    openRoom(store);
    const bridge = store.addMember('eng', {
      kind: 'bridge',
      handle: 'slack-bridge',
      display_name: 'Slack · C123',
    });
    const origin = { platform: 'slack', external_id: '171.42', sender_name: 'Sarah' };
    const first = store.postBridgeMessage('eng', bridge.id, 'Ship it', origin, {
      mentions: [], refs: [], ledger_refs: [],
    });
    const retry = store.postBridgeMessage('eng', bridge.id, 'Ship it again', origin, {
      mentions: [], refs: [], ledger_refs: [],
    });

    expect(first.deduped).toBe(false);
    expect(retry.deduped).toBe(true);
    expect(retry.message.id).toBe(first.message.id);
    expect(retry.message.body).toBe('Ship it');
    expect(store.listMessagesAfter('eng', 0)).toHaveLength(1);
  });

  it('rejects non-bridge authors and keeps distinct external ids', () => {
    const { owner } = openRoom(store);
    const origin = { platform: 'telegram', external_id: '7', sender_name: 'Lea' };
    expect(() => store.postBridgeMessage('eng', owner.id, 'No', origin, {
      mentions: [], refs: [], ledger_refs: [],
    })).toThrow('no such bridge member');
    const bridge = store.addMember('eng', {
      kind: 'bridge', handle: 'telegram-bridge', display_name: 'Telegram · 42',
    });
    store.postBridgeMessage('eng', bridge.id, 'One', origin, {
      mentions: [], refs: [], ledger_refs: [],
    });
    store.postBridgeMessage('eng', bridge.id, 'Two', { ...origin, external_id: '8' }, {
      mentions: [], refs: [], ledger_refs: [],
    });
    expect(store.listMessagesAfter('eng', 0).map((message) => message.body)).toEqual(['One', 'Two']);
  });
});

describe('message history and search', () => {
  it('pages older messages by permanent room-local id in timeline order', () => {
    const { owner } = openRoom(store);
    for (let id = 1; id <= 7; id++) {
      store.postMessage('eng', { author: owner.id, kind: 'chat', body: `message ${id}` });
    }

    expect(store.listMessages('eng', { limit: 3 }).map((item) => item.id)).toEqual([5, 6, 7]);
    expect(store.listMessages('eng', { before: 5, limit: 3 }).map((item) => item.id)).toEqual([
      2, 3, 4,
    ]);
  });

  // harn:assume run-evidence-search-is-bounded-and-redacted ref=run-list-bound-regression
  it('selects newest runs directly despite newer chat volume and filters by author', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'beta', display_name: 'Beta', state: 'idle',
    });
    const run = (author: string, label: string) => store.postMessage('eng', {
      author,
      kind: 'run',
      body: label,
      run: {
        status: 'completed', started_ts: '2026-07-10T07:00:00.000Z',
        ended_ts: '2026-07-10T07:01:00.000Z', tool_calls: 0,
        events_ref: `runs/${label}.jsonl`, final_text: label,
      },
    });
    const first = run(alpha.id, 'alpha-old');
    const middle = run(beta.id, 'beta');
    const newest = run(alpha.id, 'alpha-new');
    for (let index = 0; index < 20; index++) {
      store.postMessage('eng', { author: owner.id, kind: 'chat', body: `newer chat ${index}` });
    }

    expect(store.listRunMessages('eng', { limit: 2 }).map((item) => item.id))
      .toEqual([newest.id, middle.id]);
    expect(store.listRunMessages('eng', { author: alpha.id, limit: 2 }).map((item) => item.id))
      .toEqual([newest.id, first.id]);
  });
  // harn:end run-evidence-search-is-bounded-and-redacted

  // harn:assume member-status-is-bounded-and-identity-safe ref=status-store-regression
  it('selects only newest chat actions for one author inside the run time window', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'running',
    });
    store.postMessage('eng', { author: alpha.id, kind: 'chat', body: 'alpha one' });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'owner noise' });
    store.postMessage('eng', { author: alpha.id, kind: 'run', body: '' });
    store.postMessage('eng', { author: alpha.id, kind: 'chat', body: 'alpha two' });
    store.postMessage('eng', { author: alpha.id, kind: 'chat', body: 'alpha three' });

    expect(store.listChatMessagesByAuthorWithin(
      'eng', alpha.id, '2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z', 2,
    ).map((item) => item.body)).toEqual(['alpha three', 'alpha two']);
    expect(store.listChatMessagesByAuthorWithin(
      'eng', alpha.id, '2100-01-01T00:00:00.000Z', undefined, 5,
    )).toEqual([]);
  });
  // harn:end member-status-is-bounded-and-identity-safe

  it('searches only the selected room and treats LIKE wildcards literally', () => {
    const { owner } = openRoom(store);
    const ops = store.createRoom({
      id: 'ops',
      name: 'Ops',
      owner: { handle: 'richard', display_name: 'Richard' },
    });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'Alpha 100% ready' });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'alpha wildcard_ literal' });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'unrelated' });
    store.postMessage('ops', { author: ops.owner.id, kind: 'chat', body: 'alpha in another room' });

    expect(store.searchMessages('eng', 'ALPHA').map((item) => item.id)).toEqual([2, 1]);
    expect(store.searchMessages('eng', '100%').map((item) => item.body)).toEqual([
      'Alpha 100% ready',
    ]);
    expect(store.searchMessages('eng', 'wildcard_').map((item) => item.body)).toEqual([
      'alpha wildcard_ literal',
    ]);
  });

  it('matches projected bodies while redaction is enabled and raw bodies only after opt-out', () => {
    const { owner } = openRoom(store);
    store.postMessage('eng', {
      author: owner.id,
      kind: 'chat',
      body: 'token sk-proj-abcdef1234567890abcdef',
    });

    expect(store.searchMessages('eng', 'sk-proj-abcdef')).toEqual([]);
    expect(store.searchMessages('eng', '[redacted]').map((item) => item.id)).toEqual([1]);
    store.updateRoomConfig('eng', { redaction_enabled: false });
    expect(store.searchMessages('eng', 'sk-proj-abcdef').map((item) => item.id)).toEqual([1]);
  });
});

describe('change log completeness', () => {
  it('every entity-type mutation appends exactly one row with monotonic seq', () => {
    const { owner } = openRoom(store);
    const baseline = store.currentSeq('eng');

    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'hi' }); // message
    store.updateMember('eng', owner.id, { display_name: 'Rich' }); // member
    store.createDelivery('eng', { message_id: message.id, recipient: owner.id, state: 'consumed' }); // inbox (human)
    store.bumpMeter('eng', '2026-07-10', { turns: 1, cost_usd: 0.19 }); // meter
    store.updateRoomConfig('eng', { turn_brake: 5 }); // room

    const changes = store.getChangesSince('eng', baseline);
    expect(changes.map((c) => c.entity)).toEqual(['message', 'member', 'inbox', 'meter', 'room']);
    const seqs = changes.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('room creation itself is logged (room + two seeded members)', () => {
    openRoom(store);
    expect(store.getChangesSince('eng', 0).map((c) => c.entity)).toEqual([
      'room',
      'member',
      'member',
    ]);
  });

  it('in-place run finalization appends a message change (same id, new seq)', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const run = store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: '',
      run: { status: 'running', started_ts: new Date().toISOString(), tool_calls: 0, events_ref: 'runs/x.jsonl' },
    });
    const before = store.currentSeq('eng');
    const finalized = store.updateMessage('eng', run.id, {
      body: 'done @richard',
      run: { ...run.run!, status: 'completed', final_text: 'done @richard' },
    });
    expect(finalized.id).toBe(run.id);
    expect(finalized.seq).toBeGreaterThan(before);
    const changes = store.getChangesSince('eng', before);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.entity).toBe('message');
    expect(changes[0]!.entity_id).toBe(String(run.id));
    expect(owner.id).toBeTruthy();
  });

  it('agent deliveries do NOT pollute the client-visible inbox log', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@coder hi' });
    const before = store.currentSeq('eng');
    store.createDelivery('eng', { message_id: message.id, recipient: agent.id });
    expect(store.getChangesSince('eng', before)).toHaveLength(0);
  });

  it('sync hydrates exactly the entities the log names since the cursor', () => {
    const { owner } = openRoom(store);
    const cursor = store.currentSeq('eng');
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'hi' });
    store.bumpMeter('eng', '2026-07-10', { turns: 1 });
    const result = store.sync('eng', cursor);
    expect(result.messages.map((m) => m.id)).toEqual([message.id]);
    expect(result.meters).toHaveLength(1);
    expect(result.members).toHaveLength(0); // unchanged since cursor
    expect(result.seq).toBe(store.currentSeq('eng'));
  });
});

// harn:assume changelog-covers-every-visible-entity-v2 ref=schedule-change-accounting-regression
// harn:assume scheduled-state-streams-through-room-seq-v2 ref=schedule-sync-regression-v2
describe('scheduled change accounting and ordered commit recovery', () => {
  it('persists a qualified schedule author scope and copies it onto the committed message', () => {
    const { owner } = openRoom(store);
    const target = store.addMember('eng', {
      kind: 'agent', handle: 'scoped-target', display_name: 'Scoped Target', harness: 'fake', cwd: dir,
    });
    const authorTarget = {
      worktree_id: '01J00000000000000000000000',
      conversation_id: 'eng',
      member_id: owner.id,
      alias: 'feature-a',
      handle: owner.handle,
    };
    const schedule = store.createSchedule({
      room: 'eng', author_id: owner.id, author_handle: owner.handle, author_target: authorTarget,
      target: { member_id: target.id, conversation_id: 'eng', handle: target.handle },
      body: '@scoped-target ship it', mentions: [{ member_id: target.id, start: 0, end: 14 }],
      due_ts: '2026-08-13T00:00:00.000Z', host_offset_minutes: 480,
    }, '2026-08-12T00:00:00.000Z');
    expect(store.getSchedule('eng', schedule.id)?.author_target).toEqual(authorTarget);
    store.claimDueSchedules('2026-08-13T00:00:00.000Z');
    const committed = store.commitScheduledMessage('eng', schedule.id, {
      now: '2026-08-13T00:00:00.000Z',
      message: {
        author: owner.id, author_target: authorTarget, kind: 'chat', body: '@scoped-target ship it',
        mentions: schedule.mentions,
      },
      plan: () => ({ fanout: [{ recipient: target.id, state: 'queued' }] }),
    });
    expect(committed.message?.author_target).toEqual(authorTarget);
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getSchedule('eng', schedule.id)?.author_target).toEqual(authorTarget);
    expect(store.getMessage('eng', committed.message!.id)?.author_target).toEqual(authorTarget);
  });

  it('retains producing seqs, orders atomic effects, and commits exactly once', () => {
    const { owner } = openRoom(store);
    const target = store.addMember('eng', {
      kind: 'agent', handle: 'sol', display_name: 'Sol', harness: 'fake', cwd: dir,
    });
    const schedule = store.createSchedule({
      room: 'eng', author_id: owner.id, author_handle: owner.handle,
      target: { member_id: target.id, conversation_id: 'eng', handle: target.handle },
      body: '@sol ship it', mentions: [{ member_id: target.id, start: 0, end: 4 }],
      due_ts: '2026-08-13T00:00:00.000Z', host_offset_minutes: 480,
    }, '2026-08-12T00:00:00.000Z');
    const createChange = store.getChangesSince('eng', 0).at(-1)!;
    expect(createChange).toMatchObject({ entity: 'schedule', entity_id: schedule.id });
    expect(store.scheduleChangeSeq('eng', schedule.id)).toBe(createChange.seq);

    store.claimDueSchedules('2026-08-13T00:00:00.000Z');
    const claimChange = store.getChangesSince('eng', createChange.seq).at(-1)!;
    expect(claimChange).toMatchObject({ entity: 'schedule', entity_id: schedule.id });

    const committed = store.commitScheduledMessage('eng', schedule.id, {
      now: '2026-08-13T00:00:00.000Z',
      message: { author: owner.id, kind: 'chat', body: '@sol ship it', mentions: schedule.mentions },
      plan: () => ({ fanout: [{ recipient: target.id, state: 'queued' }] }),
    });
    expect(committed.effects.map((effect) => effect.entity)).toEqual(['message', 'schedule']);
    expect(committed.effects.map((effect) => effect.seq)).toEqual(
      [...committed.effects].sort((a, b) => a.seq - b.seq).map((effect) => effect.seq),
    );
    expect(committed.message?.seq).toBe(committed.effects[0]!.seq);
    expect(store.listDeliveries('eng')).toHaveLength(1);

    const replay = store.commitScheduledMessage('eng', schedule.id, {
      now: '2026-08-13T00:00:01.000Z',
      message: { author: owner.id, kind: 'chat', body: '@sol ship it', mentions: schedule.mentions },
      plan: () => ({ fanout: [{ recipient: target.id, state: 'queued' }] }),
    });
    expect(replay.effects).toEqual([]);
    expect(replay.message?.id).toBe(committed.message?.id);
    expect(store.listMessages('eng', { limit: 100 })).toHaveLength(1);
    expect(store.listDeliveries('eng')).toHaveLength(1);
  });

  it('rolls back a failed plan, persists a failed state, and does not log terminal no-ops', () => {
    const { owner } = openRoom(store);
    const target = store.addMember('eng', {
      kind: 'agent', handle: 'sol', display_name: 'Sol', harness: 'fake', cwd: dir,
    });
    const schedule = store.createSchedule({
      room: 'eng', author_id: owner.id, author_handle: owner.handle,
      target: { member_id: target.id, conversation_id: 'eng', handle: target.handle },
      body: '@sol fail', mentions: [{ member_id: target.id, start: 0, end: 4 }],
      due_ts: '2026-08-13T00:00:00.000Z', host_offset_minutes: 480,
    }, '2026-08-12T00:00:00.000Z');
    store.claimDueSchedules('2026-08-13T00:00:00.000Z');
    expect(() => store.commitScheduledMessage('eng', schedule.id, {
      message: { author: owner.id, kind: 'chat', body: '@sol fail', mentions: schedule.mentions },
      plan: () => { throw new Error('injected plan failure'); },
    })).toThrow('injected plan failure');
    expect(store.getSchedule('eng', schedule.id)?.state).toBe('sending');
    expect(store.listMessages('eng', { limit: 100 })).toEqual([]);
    const failed = store.failSchedule('eng', schedule.id, 'injected plan failure', '2026-08-13T00:00:01.000Z');
    const failedSeq = store.scheduleChangeSeq('eng', schedule.id)!;
    expect(failed.state).toBe('failed');
    expect(store.failSchedule('eng', schedule.id, 'ignored', '2026-08-13T00:00:02.000Z')).toEqual(failed);
    expect(store.scheduleChangeSeq('eng', schedule.id)).toBe(failedSeq);
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getSchedule('eng', schedule.id)).toMatchObject({ state: 'failed', error: 'injected plan failure' });
  });
});

describe('persistence across reopen', () => {
  it('interaction state machine rows survive a store reopen', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const card = store.postMessage('eng', {
      author: agent.id,
      kind: 'ask',
      body: 'Which codeword?',
      ask: { interaction_id: 'int-1', kind: 'ask', prompt: 'Which codeword?' },
    });
    store.upsertInteraction({
      id: 'int-1',
      room: 'eng',
      member_id: agent.id,
      message_id: card.id,
      native_id: 'toolu_abc',
      kind: 'ask',
      targets: [owner.id],
      state: 'answered',
      answer: { 'Which codeword?': 'ALPHA' },
      answered_by: owner.id,
      answered_ts: new Date().toISOString(),
    });
    store.close();

    store = new Store(join(dir, 'test.sqlite'));
    const revived = store.getInteraction('int-1')!;
    expect(revived.state).toBe('answered');
    expect(revived.answer).toEqual({ 'Which codeword?': 'ALPHA' });
    expect(revived.targets).toEqual([owner.id]);
    expect(store.listInteractions('eng', 'answered')).toHaveLength(1);
  });

  it('member cwd/policy/session_ref roundtrip across reopen (revive contract)', () => {
    openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent',
      handle: 'coder',
      display_name: 'Coder',
      harness: 'codex',
      session_ref: '019f4ae0-8022-7a92-b81a-60e25f3f1c22',
      cwd: '/home/user/project',
      policy: 'workspace-write',
      state: 'idle',
      custody: 'mirrored',
    });
    store.close();

    store = new Store(join(dir, 'test.sqlite'));
    const revived = store.getMember('eng', agent.id)!;
    expect(revived.cwd).toBe('/home/user/project');
    expect(revived.policy).toBe('workspace-write');
    expect(revived.session_ref).toBe('019f4ae0-8022-7a92-b81a-60e25f3f1c22');
    expect(revived.custody).toBe('mirrored');
    expect(
      store.findMemberBySessionRef('codex', '019f4ae0-8022-7a92-b81a-60e25f3f1c22'),
    ).toMatchObject({ room: 'eng', member: { id: agent.id } });
  });

  it('persists native mirrored-turn dedupe keys without storing event payloads', () => {
    openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent',
      handle: 'planner',
      display_name: 'Planner',
      harness: 'claude-code',
      session_ref: 'session-1',
      custody: 'mirrored',
    });
    const message = store.postMessage('eng', { author: agent.id, kind: 'run', body: 'done' });
    store.recordMirroredTurn('eng', agent.id, 'native-turn-1', message.id);
    store.close();

    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getMirroredMessageId('eng', agent.id, 'native-turn-1')).toBe(message.id);
    expect(() =>
      store.recordMirroredTurn('eng', agent.id, 'native-turn-1', message.id),
    ).toThrow();
  });

  it('persists the attach CLI and native child process lease across reopen', () => {
    openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent',
      handle: 'coder',
      display_name: 'Coder',
      harness: 'codex',
      session_ref: 'session-attach-1',
      cwd: '/work',
      state: 'idle',
      custody: 'mirrored',
    });
    const lease = store.createAttachLease({
      room: 'eng',
      member_id: agent.id,
      cli_pid: 123,
      heartbeat_ts: 1000,
    });
    store.setAttachLeaseChild(lease.id, 456, 456, 1100);
    store.close();

    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getAttachLeaseForMember(agent.id)).toEqual({
      id: lease.id,
      room: 'eng',
      member_id: agent.id,
      cli_pid: 123,
      child_pid: 456,
      process_group_id: 456,
      heartbeat_ts: 1100,
    });
    store.heartbeatAttachLease(lease.id, 1200);
    expect(store.listAttachLeases()).toEqual([
      expect.objectContaining({ id: lease.id, heartbeat_ts: 1200 }),
    ]);
    store.deleteAttachLease(lease.id);
    expect(store.getAttachLease(lease.id)).toBeUndefined();
  });
});

describe('mentions and refs', () => {
  it('mentions roundtrip as resolved member-id spans', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const spans = [{ member_id: agent.id, start: 0, end: 6 }];
    const message = store.postMessage('eng', {
      author: owner.id,
      kind: 'chat',
      body: '@coder start on #3',
      mentions: spans,
      refs: [3],
    });
    const reread = store.getMessage('eng', message.id)!;
    expect(reread.mentions).toEqual(spans);
    expect(reread.refs).toEqual([3]);
  });
});

describe('run blobs stay off the DB', () => {
  it('a finalized run message persists only the events_ref pointer', () => {
    openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const run = store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: 'done',
      run: {
        status: 'completed',
        started_ts: new Date().toISOString(),
        tool_calls: 2,
        usage: { input_tokens: 100, output_tokens: 10 },
        events_ref: 'runs/1.jsonl',
        final_text: 'done',
      },
    });
    const reread = store.getMessage('eng', run.id)!;
    expect(reread.run!.events_ref).toBe('runs/1.jsonl');
    expect(reread.run).not.toHaveProperty('events');
  });
});

describe('deliveries (attempt WAL columns)', () => {
  it('binds run_msg_id in delivering state and roundtrips read_ts', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@coder hi' });
    const delivery = store.createDelivery('eng', {
      message_id: message.id,
      recipient: agent.id,
      hop_count: 4,
    });
    expect(delivery.state).toBe('queued');
    expect(delivery.attempt_count).toBe(0);
    expect(store.getDelivery('eng', delivery.id)!.hop_count).toBe(4);

    const inflight = store.updateDelivery('eng', delivery.id, {
      state: 'delivering',
      attempt_count: 1,
      run_msg_id: 99,
      batch_id: 'batch-1',
    });
    expect(inflight.run_msg_id).toBe(99);

    const held = store.updateDelivery('eng', delivery.id, { state: 'held' });
    expect(held.state).toBe('held');

    const inbox = store.createDelivery('eng', {
      message_id: message.id,
      recipient: owner.id,
      state: 'consumed',
    });
    const read = store.updateDelivery('eng', inbox.id, { read_ts: new Date().toISOString() });
    expect(read.read_ts).toBeDefined();
  });

  it('persists immutable routed payload context with an agent delivery', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@coder hi' });
    const delivery = store.createDelivery('eng', {
      message_id: message.id,
      recipient: agent.id,
      payload_snapshot: '{"pinned":true}',
    });
    expect(store.getDeliveryPayloadSnapshot('eng', delivery.id)).toBe('{"pinned":true}');
  });
});

// harn:assume estimated-cost-is-advisory-not-spend-brake-input ref=advisory-accounting-regression
describe('usage meters', () => {
  it('keeps exact, estimated, and unpriced usage in separate buckets', () => {
    openRoom(store);
    store.bumpMeter('eng', '2026-07-10', {
      turns: 1,
      cost_usd: 0.25,
      input_tokens: 100,
      output_tokens: 20,
    });
    const meter = store.bumpMeter('eng', '2026-07-10', {
      turns: 2,
      estimated_cost_usd: 0.4,
      input_tokens: 40,
      output_tokens: 10,
      uncosted_tokens: 50,
    });
    expect(meter).toMatchObject({
      turns: 3,
      cost_usd: 0.25,
      estimated_cost_usd: 0.4,
      input_tokens: 140,
      output_tokens: 30,
      uncosted_tokens: 50,
    });
  });

  it('migrates an existing meter table without inventing historical estimates', () => {
    openRoom(store);
    store.bumpMeter('eng', '2026-07-10', { turns: 1, input_tokens: 20, uncosted_tokens: 20 });
    const path = join(dir, 'test.sqlite');
    store.close();

    const legacy = new Database(path);
    legacy.exec('ALTER TABLE meters DROP COLUMN estimated_cost_usd');
    legacy.close();

    store = new Store(path);
    expect(store.getMeter('eng', '2026-07-10')).toMatchObject({
      turns: 1,
      estimated_cost_usd: 0,
      input_tokens: 20,
      uncosted_tokens: 20,
    });
  });
});
// harn:end estimated-cost-is-advisory-not-spend-brake-input

// harn:assume legacy-codex-repricing-is-atomic-and-idempotent ref=legacy-codex-repricing-regression
describe('legacy Codex pricing migration', () => {
  const postRun = (
    author: string,
    id: string,
    usage: { input_tokens: number; output_tokens: number; cost_usd?: number },
    model?: string,
  ) => store.postMessage('eng', {
    author,
    kind: 'run',
    body: id,
    run: {
      status: 'completed',
      started_ts: '2026-07-22T10:00:00.000Z',
      ended_ts: '2026-07-22T10:01:00.000Z',
      tool_calls: 0,
      usage,
      events_ref: `runs/${id}.jsonl`,
      final_text: id,
      ...(model !== undefined && { model }),
    },
  });

  it('resolves legacy evidence in order, rebuilds mixed meters, and is restart-idempotent', () => {
    openRoom(store);
    const runModel = store.addMember('eng', {
      kind: 'agent', handle: 'run-model', display_name: 'Run Model', harness: 'codex',
      model: 'gpt-5.6-terra', cwd: '/work', state: 'idle',
    });
    const journalModel = store.addMember('eng', {
      kind: 'agent', handle: 'journal-model', display_name: 'Journal Model', harness: 'codex',
      session_ref: 'session-journal', model: 'gpt-5.6-terra', cwd: '/work', state: 'idle',
    });
    const memberModel = store.addMember('eng', {
      kind: 'agent', handle: 'member-model', display_name: 'Member Model', harness: 'codex',
      model: 'gpt-5.6-terra', cwd: '/work', state: 'idle',
    });
    const fallback = store.addMember('eng', {
      kind: 'agent', handle: 'fallback', display_name: 'Fallback', harness: 'codex',
      cwd: '/work', state: 'idle',
    });
    const first = postRun(
      runModel.id, 'run-model', { input_tokens: 1_000_000, output_tokens: 0 }, 'gpt-5.6-luna',
    );
    const second = postRun(
      journalModel.id, 'journal-model', { input_tokens: 1_000_000, output_tokens: 0 },
    );
    const third = postRun(
      memberModel.id, 'member-model', { input_tokens: 1_000_000, output_tokens: 0 },
    );
    const fourth = postRun(
      fallback.id, 'fallback', { input_tokens: 1_000_000, output_tokens: 0 },
    );
    const exact = postRun(runModel.id, 'exact', {
      input_tokens: 1, output_tokens: 1, cost_usd: 7.25,
    });
    store.bumpMeter('eng', '2026-07-22', {
      turns: 99, cost_usd: 99, estimated_cost_usd: 99,
      input_tokens: 99, output_tokens: 99, uncosted_tokens: 99,
    });

    const codexHome = join(dir, 'codex-home');
    const journalDir = join(codexHome, 'sessions', '2026', '07', '22');
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(join(journalDir, 'rollout-2026-07-22-session-journal.jsonl'), `${JSON.stringify({
      timestamp: '2026-07-22T09:59:00.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.5' },
    })}\n`);

    const path = join(dir, 'test.sqlite');
    store.close();
    const legacy = new Database(path);
    legacy.prepare("DELETE FROM codor_migrations WHERE id = 'codex-usage-pricing-v1'").run();
    legacy.close();

    store = new Store(path, { codexHome });
    expect(store.getMessage('eng', first.id)?.run).toMatchObject({
      model: 'gpt-5.6-luna', estimated_cost_usd: 2,
    });
    expect(store.getMessage('eng', second.id)?.run).toMatchObject({
      model: 'gpt-5.5', estimated_cost_usd: 10,
    });
    expect(store.getMessage('eng', third.id)?.run).toMatchObject({
      model: 'gpt-5.6-terra', estimated_cost_usd: 5,
    });
    expect(store.getMessage('eng', fourth.id)?.run).toMatchObject({
      model: 'gpt-5.6-sol', estimated_cost_usd: 10,
    });
    expect(store.getMessage('eng', exact.id)?.run).toMatchObject({
      usage: { cost_usd: 7.25 },
    });
    expect(store.getMessage('eng', exact.id)?.run?.estimated_cost_usd).toBeUndefined();
    expect(store.getMeter('eng', '2026-07-22')).toMatchObject({
      turns: 5,
      cost_usd: 7.25,
      estimated_cost_usd: 27,
      input_tokens: 4_000_001,
      output_tokens: 1,
      uncosted_tokens: 0,
    });

    const snapshot = store.getMeter('eng', '2026-07-22');
    store.close();
    store = new Store(path, { codexHome });
    expect(store.getMeter('eng', '2026-07-22')).toEqual(snapshot);
    const readonly = new Database(path, { readonly: true });
    expect(readonly.prepare(
      "SELECT COUNT(*) AS count FROM codor_migrations WHERE id = 'codex-usage-pricing-v1'",
    ).get()).toEqual({ count: 1 });
    readonly.close();
    expect(estimateCostUsd('gpt-5.6-sol', {
      input_tokens: 1_000_000, output_tokens: 0,
    })).toBe(10);
  });

  it('rolls back run updates, meter reconstruction, and marker on any failure', () => {
    const path = join(dir, 'rollback.sqlite');
    const rollbackStore = new Store(path, { codexHome: join(dir, 'empty-codex-home') });
    rollbackStore.createRoom({
      id: 'rollback', name: 'Rollback', owner: { handle: 'richard', display_name: 'Richard' },
    });
    const agent = rollbackStore.addMember('rollback', {
      kind: 'agent', handle: 'codex', display_name: 'Codex', harness: 'codex',
      model: 'gpt-5.6-sol', cwd: '/work', state: 'idle',
    });
    const makeRun = (body: string) => rollbackStore.postMessage('rollback', {
      author: agent.id, kind: 'run', body,
      run: {
        status: 'completed', started_ts: '2026-07-22T10:00:00.000Z',
        ended_ts: '2026-07-22T10:01:00.000Z', tool_calls: 0,
        usage: { input_tokens: 100, output_tokens: 10 },
        events_ref: `runs/${body}.jsonl`, final_text: body,
      },
    });
    const first = makeRun('first');
    const second = makeRun('second');
    rollbackStore.bumpMeter('rollback', '2026-07-22', { uncosted_tokens: 220 });
    rollbackStore.close();

    const blocker = new Database(path);
    blocker.prepare("DELETE FROM codor_migrations WHERE id = 'codex-usage-pricing-v1'").run();
    blocker.exec(`CREATE TRIGGER reject_second_reprice
      BEFORE UPDATE OF run ON messages
      WHEN NEW.room = 'rollback' AND NEW.id = ${second.id}
      BEGIN SELECT RAISE(ABORT, 'injected repricing failure'); END`);
    blocker.close();

    expect(() => new Store(path, { codexHome: join(dir, 'empty-codex-home') }))
      .toThrow('injected repricing failure');
    const readonly = new Database(path, { readonly: true });
    const persisted = readonly.prepare(
      'SELECT id, run FROM messages WHERE room = ? AND id IN (?, ?) ORDER BY id',
    ).all('rollback', first.id, second.id) as Array<{ id: number; run: string }>;
    expect(persisted.map((row) => JSON.parse(row.run).estimated_cost_usd)).toEqual([
      undefined, undefined,
    ]);
    expect(readonly.prepare(
      "SELECT COUNT(*) AS count FROM codor_migrations WHERE id = 'codex-usage-pricing-v1'",
    ).get()).toEqual({ count: 0 });
    expect(readonly.prepare(
      "SELECT uncosted_tokens FROM meters WHERE room = 'rollback' AND day = '2026-07-22'",
    ).get()).toEqual({ uncosted_tokens: 220 });
    readonly.close();
  });
});
// harn:end legacy-codex-repricing-is-atomic-and-idempotent

describe('atomic turn lifecycle', () => {
  it('rolls back the run placeholder and every binding when one batch delivery is invalid', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', { kind: 'agent', handle: 'coder', display_name: 'Coder' });
    const trigger = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@coder go' });
    const delivery = store.createDelivery('eng', { message_id: trigger.id, recipient: agent.id });
    const beforeMessages = store.listMessages('eng').length;

    expect(() =>
      store.beginTurn('eng', {
        memberId: agent.id,
        deliveryIds: [delivery.id, 'missing-delivery'],
        startedTs: new Date().toISOString(),
        eventsRef: (id) => `runs/${id}.jsonl`,
      }),
    ).toThrow('missing-delivery');

    expect(store.listMessages('eng')).toHaveLength(beforeMessages);
    expect(store.getDelivery('eng', delivery.id)).toMatchObject({
      state: 'queued',
      attempt_count: 0,
      run_msg_id: undefined,
    });
  });

  // harn:assume turn-output-finalization-is-atomic ref=output-finalization-regression
  it('rolls back every output row before committing output, custody, accounting, and fanout together', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent',
      handle: 'coder',
      display_name: 'Coder',
      harness: 'acp',
      state: 'running',
    }, {
      usage_baseline: { totalTokens: 20, inputTokens: 10, outputTokens: 5 },
    });
    const trigger = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@coder go' });
    const delivery = store.createDelivery('eng', { message_id: trigger.id, recipient: agent.id });
    const started = store.beginTurn('eng', {
      memberId: agent.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      model: 'gpt-5.6-luna',
      eventsRef: (id) => `runs/${id}.jsonl`,
    });
    const running = started.runMessage;
    const continuation = store.createRunContinuation('eng', running.id);
    const orphan = store.createRunContinuation('eng', running.id);
    const outputs = [
      {
        id: running.id, body: 'first stretch', mentions: [], refs: [], ledger_refs: [],
        substantive: true,
      },
      {
        id: continuation.id, body: 'second stretch', mentions: [], refs: [], ledger_refs: [],
        substantive: true,
      },
    ];
    const completedRun = {
      ...running.run!,
      status: 'completed' as const,
      ended_ts: '2026-07-18T10:01:00.000Z',
      final_text: 'first stretchsecond stretch',
      estimated_cost_usd: 0.5,
      result_message_id: continuation.id,
    };
    const nextBaseline = { totalTokens: 33, inputTokens: 16, outputTokens: 9 };
    store.stageAgentUsageBaseline('eng', agent.id, running.id, nextBaseline);

    expect(() =>
      store.completeTurn('eng', {
        runMsgId: running.id,
        message: { run: completedRun },
        outputs,
        resultMessageId: continuation.id,
        inputDeliveryIds: [delivery.id],
        memberId: agent.id,
        memberPatch: { state: 'idle' },
        meterDay: 'not-a-date',
        meterDelta: { turns: 1 },
        fanout: [{ recipient: owner.id, state: 'consumed' }],
      }),
    ).toThrow();

    expect(store.getMessage('eng', running.id)!.run!.status).toBe('running');
    expect(store.getDelivery('eng', delivery.id)!.state).toBe('delivering');
    expect(store.getMember('eng', agent.id)!.state).toBe('running');
    expect(store.listDeliveries('eng', { recipient: owner.id })).toHaveLength(0);
    expect(store.getMeter('eng', 'not-a-date')).toBeUndefined();
    expect(store.getAgentRuntimeConfig('eng', agent.id)?.usage_baseline)
      .toMatchObject({ totalTokens: 20 });
    expect(store.getMessage('eng', running.id)).toMatchObject({ body: '', run: { status: 'running' } });
    expect(store.getMessage('eng', continuation.id)).toMatchObject({ body: '', deleted: undefined });
    expect(store.getMessage('eng', orphan.id)).toMatchObject({ body: '', deleted: undefined });

    const completed = store.completeTurn('eng', {
      runMsgId: running.id,
      message: { run: completedRun },
      outputs,
      resultMessageId: continuation.id,
      inputDeliveryIds: [delivery.id],
      memberId: agent.id,
      memberPatch: { state: 'idle' },
      meterDay: '2026-07-18',
      meterDelta: { turns: 1, estimated_cost_usd: 0.5, input_tokens: 80, output_tokens: 20 },
      fanout: [{ recipient: owner.id, state: 'consumed', payload_snapshot: 'full aggregate' }],
    });

    expect(completed.outputMessages.map((message) => message.id))
      .toEqual([running.id, continuation.id, orphan.id]);
    expect(store.getMessage('eng', running.id)).toMatchObject({
      body: 'first stretch',
      run: {
        status: 'completed',
        model: 'gpt-5.6-luna',
        estimated_cost_usd: 0.5,
        final_text: 'first stretchsecond stretch',
        result_message_id: continuation.id,
      },
    });
    expect(store.getMessage('eng', continuation.id)).toMatchObject({
      body: 'second stretch', run_parent_id: running.id,
    });
    expect(store.getMessage('eng', orphan.id)).toMatchObject({ deleted: true, body: '' });
    expect(store.getDelivery('eng', delivery.id)?.state).toBe('consumed');
    expect(store.getMember('eng', agent.id)?.state).toBe('idle');
    expect(store.getAgentRuntimeConfig('eng', agent.id)?.usage_baseline).toEqual(nextBaseline);
    expect(store.db.prepare(
      'SELECT acp_usage_pending FROM members WHERE room = ? AND id = ?',
    ).get('eng', agent.id)).toEqual({ acp_usage_pending: null });
    expect(store.getMeter('eng', '2026-07-18')).toMatchObject({
      turns: 1, estimated_cost_usd: 0.5, input_tokens: 80, output_tokens: 20,
    });
    expect(store.listDeliveries('eng', { recipient: owner.id })).toEqual([
      expect.objectContaining({ message_id: continuation.id }),
    ]);
    expect(store.getDeliveryPayloadSnapshot(
      'eng',
      store.listDeliveries('eng', { recipient: owner.id })[0]!.id,
    )).toBe('full aggregate');
    expect(store.countUnreadMessages('eng', owner.id)).toBe(2);
  });
  // harn:end turn-output-finalization-is-atomic
});

// harn:assume failed-finalization-reconciles-at-runtime ref=delivery-reconciliation-regression
describe('failed finalization reconciliation transaction', () => {
  it('fails the run, holds ambiguous input, meters and explains exactly once', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'repair-alpha', display_name: 'Repair Alpha',
      harness: 'acp', state: 'running',
    }, {
      usage_baseline: { totalTokens: 20, inputTokens: 10, outputTokens: 5 },
    });
    const trigger = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@repair-alpha do the work',
    });
    const delivery = store.createDelivery('eng', {
      message_id: trigger.id, recipient: alpha.id,
    });
    const started = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: '2026-07-18T10:00:00.000Z',
      model: 'gpt-5.6-terra',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;
    store.stageAgentUsageBaseline('eng', alpha.id, started.runMessage.id, {
      totalTokens: 33, inputTokens: 16, outputTokens: 9,
    });
    store.setDeliveryAttemptProcess('eng', [delivery.id], { pid: 1234 });

    const first = store.repairFailedFinalization('eng', {
      runMsgId: started.runMessage.id,
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      error: 'finalization could not commit: injected transaction failure',
      endedTs: '2026-07-18T10:01:00.000Z',
      usage: { input_tokens: 300, output_tokens: 20 },
      estimatedCostUsd: 0.75,
      meterDay: '2026-07-18',
      meterDelta: {
        turns: 1,
        estimated_cost_usd: 0.75,
        input_tokens: 300,
        output_tokens: 20,
      },
    });

    expect(first).toMatchObject({ repaired: true, held: [delivery.id] });
    expect(first.message?.run).toMatchObject({
      status: 'failed',
      model: 'gpt-5.6-terra',
      usage: { input_tokens: 300, output_tokens: 20 },
      estimated_cost_usd: 0.75,
      error: 'finalization could not commit: injected transaction failure',
    });
    expect(first.message).toMatchObject({ body: '', mentions: [], refs: [], ledger_refs: [] });
    expect(first.member?.state).toBe('idle');
    expect(store.getAgentRuntimeConfig('eng', alpha.id)?.usage_baseline)
      .toMatchObject({ totalTokens: 33 });
    expect(first.deliveries).toEqual([
      expect.objectContaining({ id: delivery.id, state: 'held', run_msg_id: started.runMessage.id }),
    ]);
    expect(first.notice?.body).toContain('release_hold or redeliver');
    expect(store.getDeliveryAttemptProcess('eng', delivery.id)).toBeUndefined();
    expect(store.getMeter('eng', '2026-07-18')).toMatchObject({
      turns: 1, estimated_cost_usd: 0.75, input_tokens: 300, output_tokens: 20,
    });

    const beforeMessages = store.listMessages('eng', { limit: 100 }).length;
    const second = store.repairFailedFinalization('eng', {
      runMsgId: started.runMessage.id,
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      error: 'finalization could not commit: should not land',
      endedTs: '2026-07-18T10:02:00.000Z',
      meterDay: '2026-07-18',
      meterDelta: { turns: 1, input_tokens: 999 },
    });
    expect(second).toEqual({ repaired: false, deliveries: [], held: [] });
    expect(store.listMessages('eng', { limit: 100 })).toHaveLength(beforeMessages);
    expect(store.getMeter('eng', '2026-07-18')).toMatchObject({
      turns: 1, estimated_cost_usd: 0.75, input_tokens: 300, output_tokens: 20,
    });
  });

  it('treats a closed group or closed round as settled even with nonterminal participants', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'closed-alpha', display_name: 'Closed Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'closed-beta', display_name: 'Closed Beta', state: 'idle',
    });
    const seed = (groupId: string) => {
      const root = store.postMessage('eng', {
        author: owner.id,
        kind: 'chat',
        body: `@closed-alpha @closed-beta ${groupId}`,
      });
      return store.createCollaborationGroup('eng', {
        groupId,
        rootMessageId: root.id,
        participants: [
          { memberId: alpha.id, payloadSnapshot: `${groupId} alpha` },
          { memberId: beta.id, payloadSnapshot: `${groupId} beta` },
        ],
      });
    };

    const roundClosed = seed('round-closed');
    const roundDelivery = roundClosed.deliveries[0]!;
    expect(store.collaborationWorkIsSettled('eng', roundDelivery.id)).toBe(false);
    store.updateCollaborationRound('eng', roundClosed.group.id, 1, {
      state: 'closed', released_ts: '2026-07-18T10:10:00.000Z',
    });
    expect(store.findCollaborationParticipantByDelivery('eng', roundDelivery.id)?.terminal_status)
      .toBeUndefined();
    expect(store.collaborationWorkIsSettled('eng', roundDelivery.id)).toBe(true);

    const groupClosed = seed('group-closed');
    const groupDelivery = groupClosed.deliveries[0]!;
    expect(store.collaborationWorkIsSettled('eng', groupDelivery.id)).toBe(false);
    store.updateCollaborationGroup('eng', groupClosed.group.id, {
      state: 'completed', completed_ts: '2026-07-18T10:11:00.000Z',
    });
    expect(store.findCollaborationParticipantByDelivery('eng', groupDelivery.id)?.terminal_status)
      .toBeUndefined();
    expect(store.getCollaborationRound('eng', groupClosed.group.id, 1)?.state).toBe('collecting');
    expect(store.collaborationWorkIsSettled('eng', groupDelivery.id)).toBe(true);
  });
});
// harn:end failed-finalization-reconciles-at-runtime

// harn:assume every-channel-has-a-visible-accent ref=channel-accent-regression
describe('channel accents', () => {
  it('gives a channel created without a colour one derived from its id', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'codor-accent-')), 'db.sqlite'));
    // This is the F3 root cause: the CLI (and the boot-seeded unit) create channels
    // with no colour at all, so the rail had nothing to show.
    const { room } = store.createRoom({
      id: 'desk', name: 'Desk', owner: { handle: 'richard', display_name: 'Richard' },
    });
    expect(room.config.color).toBe(deriveRoomColor('desk'));
    expect(store.getRoom('desk')!.config.color).toBe(deriveRoomColor('desk'));
  });

  it('keeps the colour a creator actually chose', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'codor-accent-')), 'db.sqlite'));
    const { room } = store.createRoom({
      id: 'eng', name: 'Eng', owner: { handle: 'richard', display_name: 'Richard' },
      config: { color: '#123456' },
    });
    expect(room.config.color).toBe('#123456');
  });

  it('derives the same accent every time, so a channel does not change colour', () => {
    expect(deriveRoomColor('desk')).toBe(deriveRoomColor('desk'));
    expect(CHANNEL_ACCENTS).toContain(deriveRoomColor('anything-at-all'));
  });
});

// harn:assume durable-agent-runtime-configuration ref=durable-agent-runtime-regression
describe('a member keeps the model and thinking level it was given', () => {
  it('round-trips them through the database', () => {
    openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent',
      handle: 'alpha',
      display_name: 'alpha',
      harness: 'claude-code',
      cwd: '/tmp/work',
      policy: 'workspace-write',
      model: 'opus-4.8',
      thinking: 'high',
    });
    expect(alpha.model).toBe('opus-4.8');
    expect(alpha.thinking).toBe('high');

    // Read back through a SECOND store over the same file: the row, not the object.
    const reopened = new Store(join(dir, 'test.sqlite'));
    const read = reopened.getMember('eng', alpha.id)!;
    expect(read.model).toBe('opus-4.8');
    expect(read.thinking).toBe('high');
    reopened.close();
  });

  it('means the harness default when neither was given, rather than guessing one', () => {
    openRoom(store);
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'beta', display_name: 'beta', harness: 'fake', cwd: '/tmp/work',
    });
    expect(beta.model).toBeUndefined();
    expect(beta.thinking).toBeUndefined();
  });

  it('persists ACP launch and lifecycle privately while ordinary members omit them', () => {
    openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'alpha', harness: 'acp', cwd: '/tmp/work',
    }, {
      acp_launch: { executable: '/opt/acp-agent', argv: ['--profile', 'secret-name'] },
      lifecycle: { load: true, resume: false },
      usage_baseline: { totalTokens: 20, inputTokens: 10, outputTokens: 5 },
    });
    expect(store.getMember('eng', alpha.id)).not.toHaveProperty('acp_launch');
    expect(store.listMembers('eng')[2]).not.toHaveProperty('session_lifecycle');
    expect(store.listMembers('eng')[2]).not.toHaveProperty('acp_usage_baseline');
    expect(store.listMembers('eng')[2]).not.toHaveProperty('acp_usage_pending');
    expect(store.getAgentRuntimeConfig('eng', alpha.id)).toEqual({
      acp_launch: { executable: '/opt/acp-agent', argv: ['--profile', 'secret-name'] },
      lifecycle: { load: true, resume: false },
      usage_baseline: { totalTokens: 20, inputTokens: 10, outputTokens: 5 },
    });
    const updated = store.setAgentSessionRuntime(
      'eng', alpha.id, 'native-session', { load: true, resume: true },
    );
    expect(updated.session_ref).toBe('native-session');
    expect(store.getAgentRuntimeConfig('eng', alpha.id)?.lifecycle).toEqual({
      load: true, resume: true,
    });
    store.stageAgentUsageBaseline('eng', alpha.id, 77, {
      totalTokens: 33, inputTokens: 16, outputTokens: 9,
      cachedReadTokens: 5, cachedWriteTokens: 3,
    });
    expect(store.getAgentRuntimeConfig('eng', alpha.id)?.usage_baseline)
      .toMatchObject({ totalTokens: 20 });
    expect(store.db.prepare(
      'SELECT acp_usage_pending FROM members WHERE room = ? AND id = ?',
    ).get('eng', alpha.id)).toMatchObject({ acp_usage_pending: expect.stringContaining('"run_msg_id":77') });
    store.setAgentUsageBaseline('eng', alpha.id, {
      totalTokens: 33, inputTokens: 16, outputTokens: 9,
      cachedReadTokens: 5, cachedWriteTokens: 3,
    });
    expect(store.getAgentRuntimeConfig('eng', alpha.id)?.usage_baseline).toMatchObject({
      totalTokens: 33, cachedWriteTokens: 3,
    });
  });

  it('keeps the columns when a legacy database rebuilds the members table', () => {
    // The lifecycle migration REBUILDS `members` from an explicit column list when it
    // finds the old global UNIQUE(room, handle). Adding our columns before that runs
    // would see them dropped straight back out — and then every insert would fail on a
    // column that no longer exists. This is the ordering, asserted.
    const legacyPath = join(dir, 'legacy.sqlite');
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_ts TEXT NOT NULL,
        config TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        room TEXT NOT NULL REFERENCES rooms(id),
        kind TEXT NOT NULL,
        handle TEXT NOT NULL,
        display_name TEXT NOT NULL,
        harness TEXT, session_ref TEXT, cwd TEXT, policy TEXT, host TEXT,
        state TEXT, custody TEXT, parent TEXT, role TEXT,
        conventions_sent INTEGER NOT NULL DEFAULT 0,
        misaddressed INTEGER NOT NULL DEFAULT 0,
        UNIQUE (room, handle)
      );
    `);
    legacy.close();

    const migrated = new Store(legacyPath);
    const columns = (migrated.db.pragma('table_info(members)') as { name: string }[])
      .map((column) => column.name);
    expect(columns).toContain('model');
    expect(columns).toContain('thinking');
    expect(columns).toContain('acp_launch');
    expect(columns).toContain('session_lifecycle');
    expect(columns).toContain('acp_usage_baseline');
    expect(columns).toContain('acp_usage_pending');

    // And it still works: an insert against the rebuilt table must not fail.
    openRoom(migrated);
    const alpha = migrated.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'alpha', harness: 'fake',
      cwd: '/tmp/work', model: 'sonnet-5', thinking: 'medium',
    });
    expect(migrated.getMember('eng', alpha.id)!.model).toBe('sonnet-5');
    migrated.close();
  });
});
// harn:end durable-agent-runtime-configuration

// harn:assume only-an-admissible-delivery-becomes-delivering ref=turn-admission-regression
describe('a consumed delivery is never resurrected into a turn', () => {
  const queueOne = (body = '@alpha do it') => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'alpha', harness: 'fake', cwd: '/work',
    });
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body });
    const delivery = store.createDelivery('eng', { message_id: message.id, recipient: alpha.id });
    return { alpha, delivery };
  };

  it('refuses a delivery consumed AFTER it was selected and BEFORE the turn began', () => {
    const { alpha, delivery } = queueOne();

    // The pump selects what is queued...
    const selected = store.listDeliveries('eng', { recipient: alpha.id, state: 'queued' });
    expect(selected.map((item) => item.id)).toEqual([delivery.id]);

    // ...and something consumes it in the window before the turn is admitted. At HEAD this
    // is reachable: the A5 removal drain consumes from outside the pump entirely.
    store.updateDelivery('eng', delivery.id, { state: 'consumed' });

    const started = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: selected.map((item) => item.id),
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    });

    // It must not be handed to the agent as work...
    expect(started, 'a turn with nothing admissible must not begin').toBeUndefined();
    expect(store.getDelivery('eng', delivery.id)!.state).toBe('consumed');
    // ...and no empty run message may be posted in its name.
    expect(store.listMessages('eng', { limit: 20 }).filter((m) => m.kind === 'run')).toHaveLength(0);
  });

  it('proceeds with the remainder when only SOME of the batch was consumed', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'alpha', harness: 'fake', cwd: '/work',
    });
    const first = store.createDelivery('eng', {
      message_id: store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@alpha one' }).id,
      recipient: alpha.id,
    });
    const second = store.createDelivery('eng', {
      message_id: store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@alpha two' }).id,
      recipient: alpha.id,
    });

    store.updateDelivery('eng', first.id, { state: 'consumed' });

    const started = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [first.id, second.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;

    expect(started.deliveries.map((item) => item.id)).toEqual([second.id]);
    expect(store.getDelivery('eng', first.id)!.state).toBe('consumed');
    expect(store.getDelivery('eng', second.id)!.state).toBe('delivering');
    expect(started.deliveries[0]!.run_msg_id).toBe(started.runMessage.id);
  });

  it('leaves a HELD delivery held — the admission set is closed, not widened', () => {
    const { alpha, delivery } = queueOne();
    store.updateDelivery('eng', delivery.id, { state: 'held' });

    const started = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    });

    expect(started).toBeUndefined();
    expect(store.getDelivery('eng', delivery.id)!.state).toBe('held');
  });

  it('re-admits a HELD delivery bound to the run being reused — the operator released it', () => {
    // An ambiguous turn parks its deliveries as `held`. When the operator releases one,
    // the daemon retries THAT run with the held group. Those deliveries are not being
    // swept into a turn: this run already claimed them, and the release is the request.
    // Restricting admission to `queued` alone would silently kill release_hold.
    const { alpha, delivery } = queueOne();
    const first = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;
    store.updateDelivery('eng', delivery.id, { state: 'held' });

    const released = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
      reuseRunMsgId: first.runMessage.id,
    })!;

    expect(released.runMessage.id).toBe(first.runMessage.id);
    expect(released.deliveries.map((item) => item.id)).toEqual([delivery.id]);
  });

  it('never re-admits a CONSUMED delivery, even for the run that claimed it', () => {
    // The one state that is admissible in no case at all.
    const { alpha, delivery } = queueOne();
    const first = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;
    store.updateDelivery('eng', delivery.id, { state: 'consumed' });

    const retried = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
      reuseRunMsgId: first.runMessage.id,
    });

    expect(retried, 'work that was already taken is never handed out again').toBeUndefined();
    expect(store.getDelivery('eng', delivery.id)!.state).toBe('consumed');
  });

  it('still re-runs the deliveries a reconciled retry had already claimed', () => {
    // A crash-retry reuses its run message and re-runs deliveries that are ALREADY
    // `delivering` — this very run claimed them. Closing admission to `queued` alone
    // would silently kill crash recovery, so a delivery bound to the run being reused
    // is admissible too.
    const { alpha, delivery } = queueOne();
    const first = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;
    expect(store.getDelivery('eng', delivery.id)!.state).toBe('delivering');

    const retried = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [delivery.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
      reuseRunMsgId: first.runMessage.id,
    })!;

    expect(retried.runMessage.id, 'the retry reuses its run message').toBe(first.runMessage.id);
    expect(retried.deliveries.map((item) => item.id)).toEqual([delivery.id]);
    expect(retried.deliveries[0]!.attempt_count).toBe(2);
  });

  const seedForeignScopedRow = () => {
    const { owner } = openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false, branch: 'main',
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false, branch: 'feature/child',
    };
    const registered = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'child', 'adopted');
    const child = registered.worktree.conversation_id;
    const agent = store.addMember(child, {
      kind: 'agent', handle: 'scoped-agent', display_name: 'Scoped Agent', state: 'idle',
    });
    store.createRoom({ id: 'ops', name: 'Operations', owner: { handle: 'ops-owner', display_name: 'Ops Owner' } });
    const opsMain: WorktreeObservation = {
      path: join(dir, 'ops-repo'), git_admin_id: join(dir, 'ops-repo', '.git'), primary: true,
      availability: 'available', locked: false, branch: 'main',
    };
    const opsSecondary: WorktreeObservation = {
      path: join(dir, 'ops-child'), git_admin_id: join(dir, 'ops-repo', '.git', 'worktrees', 'ops-child'),
      primary: false, availability: 'available', locked: false, branch: 'feature/ops-child',
    };
    const opsRegistered = store.registerWorktree('ops', {
      common_path: join(dir, 'ops-repo', '.git'), primary_path: opsMain.path,
      primary_git_admin_id: opsMain.git_admin_id,
    }, opsMain, opsSecondary, 'ops-child', 'adopted');
    const validTarget = {
      worktree_id: registered.worktree.id, conversation_id: child, member_id: agent.id,
      alias: 'child', handle: agent.handle,
    } as const;
    const foreignTarget = {
      worktree_id: opsRegistered.worktree.id,
      conversation_id: opsRegistered.worktree.conversation_id,
      member_id: agent.id, alias: 'ops-child', handle: agent.handle,
    } as const;
    const message = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'foreign admission' });
    const legacy = new Database(join(dir, 'test.sqlite'));
    legacy
      .prepare(
        `INSERT INTO deliveries (id, room, message_id, recipient, target_worktree_id,
           target_conversation_id, target_alias, target_handle, state, attempt_count,
           batch_id, run_msg_id, read_ts, interaction_resolved_ts, payload_snapshot,
           process_id, process_group_id, hop_count, queue_seq, group_id, group_round, ts)
         VALUES (?, 'eng', ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
           (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM deliveries), NULL, NULL, ?)`,
      )
      .run(
        `legacy-${message.id}`,
        message.id,
        agent.id,
        foreignTarget.worktree_id,
        foreignTarget.conversation_id,
        foreignTarget.alias,
        foreignTarget.handle,
        new Date().toISOString(),
      );
    legacy.close();
    return { agent, validTarget, foreignTarget, message };
  };

  it('never admits a legacy foreign-repository queued row, and drains the later valid row', () => {
    const { agent, validTarget, message } = seedForeignScopedRow();
    const foreignId = `legacy-${message.id}`;
    const valid = store.createDelivery('eng', {
      message_id: message.id, recipient: agent.id, target: validTarget,
    });

    const started = store.beginTurn('eng', {
      memberId: agent.id,
      deliveryIds: [foreignId, valid.id],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;

    // The foreign row is invisible to admission — never executed, never
    // consumed by the turn — while the valid row enters the batch.
    expect(started.deliveries.map((item) => item.id)).toEqual([valid.id]);
    expect(store.getDelivery('eng', foreignId)!.state).toBe('queued');
    expect(store.getDelivery('eng', valid.id)!.state).toBe('delivering');
  });

  it('never re-admits a foreign-repository row bound to the reused run', () => {
    const { agent, message } = seedForeignScopedRow();
    const foreignId = `legacy-${message.id}`;
    const run = store.postMessage('eng', {
      author: agent.id, kind: 'run', body: '',
      run: {
        status: 'running', started_ts: '2026-08-06T00:00:00.000Z', tool_calls: 0,
        events_ref: `runs/${String(message.id)}.jsonl`,
      },
    });
    store.updateDelivery('eng', foreignId, { state: 'delivering', run_msg_id: run.id, attempt_count: 1 });

    const started = store.beginTurn('eng', {
      memberId: agent.id,
      deliveryIds: [foreignId],
      startedTs: new Date().toISOString(),
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
      reuseRunMsgId: run.id,
    });

    // A reused run may re-admit its own binding, but never a foreign one:
    // nothing admissible means no turn and no second run message.
    expect(started).toBeUndefined();
    expect(store.getDelivery('eng', foreignId)!.state).toBe('delivering');
    expect(store.listMessages('eng', { limit: 20 }).filter((item) => item.kind === 'run'))
      .toHaveLength(1);
  });

  // harn:assume unresolved-delivery-fences-fresh-member-turns ref=durable-delivery-turn-fence-regression
  it('fences a fresh run behind another durable active attempt but permits exact-run recovery', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'fenced-alpha', display_name: 'Fenced Alpha', state: 'running',
    });
    const staleTrigger = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@fenced-alpha old work',
    });
    const staleDelivery = store.createDelivery('eng', {
      message_id: staleTrigger.id, recipient: alpha.id,
    });
    const stale = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [staleDelivery.id],
      startedTs: '2026-07-18T10:00:00.000Z',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;
    const freshTrigger = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@fenced-alpha new work',
    });
    const freshDelivery = store.createDelivery('eng', {
      message_id: freshTrigger.id, recipient: alpha.id,
    });

    const refused = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [freshDelivery.id],
      startedTs: '2026-07-18T10:01:00.000Z',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    });
    expect(refused).toBeUndefined();
    expect(store.getDelivery('eng', freshDelivery.id)?.state).toBe('queued');
    expect(store.listMessages('eng', { limit: 100 }).filter((message) => message.kind === 'run'))
      .toHaveLength(1);

    const resumed = store.beginTurn('eng', {
      memberId: alpha.id,
      deliveryIds: [staleDelivery.id],
      startedTs: '2026-07-18T10:02:00.000Z',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
      reuseRunMsgId: stale.runMessage.id,
    });
    expect(resumed?.runMessage.id).toBe(stale.runMessage.id);
    expect(resumed?.deliveries[0]?.attempt_count).toBe(2);
  });

  it('uses each delivering row origin for same-id false-negative and false-positive fences', () => {
    const { owner } = openRoom(store);
    const main: WorktreeObservation = {
      path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
      availability: 'available', locked: false,
    };
    const secondary: WorktreeObservation = {
      path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
      availability: 'available', locked: false,
    };
    const registered = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, secondary, 'child', 'adopted');
    const child = registered.worktree.conversation_id;
    const second = store.registerWorktree('eng', {
      common_path: join(dir, 'repo', '.git'), primary_path: main.path,
      primary_git_admin_id: main.git_admin_id,
    }, main, { ...secondary, path: join(dir, 'second'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'second') }, 'second', 'adopted');
    const secondOrigin = second.worktree.conversation_id;
    const childAgent = store.addMember(child, {
      kind: 'agent', handle: 'collision-agent', display_name: 'Collision Agent', state: 'running',
    });
    const target = {
      worktree_id: registered.worktree.id, conversation_id: child, member_id: childAgent.id,
      alias: 'child', handle: childAgent.handle,
    } as const;

    const active = store.postMessage('eng', {
      author: owner.id, kind: 'run', body: '',
      run: { status: 'running', started_ts: '2026-08-06T00:00:00.000Z', tool_calls: 0, events_ref: 'runs/1.jsonl' },
    });
    const activeDelivery = store.createDelivery('eng', {
      message_id: active.id, recipient: childAgent.id, target,
    });
    store.updateDelivery('eng', activeDelivery.id, { state: 'delivering', run_msg_id: active.id });
    const freshTrigger = store.postMessage(secondOrigin, {
      author: owner.id, kind: 'chat', body: 'same id must not hide the active origin',
    });
    const fresh = store.createDelivery(secondOrigin, {
      message_id: freshTrigger.id, recipient: childAgent.id, target,
    });
    expect(store.beginTurn(secondOrigin, {
      memberId: childAgent.id, targetRoom: child, deliveryIds: [fresh.id],
      startedTs: '2026-08-06T00:01:00.000Z', eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })).toBeUndefined();

    store.updateMessage('eng', active.id, { run: { ...active.run!, status: 'completed' } });
    store.updateDelivery('eng', activeDelivery.id, { state: 'consumed' });
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    const completed = store.postMessage('eng', {
      author: owner.id, kind: 'run', body: 'already completed',
      run: { status: 'completed', started_ts: '2026-08-06T00:02:00.000Z', tool_calls: 0, events_ref: 'runs/1.jsonl' },
    });
    const completedDelivery = store.createDelivery('eng', {
      message_id: completed.id, recipient: childAgent.id, target,
    });
    store.updateDelivery('eng', completedDelivery.id, { state: 'delivering', run_msg_id: completed.id });
    const unrelatedRunning = store.postMessage(secondOrigin, {
      author: owner.id, kind: 'run', body: '',
      run: { status: 'running', started_ts: '2026-08-06T00:03:00.000Z', tool_calls: 0, events_ref: 'runs/1.jsonl' },
    });
    const laterTrigger = store.postMessage(secondOrigin, {
      author: owner.id, kind: 'chat', body: 'same id must not invent an active origin',
    });
    const later = store.createDelivery(secondOrigin, {
      message_id: laterTrigger.id, recipient: childAgent.id, target,
    });
    const started = store.beginTurn(secondOrigin, {
      memberId: childAgent.id, targetRoom: child, deliveryIds: [later.id],
      startedTs: '2026-08-06T00:04:00.000Z', eventsRef: (id) => `runs/${String(id)}.jsonl`,
    });
    expect(unrelatedRunning.id).toBe(completed.id);
    expect(started?.deliveries.map((delivery) => delivery.id)).toEqual([later.id]);
  });
  // harn:end unresolved-delivery-fences-fresh-member-turns
});

// harn:assume approval-answer-is-atomic-and-chatless ref=approval-answer-store-regression
describe('atomic approval answers', () => {
  const seedApproval = () => {
    const { owner } = openRoom(store);
    const admin = store.addMember('eng', {
      kind: 'human', handle: 'review-admin', display_name: 'Review Admin', role: 'admin',
    });
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'approver', display_name: 'Approver', state: 'awaiting_input',
    });
    const card = store.postMessage('eng', {
      author: agent.id,
      kind: 'approval',
      body: 'Allow Bash?',
      ask: {
        interaction_id: 'native-approval',
        kind: 'approval',
        prompt: 'Allow Bash?',
        options: [{ label: 'Allow once' }, { label: 'Deny' }],
      },
    });
    store.upsertInteraction({
      id: 'approval-1', room: 'eng', member_id: agent.id, message_id: card.id,
      native_id: 'native-approval', kind: 'approval', targets: [owner.id, admin.id], state: 'pending',
    });
    const deliveries = [owner.id, admin.id].map((recipient) => store.createDelivery('eng', {
      message_id: card.id, recipient, state: 'consumed',
    }));
    return { owner, card, deliveries };
  };

  it('commits the durable answer and every target-human read in one projection', () => {
    const seeded = seedApproval();
    const cursor = store.currentSeq('eng');
    const answeredTs = '2026-07-14T10:00:00.000Z';

    const result = store.answerApproval('eng', 'approval-1', 'Allow once', seeded.owner.id, answeredTs);

    expect(result.interaction).toMatchObject({
      state: 'answered', answer: 'Allow once', answered_by: seeded.owner.id, answered_ts: answeredTs,
    });
    expect(result.deliveries.map((delivery) => delivery.id)).toEqual(seeded.deliveries.map((item) => item.id));
    expect(result.deliveries.every((delivery) => delivery.read_ts === answeredTs)).toBe(true);
    expect(result.deliveries.every(
      (delivery) => delivery.interaction_resolved_ts === answeredTs,
    )).toBe(true);
    expect(store.sync('eng', cursor).inbox).toEqual(result.deliveries);
  });

  it('rolls back the answer and all reads when a later delivery update fails', () => {
    const seeded = seedApproval();
    const blocker = new Database(join(dir, 'test.sqlite'));
    blocker.exec(`CREATE TRIGGER reject_second_approval_read
      BEFORE UPDATE OF read_ts ON deliveries
      WHEN NEW.id = '${seeded.deliveries[1]!.id}'
      BEGIN SELECT RAISE(ABORT, 'injected read failure'); END`);
    blocker.close();

    expect(() => store.answerApproval(
      'eng', 'approval-1', 'Allow once', seeded.owner.id, '2026-07-14T10:00:00.000Z',
    )).toThrow('injected read failure');
    expect(store.getInteraction('approval-1')).toMatchObject({ state: 'pending' });
    expect(seeded.deliveries.map((delivery) => store.getDelivery('eng', delivery.id)?.read_ts))
      .toEqual([undefined, undefined]);
    expect(seeded.deliveries.map(
      (delivery) => store.getDelivery('eng', delivery.id)?.interaction_resolved_ts,
    )).toEqual([undefined, undefined]);
  });
});
// harn:end approval-answer-is-atomic-and-chatless

// harn:assume turns-reuse-one-root-and-append-output-messages ref=continuation-root-regression
describe('continuation message storage', () => {
  it('migrates a legacy database idempotently without losing messages', () => {
    const { owner } = openRoom(store);
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'preserve me' });
    const path = join(dir, 'test.sqlite');
    store.close();

    const legacy = new Database(path);
    legacy.exec('DROP INDEX IF EXISTS message_run_continuations; ALTER TABLE messages DROP COLUMN run_parent_id;');
    expect((legacy.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count)
      .toBe(1);
    legacy.close();

    store = new Store(path);
    expect(store.listMessages('eng', { limit: 10 }).map((message) => message.body))
      .toEqual(['preserve me']);
    store.close();
    store = new Store(path);
    expect(store.listMessages('eng', { limit: 10 })).toHaveLength(1);

    const reopened = new Database(path, { readonly: true });
    const columns = reopened.pragma('table_info(messages)') as { name: string }[];
    expect(columns.map((column) => column.name)).toContain('run_parent_id');
    expect(reopened.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'message_run_continuations'",
    ).get()).toBeTruthy();
    reopened.close();
  });

  it('round-trips permanent rows and starts one messages-mode lifecycle root', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'codex', display_name: 'Codex', state: 'idle',
    });
    const root = store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: 'first stretch',
      run: {
        status: 'completed',
        started_ts: '2026-07-18T00:00:00.000Z',
        ended_ts: '2026-07-18T00:01:00.000Z',
        tool_calls: 0,
        events_ref: 'runs/1.jsonl',
        final_text: 'first stretch\ncontinuation stretch',
        output_mode: 'messages',
        result_message_id: 3,
      },
    });
    const interjection = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: 'please keep going',
    });
    const continuation = store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: 'continuation stretch',
      run_parent_id: root.id,
    });
    expect([root.id, interjection.id, continuation.id]).toEqual([1, 2, 3]);

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.listMessages('eng', { limit: 10 }).map((message) => ({
      id: message.id,
      body: message.body,
      parent: message.run_parent_id,
      mode: message.run?.output_mode,
      result: message.run?.result_message_id,
    }))).toEqual([
      { id: 1, body: 'first stretch', parent: undefined, mode: 'messages', result: 3 },
      { id: 2, body: 'please keep going', parent: undefined, mode: undefined, result: undefined },
      { id: 3, body: 'continuation stretch', parent: 1, mode: undefined, result: undefined },
    ]);

    const trigger = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@codex next' });
    const delivery = store.createDelivery('eng', { message_id: trigger.id, recipient: agent.id });
    const current = store.beginTurn('eng', {
      memberId: agent.id,
      deliveryIds: [delivery.id],
      startedTs: '2026-07-18T00:02:00.000Z',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    });
    expect(current?.runMessage.run).toHaveProperty('output_mode', 'messages');
    expect(current?.runMessage.run_parent_id).toBeUndefined();
    const appended = store.createRunContinuation('eng', current!.runMessage.id);
    expect(appended).toMatchObject({
      id: current!.runMessage.id + 1,
      author: agent.id,
      kind: 'run',
      body: '',
      run_parent_id: current!.runMessage.id,
      run: undefined,
    });
    expect(store.listRunMessages('eng', { author: agent.id, limit: 1 })[0]?.id)
      .toBe(current!.runMessage.id);
  });

  // harn:assume run-cost-estimates-are-finalization-snapshots ref=run-estimate-regression
  it('snapshots the explicit model only on a fresh root and preserves it on retry', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'priced', display_name: 'Priced', state: 'running',
    });
    const trigger = store.postMessage('eng', { author: owner.id, kind: 'chat', body: '@priced go' });
    const delivery = store.createDelivery('eng', { message_id: trigger.id, recipient: agent.id });
    const first = store.beginTurn('eng', {
      memberId: agent.id,
      deliveryIds: [delivery.id],
      startedTs: '2026-07-18T00:00:00.000Z',
      model: 'gpt-5.6-luna',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
    })!;
    expect(first.runMessage.run?.model).toBe('gpt-5.6-luna');

    const retried = store.beginTurn('eng', {
      memberId: agent.id,
      deliveryIds: [delivery.id],
      startedTs: '2026-07-18T00:01:00.000Z',
      model: 'gpt-5.6-sol',
      eventsRef: (id) => `runs/${String(id)}.jsonl`,
      reuseRunMsgId: first.runMessage.id,
    })!;
    expect(retried.runMessage.id).toBe(first.runMessage.id);
    expect(retried.runMessage.run?.model).toBe('gpt-5.6-luna');
  });
  // harn:end run-cost-estimates-are-finalization-snapshots
});
// harn:end turns-reuse-one-root-and-append-output-messages

// harn:assume approval-deliveries-project-resolution-separately ref=approval-resolution-store-regression
describe('approval delivery resolution migration', () => {
  it('backfills a pre-column answered approval and remains idempotent on reopen', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'legacy-approver', display_name: 'Legacy Approver', state: 'awaiting_input',
    });
    const card = store.postMessage('eng', {
      author: agent.id,
      kind: 'approval',
      body: 'Allow legacy command?',
      ask: {
        interaction_id: 'legacy-native',
        kind: 'approval',
        prompt: 'Allow legacy command?',
        options: [{ label: 'Allow once' }],
      },
    });
    store.upsertInteraction({
      id: 'legacy-approval', room: 'eng', member_id: agent.id, message_id: card.id,
      native_id: 'legacy-native', kind: 'approval', targets: [owner.id], state: 'pending',
    });
    const delivery = store.createDelivery('eng', {
      message_id: card.id, recipient: owner.id, state: 'consumed',
    });
    const answeredTs = '2026-07-14T09:30:00.000Z';
    store.close();

    const legacy = new Database(join(dir, 'test.sqlite'));
    legacy.prepare(
      `UPDATE pending_interactions
       SET state = 'acked', answer = '"Allow once"', answered_by = ?, answered_ts = ?
       WHERE id = 'legacy-approval'`,
    ).run(owner.id, answeredTs);
    legacy.prepare('UPDATE deliveries SET read_ts = NULL WHERE id = ?').run(delivery.id);
    legacy.exec('ALTER TABLE deliveries DROP COLUMN interaction_resolved_ts');
    legacy.close();

    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getDelivery('eng', delivery.id)).toMatchObject({
      read_ts: answeredTs,
      interaction_resolved_ts: answeredTs,
    });

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getDelivery('eng', delivery.id)).toMatchObject({
      read_ts: answeredTs,
      interaction_resolved_ts: answeredTs,
    });
  });

  it('resolves only target humans on the approval card', () => {
    const { owner } = openRoom(store);
    const outsider = store.addMember('eng', {
      kind: 'human', handle: 'outsider', display_name: 'Outsider', role: 'member',
    });
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'targeted-approver', display_name: 'Targeted Approver', state: 'awaiting_input',
    });
    const card = store.postMessage('eng', {
      author: agent.id,
      kind: 'approval',
      body: 'Allow targeted command?',
      ask: { interaction_id: 'targeted-native', kind: 'approval', prompt: 'Allow targeted command?' },
    });
    store.upsertInteraction({
      id: 'targeted-approval', room: 'eng', member_id: agent.id, message_id: card.id,
      native_id: 'targeted-native', kind: 'approval', targets: [owner.id], state: 'pending',
    });
    const target = store.createDelivery('eng', {
      message_id: card.id, recipient: owner.id, state: 'consumed',
    });
    const unrelated = store.createDelivery('eng', {
      message_id: card.id, recipient: outsider.id, state: 'consumed',
    });

    const resolved = store.answerApproval(
      'eng', 'targeted-approval', 'Allow once', owner.id, '2026-07-14T10:00:00.000Z',
    );

    expect(resolved.deliveries.map((item) => item.id)).toEqual([target.id]);
    expect(store.getDelivery('eng', unrelated.id)).toMatchObject({
      read_ts: undefined,
      interaction_resolved_ts: undefined,
    });
  });
});
// harn:end approval-deliveries-project-resolution-separately

// harn:assume group-round-creation-is-atomic-and-idempotent ref=collaboration-round-materialization-regression
describe('collaboration round materialization', () => {
  const seed = () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'beta', display_name: 'Beta', state: 'idle',
    });
    const root = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@alpha @beta investigate',
    });
    return { alpha, beta, root };
  };

  it('creates each group round once with stable ordinals, snapshots, and associations', () => {
    const { alpha, beta, root } = seed();
    const roundOne = store.createCollaborationGroup('eng', {
      groupId: 'group-1',
      rootMessageId: root.id,
      createdTs: '2026-07-14T12:00:00.000Z',
      participants: [
        { memberId: beta.id, payloadSnapshot: 'round one for beta' },
        { memberId: alpha.id, payloadSnapshot: 'round one for alpha' },
      ],
    });

    expect(roundOne.group).toMatchObject({
      id: 'group-1', room: 'eng', root_message_id: root.id, state: 'open',
    });
    expect(roundOne.round).toMatchObject({ group_id: 'group-1', round_number: 1, state: 'collecting' });
    expect(roundOne.participants.map((participant) => ({
      ordinal: participant.ordinal,
      member_id: participant.member_id,
      delivery_id: participant.delivery_id,
    }))).toEqual([
      { ordinal: 0, member_id: beta.id, delivery_id: roundOne.deliveries[0]!.id },
      { ordinal: 1, member_id: alpha.id, delivery_id: roundOne.deliveries[1]!.id },
    ]);
    expect(roundOne.deliveries.map((delivery) => ({
      recipient: delivery.recipient,
      group_id: delivery.group_id,
      group_round: delivery.group_round,
    }))).toEqual([
      { recipient: beta.id, group_id: 'group-1', group_round: 1 },
      { recipient: alpha.id, group_id: 'group-1', group_round: 1 },
    ]);
    expect(roundOne.deliveries.map((item) => store.getDeliveryPayloadSnapshot('eng', item.id)))
      .toEqual(['round one for beta', 'round one for alpha']);

    const retried = store.createCollaborationGroup('eng', {
      groupId: 'ignored-on-idempotent-retry',
      rootMessageId: root.id,
      createdTs: '2026-07-14T12:01:00.000Z',
      participants: [
        { memberId: beta.id, payloadSnapshot: 'round one for beta' },
        { memberId: alpha.id, payloadSnapshot: 'round one for alpha' },
      ],
    });
    expect(retried.group.id).toBe('group-1');
    expect(retried.deliveries.map((delivery) => delivery.id))
      .toEqual(roundOne.deliveries.map((delivery) => delivery.id));

    const roundTwo = store.createCollaborationRound('eng', {
      groupId: 'group-1',
      roundNumber: 2,
      createdTs: '2026-07-14T12:02:00.000Z',
      participants: [{ memberId: alpha.id, payloadSnapshot: 'combined prior round' }],
    });
    const roundTwoRetry = store.createCollaborationRound('eng', {
      groupId: 'group-1',
      roundNumber: 2,
      participants: [{ memberId: alpha.id, payloadSnapshot: 'combined prior round' }],
    });
    expect(roundTwoRetry.deliveries.map((delivery) => delivery.id))
      .toEqual(roundTwo.deliveries.map((delivery) => delivery.id));
    expect(store.listDeliveries('eng')).toHaveLength(3);

    expect(() => store.createCollaborationRound('eng', {
      groupId: 'group-1',
      roundNumber: 3,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'duplicate alpha one' },
        { memberId: alpha.id, payloadSnapshot: 'duplicate alpha two' },
      ],
    })).toThrow(`duplicate collaboration participant: ${alpha.id}`);
    expect(store.getCollaborationRound('eng', 'group-1', 3)).toBeUndefined();
  });

  it('rolls back a later round after a participant insert failure', () => {
    const { alpha, beta, root } = seed();
    store.createCollaborationGroup('eng', {
      groupId: 'group-rollback',
      rootMessageId: root.id,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'alpha r1' },
        { memberId: beta.id, payloadSnapshot: 'beta r1' },
      ],
    });
    const blocker = new Database(join(dir, 'test.sqlite'));
    blocker.exec(`CREATE TRIGGER reject_second_round_participant
      BEFORE INSERT ON collaboration_participants
      WHEN NEW.group_id = 'group-rollback' AND NEW.round_number = 2 AND NEW.ordinal = 1
      BEGIN SELECT RAISE(ABORT, 'injected participant failure'); END`);
    blocker.close();

    expect(() => store.createCollaborationRound('eng', {
      groupId: 'group-rollback',
      roundNumber: 2,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'alpha r2' },
        { memberId: beta.id, payloadSnapshot: 'beta r2' },
      ],
    })).toThrow('injected participant failure');
    expect(store.getCollaborationRound('eng', 'group-rollback', 2)).toBeUndefined();
    expect(store.listDeliveries('eng')).toHaveLength(2);
  });

  it('rejects a cross-repository participant without allocating any round rows', () => {
    const { alpha, root } = seed();
    store.createRoom({ id: 'ops', name: 'Operations', owner: { handle: 'ops-owner', display_name: 'Ops Owner' } });
    const opsMain: WorktreeObservation = {
      path: join(dir, 'ops-repo'), git_admin_id: join(dir, 'ops-repo', '.git'), primary: true,
      availability: 'available', locked: false, branch: 'main',
    };
    const opsSecondary: WorktreeObservation = {
      path: join(dir, 'ops-child'), git_admin_id: join(dir, 'ops-repo', '.git', 'worktrees', 'ops-child'),
      primary: false, availability: 'available', locked: false, branch: 'feature/ops-child',
    };
    const opsRegistered = store.registerWorktree('ops', {
      common_path: join(dir, 'ops-repo', '.git'), primary_path: opsMain.path,
      primary_git_admin_id: opsMain.git_admin_id,
    }, opsMain, opsSecondary, 'ops-child', 'adopted');
    const opsChild = opsRegistered.worktree.conversation_id;
    const foreign = store.addMember(opsChild, {
      kind: 'agent', handle: 'foreign-agent', display_name: 'Foreign Agent', state: 'idle',
    });
    const foreignTarget = {
      worktree_id: opsRegistered.worktree.id, conversation_id: opsChild, member_id: foreign.id,
      alias: 'ops-child', handle: foreign.handle,
    } as const;

    const expectNoPartialState = () => {
      expect(store.getCollaborationGroup('eng', 'foreign-group')).toBeUndefined();
      expect(store.listCollaborationRounds('eng', 'foreign-group')).toEqual([]);
      expect(store.listDeliveries('eng')).toEqual([]);
    };
    expect(() => store.createCollaborationGroup('eng', {
      groupId: 'foreign-group',
      rootMessageId: root.id,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'alpha round' },
        { memberId: foreign.id, target: foreignTarget, payloadSnapshot: 'foreign round' },
      ],
    })).toThrow(`no active agent member: ${foreign.id}`);
    expectNoPartialState();

    // The rejection is durable: a reopen cannot reveal partial group, round,
    // participant, delivery, or payload snapshot rows.
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expectNoPartialState();
  });
});
// harn:end group-round-creation-is-atomic-and-idempotent

// harn:assume collaboration-groups-are-durable-state ref=collaboration-store-reopen-regression
describe('collaboration state migration and reopen', () => {
  it('migrates a populated pre-group database and persists a complete projection', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'beta', display_name: 'Beta', state: 'idle',
    });
    const root = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@alpha @beta preserve me',
    });
    const legacyDelivery = store.createDelivery('eng', {
      message_id: root.id, recipient: alpha.id, payload_snapshot: 'legacy snapshot',
    });
    store.close();

    const legacy = new Database(join(dir, 'test.sqlite'));
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(`
      DROP INDEX IF EXISTS delivery_group_round_recipient_unique;
      DROP INDEX IF EXISTS delivery_group_round_lookup;
      DROP TABLE IF EXISTS collaboration_participants;
      DROP TABLE IF EXISTS collaboration_rounds;
      DROP TABLE IF EXISTS collaboration_groups;
      ALTER TABLE deliveries DROP COLUMN group_round;
      ALTER TABLE deliveries DROP COLUMN group_id;
    `);
    legacy.close();

    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getMessage('eng', root.id)?.body).toBe('@alpha @beta preserve me');
    expect(store.getDelivery('eng', legacyDelivery.id)).toMatchObject({
      id: legacyDelivery.id, group_id: undefined, group_round: undefined,
    });
    const created = store.createCollaborationGroup('eng', {
      groupId: 'durable-group',
      rootMessageId: root.id,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'alpha grouped' },
        { memberId: beta.id, payloadSnapshot: 'beta grouped' },
      ],
    });
    store.updateCollaborationParticipant('eng', 'durable-group', 1, alpha.id, {
      terminal_status: 'completed',
      result_message_id: root.id,
      completed_ts: '2026-07-14T12:10:00.000Z',
    });
    const expected = store.getCollaborationRoundProjection('eng', 'durable-group', 1);
    store.close();

    store = new Store(join(dir, 'test.sqlite'));
    const reopened = store.getCollaborationRoundProjection('eng', 'durable-group', 1);
    expect(reopened).toEqual(expected);
    expect(reopened?.deliveries.map((delivery) => delivery.id))
      .toEqual(created.deliveries.map((delivery) => delivery.id));
    expect(store.findCollaborationParticipantByDelivery('eng', created.deliveries[1]!.id))
      .toEqual(created.participants[1]);
  });
});
// harn:end collaboration-groups-are-durable-state

it('keeps target scope in atomic round materialization and idempotent retries', () => {
  const { owner } = openRoom(store);
  const alpha = store.addMember('eng', {
    kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'idle',
  });
  const root = store.postMessage('eng', {
    author: owner.id, kind: 'chat', body: '@alpha scoped round',
  });
  const main: WorktreeObservation = {
    path: join(dir, 'repo'), git_admin_id: join(dir, 'repo', '.git'), primary: true,
    availability: 'available', locked: false, branch: 'main',
  };
  const secondary: WorktreeObservation = {
    path: join(dir, 'child'), git_admin_id: join(dir, 'repo', '.git', 'worktrees', 'child'), primary: false,
    availability: 'available', locked: false, branch: 'feature/child',
  };
  const registered = store.registerWorktree('eng', {
    common_path: join(dir, 'repo', '.git'), primary_path: main.path,
    primary_git_admin_id: main.git_admin_id,
  }, main, secondary, 'child', 'adopted');
  const child = registered.worktree.conversation_id;
  const remote = store.addMember(child, {
    kind: 'agent', handle: 'remote', display_name: 'Remote', state: 'idle',
  });
  const target = {
    worktree_id: registered.worktree.id, conversation_id: child, member_id: remote.id,
    alias: 'child', handle: 'remote',
  } as const;
  const input = { memberId: remote.id, target, payloadSnapshot: 'remote round' };
  const localInput = { memberId: alpha.id, payloadSnapshot: 'local round' };
  const first = store.createCollaborationGroup('eng', {
    groupId: 'scoped-group', rootMessageId: root.id, participants: [input, localInput],
  });
  expect(first.deliveries[0]?.target).toEqual(target);
  const retry = store.createCollaborationGroup('eng', {
    groupId: 'different-id-is-ignored', rootMessageId: root.id, participants: [input, localInput],
  });
  expect(retry.group.id).toBe('scoped-group');
  expect(retry.deliveries.map((item) => item.id)).toEqual(first.deliveries.map((item) => item.id));

  store.updateCollaborationParticipant('eng', 'scoped-group', 1, remote.id, {
    terminal_status: 'completed', result_message_id: root.id, completed_ts: '2026-08-06T00:11:00.000Z',
  });
  store.updateCollaborationParticipant('eng', 'scoped-group', 1, localInput.memberId, {
    terminal_status: 'completed', result_message_id: root.id, completed_ts: '2026-08-06T00:11:00.000Z',
  });
  const released = store.releaseCollaborationRound('eng', {
    groupId: 'scoped-group', roundNumber: 1, releasedTs: '2026-08-06T00:12:00.000Z',
    nextParticipants: [
      { ...input, payloadSnapshot: 'remote next round' },
      { ...localInput, payloadSnapshot: 'local next round' },
    ],
  });
  expect(released.deliveries[0]?.target).toEqual(target);
  expect(() => store.createCollaborationGroup('eng', {
    groupId: 'scoped-group', rootMessageId: root.id,
    participants: [
      { memberId: remote.id, payloadSnapshot: 'remote round' },
      localInput,
    ],
  })).toThrow(/different participants or payloads/);
});

// harn:assume eligible-multi-agent-routing-starts-one-group ref=multi-agent-group-regression
describe('atomic routed collaboration ingress', () => {
  it('rolls the root message back when later group materialization fails', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'alpha', display_name: 'Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'beta', display_name: 'Beta', state: 'idle',
    });
    const blocker = new Database(join(dir, 'test.sqlite'));
    blocker.exec(`CREATE TRIGGER reject_atomic_group_second_participant
      BEFORE INSERT ON collaboration_participants
      WHEN NEW.group_id = 'atomic-group' AND NEW.ordinal = 1
      BEGIN SELECT RAISE(ABORT, 'injected atomic group failure'); END`);
    blocker.close();

    expect(() => store.commitRoutedMessage('eng', {
      message: {
        author: owner.id,
        kind: 'chat',
        body: '@alpha @beta atomic root',
      },
      plan: (message) => ({
        fanout: [],
        collaboration: {
          groupId: 'atomic-group',
          participants: [
            { memberId: alpha.id, payloadSnapshot: `alpha sees #${message.id}` },
            { memberId: beta.id, payloadSnapshot: `beta sees #${message.id}` },
          ],
        },
      }),
    })).toThrow('injected atomic group failure');
    expect(store.listMessages('eng')).toEqual([]);
    expect(store.getCollaborationGroup('eng', 'atomic-group')).toBeUndefined();
    expect(store.listDeliveries('eng')).toEqual([]);
  });
});
// harn:end eligible-multi-agent-routing-starts-one-group

// harn:assume collaboration-round-release-is-one-barrier ref=collaboration-round-release-store-regression
describe('collaboration round release transaction', () => {
  const seed = (groupId: string) => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: `${groupId}-alpha`, display_name: 'Alpha', state: 'idle',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: `${groupId}-beta`, display_name: 'Beta', state: 'idle',
    });
    const root = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: `@${alpha.handle} @${beta.handle} release`,
    });
    const round = store.createCollaborationGroup('eng', {
      groupId,
      rootMessageId: root.id,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'alpha round one' },
        { memberId: beta.id, payloadSnapshot: 'beta round one' },
      ],
    });
    return { alpha, beta, root, round };
  };

  it('stays pending until every slot is terminal, then releases only once', () => {
    const seeded = seed('release-group');
    expect(store.releaseCollaborationRound('eng', {
      groupId: 'release-group',
      roundNumber: 1,
      releasedTs: '2026-07-14T13:00:00.000Z',
      nextParticipants: [{ memberId: seeded.alpha.id, payloadSnapshot: 'round two' }],
    })).toMatchObject({ status: 'pending', deliveries: [] });

    for (const participant of seeded.round.participants) {
      store.updateCollaborationParticipant(
        'eng',
        'release-group',
        1,
        participant.member_id,
        {
          terminal_status: 'completed',
          result_message_id: seeded.root.id,
          completed_ts: '2026-07-14T12:59:00.000Z',
        },
      );
    }
    const released = store.releaseCollaborationRound('eng', {
      groupId: 'release-group',
      roundNumber: 1,
      releasedTs: '2026-07-14T13:00:00.000Z',
      nextParticipants: [{ memberId: seeded.alpha.id, payloadSnapshot: 'round two' }],
    });
    expect(released).toMatchObject({ status: 'released' });
    expect(released.deliveries).toHaveLength(1);
    expect(store.getCollaborationRound('eng', 'release-group', 1)?.state).toBe('released');

    const duplicate = store.releaseCollaborationRound('eng', {
      groupId: 'release-group',
      roundNumber: 1,
      releasedTs: '2026-07-14T13:01:00.000Z',
      nextParticipants: [{ memberId: seeded.alpha.id, payloadSnapshot: 'round two' }],
    });
    expect(duplicate).toMatchObject({ status: 'already_released', deliveries: [] });
    expect(store.listDeliveries('eng')).toHaveLength(3);
  });

  it('closes the round and group atomically when there is no next recipient', () => {
    const seeded = seed('closed-group');
    for (const participant of seeded.round.participants) {
      store.updateCollaborationParticipant('eng', 'closed-group', 1, participant.member_id, {
        terminal_status: 'completed',
        result_message_id: seeded.root.id,
        completed_ts: '2026-07-14T13:10:00.000Z',
      });
    }
    expect(store.releaseCollaborationRound('eng', {
      groupId: 'closed-group',
      roundNumber: 1,
      releasedTs: '2026-07-14T13:11:00.000Z',
      nextParticipants: [],
    })).toMatchObject({ status: 'closed', deliveries: [] });
    expect(store.getCollaborationRound('eng', 'closed-group', 1)?.state).toBe('closed');
    expect(store.getCollaborationGroup('eng', 'closed-group')).toMatchObject({
      state: 'completed', completed_ts: '2026-07-14T13:11:00.000Z',
    });
  });

  it('commits the visible refusal in the same transaction as the close, exactly once', () => {
    const seeded = seed('refusal-group');
    expect(store.closeCollaborationRoundWithRefusal('eng', {
      groupId: 'refusal-group',
      roundNumber: 1,
      releasedTs: '2026-08-06T00:20:00.000Z',
      refusalBody: 'qualified target refused in collaboration result: ~missing:@x (unknown-worktree)',
    }).status).toBe('pending');
    expect(store.listMessages('eng')).toHaveLength(1);

    for (const participant of seeded.round.participants) {
      store.updateCollaborationParticipant('eng', 'refusal-group', 1, participant.member_id, {
        terminal_status: 'completed',
        result_message_id: seeded.root.id,
        completed_ts: '2026-08-06T00:20:30.000Z',
      });
    }
    const closed = store.closeCollaborationRoundWithRefusal('eng', {
      groupId: 'refusal-group',
      roundNumber: 1,
      releasedTs: '2026-08-06T00:21:00.000Z',
      refusalBody: 'qualified target refused in collaboration result: ~missing:@x (unknown-worktree)',
    });
    expect(closed.status).toBe('closed');
    expect(closed.refusal).toMatchObject({
      kind: 'system',
      body: 'qualified target refused in collaboration result: ~missing:@x (unknown-worktree)',
    });
    expect(store.getCollaborationRound('eng', 'refusal-group', 1)?.state).toBe('closed');
    expect(store.getCollaborationGroup('eng', 'refusal-group')).toMatchObject({ state: 'completed' });
    expect(store.listCollaborationRounds('eng', 'refusal-group')).toHaveLength(1);

    // Repeated advancement cannot duplicate or lose the durable refusal.
    const repeat = store.closeCollaborationRoundWithRefusal('eng', {
      groupId: 'refusal-group',
      roundNumber: 1,
      releasedTs: '2026-08-06T00:22:00.000Z',
      refusalBody: 'qualified target refused in collaboration result: ~missing:@x (unknown-worktree)',
    });
    expect(repeat).toEqual({ status: 'already_released' });
    const refusals = () =>
      store.listMessages('eng').filter((message) =>
        message.kind === 'system' && message.body.includes('qualified target refused'));
    expect(refusals()).toHaveLength(1);

    // A reopen sees the same settled state: one closed round, one refusal,
    // and only the two round-one deliveries — no next round was allocated.
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getCollaborationRound('eng', 'refusal-group', 1)?.state).toBe('closed');
    expect(refusals()).toHaveLength(1);
    expect(store.listDeliveries('eng')).toHaveLength(2);
  });
});
// harn:end collaboration-round-release-is-one-barrier

// harn:assume open-collaboration-groups-reconcile-without-resurrection ref=collaboration-reconciliation-regression
describe('atomic collaboration participant skipping', () => {
  it('rolls back delivery consumption when the skipped-slot update fails', () => {
    const { owner } = openRoom(store);
    const alpha = store.addMember('eng', {
      kind: 'agent', handle: 'skip-alpha', display_name: 'Alpha', state: 'dead',
    });
    const beta = store.addMember('eng', {
      kind: 'agent', handle: 'skip-beta', display_name: 'Beta', state: 'idle',
    });
    const root = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: '@skip-alpha @skip-beta skip',
    });
    const round = store.createCollaborationGroup('eng', {
      groupId: 'skip-group',
      rootMessageId: root.id,
      participants: [
        { memberId: alpha.id, payloadSnapshot: 'alpha' },
        { memberId: beta.id, payloadSnapshot: 'beta' },
      ],
    });
    const alphaDelivery = round.deliveries[0]!;
    const blocker = new Database(join(dir, 'test.sqlite'));
    blocker.exec(`CREATE TRIGGER reject_skipped_participant
      BEFORE UPDATE OF terminal_status ON collaboration_participants
      WHEN NEW.delivery_id = '${alphaDelivery.id}'
      BEGIN SELECT RAISE(ABORT, 'injected skipped-slot failure'); END`);
    blocker.close();

    expect(() => store.skipCollaborationParticipant(
      'eng', alphaDelivery.id, '2026-07-14T13:20:00.000Z',
    )).toThrow('injected skipped-slot failure');
    expect(store.getDelivery('eng', alphaDelivery.id)?.state).toBe('queued');
    expect(store.findCollaborationParticipantByDelivery('eng', alphaDelivery.id)?.terminal_status)
      .toBeUndefined();
  });
});
// harn:end open-collaboration-groups-reconcile-without-resurrection

// harn:assume substantive-output-messages-drive-unread ref=message-activity-regression
// harn:assume human-room-read-cursors-are-durable-and-monotonic ref=durable-room-read-regression
describe('durable room read activity', () => {
  it('counts only incoming chat and finalized non-ack runs at their content edge', () => {
    const { owner, system } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Coder', state: 'idle',
    });
    const started = '2026-07-18T10:00:00.000Z';

    const incoming = store.postMessage('eng', {
      author: agent.id, kind: 'chat', body: 'first result',
    });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'my own note' });
    store.postMessage('eng', { author: system.id, kind: 'system', body: 'maintenance' });
    store.postMessage('eng', {
      author: agent.id, kind: 'ask', body: 'choose',
      ask: { interaction_id: 'ask-read', kind: 'ask', prompt: 'choose' },
    });
    store.postMessage('eng', {
      author: agent.id, kind: 'approval', body: 'approve',
      ask: { interaction_id: 'approval-read', kind: 'approval', prompt: 'approve' },
    });
    const run = store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: '',
      run: { status: 'running', started_ts: started, tool_calls: 0, events_ref: 'runs/read.jsonl' },
    });
    store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: '<ACK_OK>',
      ack: true,
      run: {
        status: 'completed', started_ts: started, ended_ts: started,
        tool_calls: 0, events_ref: 'runs/ack.jsonl', final_text: '<ACK_OK>',
      },
    });

    expect(store.countUnreadMessages('eng', owner.id)).toBe(1);
    store.setMessagePinned('eng', incoming.id, true);
    expect(store.countUnreadMessages('eng', owner.id)).toBe(1);

    store.updateMessage('eng', run.id, {
      body: 'second result',
      run: {
        ...run.run!, status: 'completed', ended_ts: started, final_text: 'second result',
      },
    });
    expect(store.countUnreadMessages('eng', owner.id)).toBe(2);

    store.deleteMessage('eng', incoming.id);
    expect(store.countUnreadMessages('eng', owner.id)).toBe(1);
    const read = store.markRoomRead('eng', owner.id, store.currentSeq('eng'));
    expect(read.read_seq).toBe(store.currentSeq('eng'));
    expect(store.countUnreadMessages('eng', owner.id)).toBe(0);

    const late = store.postMessage('eng', {
      author: agent.id,
      kind: 'run',
      body: '',
      run: { status: 'running', started_ts: started, tool_calls: 0, events_ref: 'runs/late.jsonl' },
    });
    store.markRoomRead('eng', owner.id, store.currentSeq('eng'));
    store.updateMessage('eng', late.id, {
      body: 'arrived after the read edge',
      run: {
        ...late.run!, status: 'completed', ended_ts: started,
        final_text: 'arrived after the read edge',
      },
    });
    expect(store.countUnreadMessages('eng', owner.id)).toBe(1);
  });

  it('advances monotonically, rejects the future, and clears visible consumed deliveries', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Coder', state: 'idle',
    });
    const body = 'Need @richard';
    const message = store.postMessage('eng', {
      author: agent.id,
      kind: 'chat',
      body,
      mentions: [{ member_id: owner.id, start: 5, end: 13 }],
    });
    const delivery = store.createDelivery('eng', {
      message_id: message.id, recipient: owner.id, state: 'consumed',
    });
    const through = store.currentSeq('eng');
    expect(store.roomSupport('eng', owner.id).inbox.map((item) => item.delivery.id))
      .toEqual([delivery.id]);

    const first = store.markRoomRead('eng', owner.id, through);
    expect(first.deliveries.map((item) => item.id)).toEqual([delivery.id]);
    expect(store.getDelivery('eng', delivery.id)?.read_ts).toBeDefined();
    expect(store.roomSupport('eng', owner.id).inbox).toEqual([]);

    expect(store.markRoomRead('eng', owner.id, through - 1)).toEqual({
      read_seq: through,
      deliveries: [],
    });
    expect(store.markRoomRead('eng', owner.id, through)).toEqual({
      read_seq: through,
      deliveries: [],
    });
    expect(() => store.markRoomRead('eng', owner.id, store.currentSeq('eng') + 1))
      .toThrow('ahead of current seq');
    expect(() => store.markRoomRead('eng', agent.id, through)).toThrow('no human member');
  });

  it('migrates legacy activity and baselines every existing and new human idempotently', () => {
    const { owner, system } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Coder', state: 'idle',
    });
    store.postMessage('eng', { author: agent.id, kind: 'chat', body: 'legacy result' });
    store.postMessage('eng', { author: system.id, kind: 'system', body: 'legacy notice' });
    store.postMessage('eng', {
      author: agent.id, kind: 'run', body: '<ACK_OK>', ack: true,
      run: {
        status: 'completed', started_ts: '2026-07-18T10:00:00.000Z',
        ended_ts: '2026-07-18T10:00:01.000Z', tool_calls: 0,
        events_ref: 'runs/legacy-ack.jsonl', final_text: '<ACK_OK>',
      },
    });
    const expectedMessages = store.listMessages('eng').length;
    const expectedSeq = store.currentSeq('eng');
    const path = join(dir, 'test.sqlite');
    store.close();

    const legacy = new Database(path);
    legacy.exec('DROP INDEX IF EXISTS message_unread_activity; DROP TABLE room_read_cursors; ALTER TABLE messages DROP COLUMN activity_seq;');
    legacy.close();

    store = new Store(path);
    expect(store.listMessages('eng')).toHaveLength(expectedMessages);
    expect(store.getRoomReadSeq('eng', owner.id)).toBe(expectedSeq);
    expect(store.countUnreadMessages('eng', owner.id)).toBe(0);
    const newcomer = store.addMember('eng', {
      kind: 'human', handle: 'viewer', display_name: 'Viewer', role: 'observer',
    });
    expect(store.getRoomReadSeq('eng', newcomer.id)).toBe(store.currentSeq('eng'));
    store.close();

    store = new Store(path);
    expect(store.getRoomReadSeq('eng', owner.id)).toBe(expectedSeq);
    expect(store.getRoomReadSeq('eng', newcomer.id)).toBe(store.currentSeq('eng'));
    const migrated = new Database(path, { readonly: true });
    const activities = migrated.prepare(
      'SELECT kind, ack, activity_seq FROM messages ORDER BY id',
    ).all() as { kind: string; ack: number; activity_seq: number | null }[];
    migrated.close();
    expect(activities.map((row) => row.activity_seq !== null)).toEqual([true, false, false]);
  });
});
// harn:end human-room-read-cursors-are-durable-and-monotonic
// harn:end substantive-output-messages-drive-unread

// harn:assume room-support-is-bounded-recipient-scoped-state ref=room-support-regression
// harn:assume actionable-inbox-clears-on-read-or-reply ref=actionable-inbox-regression
// harn:assume addressed-cold-hydration-is-strict-and-legacy-safe ref=addressed-hydration-regression
describe('recipient-scoped room support and strict addressed hydration', () => {
  it('keeps routing, live work, interactions, and actionable inbox outside the exact tail', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Coder', state: 'running',
    });
    const started = '2026-07-18T10:00:00.000Z';
    const live = store.postMessage('eng', {
      author: agent.id, kind: 'run', body: '',
      run: { status: 'running', started_ts: started, tool_calls: 0, events_ref: 'runs/live.jsonl' },
    });
    const card = store.postMessage('eng', {
      author: agent.id, kind: 'ask', body: 'Which path?',
      ask: { interaction_id: 'support-ask', kind: 'ask', prompt: 'Which path?' },
    });
    store.upsertInteraction({
      id: 'support-ask', room: 'eng', member_id: agent.id, message_id: card.id,
      native_id: 'native-support-ask', kind: 'ask', targets: [owner.id], state: 'pending',
    });
    const mentionBody = 'Review @richard';
    const mention = store.postMessage('eng', {
      author: agent.id,
      kind: 'chat',
      body: mentionBody,
      mentions: [{ member_id: owner.id, start: 7, end: 15 }],
    });
    const actionable = store.createDelivery('eng', {
      message_id: mention.id, recipient: owner.id, state: 'consumed',
    });
    const untagged = store.postMessage('eng', {
      author: agent.id, kind: 'chat', body: 'default-routed noise',
    });
    store.createDelivery('eng', {
      message_id: untagged.id, recipient: owner.id, state: 'consumed',
    });
    const finalized = store.postMessage('eng', {
      author: agent.id, kind: 'run', body: 'routing seed',
      run: {
        status: 'completed', started_ts: started, ended_ts: started,
        tool_calls: 0, events_ref: 'runs/final.jsonl', final_text: 'routing seed',
      },
    });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'tail one' });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'tail two' });
    store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'tail three' });

    const strict = store.sync('eng', 0, {
      hydrateLimit: 3, subscriber: owner.id, strictTail: true, supportFor: owner.id,
    });
    expect(strict.messages.map((message) => message.body)).toEqual(['tail one', 'tail two', 'tail three']);
    expect(strict.messages).toHaveLength(3);
    expect(strict.history_floor).toBe(strict.messages[0]?.id);
    expect(strict.support?.active_runs.map((message) => message.id)).toEqual([live.id]);
    expect(strict.support?.interactions.map((message) => message.id)).toEqual([card.id]);
    expect(strict.support?.latest_finalized_agent_id).toBe(agent.id);
    expect(strict.support?.inbox.map((item) => item.delivery.id)).toEqual([actionable.id]);
    expect(strict.support?.inbox[0]).toMatchObject({
      author_handle: 'coder', message_kind: 'chat', preview: mentionBody,
    });
    expect(strict.support?.summary.working).toBe(true);
    expect(strict.support?.summary.latest?.id).toBe(strict.messages.at(-1)?.id);

    const legacy = store.sync('eng', 0, { hydrateLimit: 3, subscriber: owner.id });
    expect(legacy.messages.length).toBeGreaterThan(3);
    expect(legacy.messages.map((message) => message.id)).toContain(live.id);
    expect(legacy.messages.map((message) => message.id)).toContain(card.id);
    expect(legacy.messages.map((message) => message.id)).toContain(finalized.id);
    expect(legacy.support).toBeUndefined();
  });

  it('removes mention work after a formal self reply and bounds every preview', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'coder', display_name: 'Coder', state: 'idle',
    });
    const body = `@richard ${'x'.repeat(300)}`;
    const source = store.postMessage('eng', {
      author: agent.id,
      kind: 'chat',
      body,
      mentions: [{ member_id: owner.id, start: 0, end: 8 }],
    });
    store.createDelivery('eng', {
      message_id: source.id, recipient: owner.id, state: 'consumed',
    });
    expect(store.roomSupport('eng', owner.id).inbox[0]?.preview).toHaveLength(140);
    store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: 'Handled', reply_to: source.id,
    });
    expect(store.roomSupport('eng', owner.id).inbox).toEqual([]);
  });
});
// harn:end addressed-cold-hydration-is-strict-and-legacy-safe
// harn:end actionable-inbox-clears-on-read-or-reply
// harn:end room-support-is-bounded-recipient-scoped-state

// harn:assume member-task-projection-is-durable-and-session-scoped ref=member-task-store-regression
describe('member task projection', () => {
  const agentWith = (sessionRef?: string) => {
    openRoom(store);
    return store.addMember('eng', {
      kind: 'agent', handle: 'tasker', display_name: 'Tasker', state: 'idle',
      ...(sessionRef !== undefined && { session_ref: sessionRef, harness: 'codex' }),
    });
  };

  it('materializes an ordered replace and is idempotent on duplicate delivery', () => {
    const agent = agentWith();
    const update = { op: 'replace' as const, items: [
      { id: 'a', content: 'First', status: 'in_progress' as const },
      { id: 'b', content: 'Second', status: 'pending' as const },
    ] };
    expect(store.applyMemberTaskUpdate('eng', agent.id, update)?.tasks?.items.map((task) => task.id)).toEqual(['a', 'b']);
    expect(store.applyMemberTaskUpdate('eng', agent.id, update)).toBeUndefined();
  });

  it('upserts a known id in place and appends only complete new patches', () => {
    const agent = agentWith();
    store.applyMemberTaskUpdate('eng', agent.id, { op: 'replace', items: [{ id: 'a', content: 'A', status: 'pending' }] });
    const updated = store.applyMemberTaskUpdate('eng', agent.id, { op: 'upsert', items: [
      { id: 'a', status: 'completed' },
      { id: 'c', content: 'C', status: 'pending' },
      { id: 'ghost', status: 'completed' },
    ] });
    expect(updated?.tasks?.items).toEqual([
      { id: 'a', content: 'A', status: 'completed' },
      { id: 'c', content: 'C', status: 'pending' },
    ]);
  });

  it('clears on an authoritative empty replacement and persists across reopen', () => {
    const agent = agentWith();
    store.applyMemberTaskUpdate('eng', agent.id, { op: 'replace', items: [{ id: 'a', content: 'A', status: 'pending' }] });
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getMember('eng', agent.id)?.tasks?.items).toHaveLength(1);
    expect(store.applyMemberTaskUpdate('eng', agent.id, { op: 'replace', items: [] })?.tasks).toBeUndefined();
    expect(store.getMember('eng', agent.id)?.tasks).toBeUndefined();
  });

  it('preserves tasks on a same-session update but clears on a different native session', () => {
    const agent = agentWith('sess-1');
    store.applyMemberTaskUpdate('eng', agent.id, { op: 'replace', items: [{ id: 'a', content: 'A', status: 'pending' }] });
    expect(store.setAgentSessionRuntime('eng', agent.id, 'sess-1', { load: true, resume: true }).tasks?.items).toHaveLength(1);
    expect(store.setAgentSessionRuntime('eng', agent.id, 'sess-2', { load: true, resume: true }).tasks).toBeUndefined();
  });

  it('rejects an over-bound materialized list rather than partially landing it', () => {
    const agent = agentWith();
    store.applyMemberTaskUpdate('eng', agent.id, { op: 'replace', items: [{ id: 'a', content: 'A', status: 'pending' }] });
    const many = Array.from({ length: 100 }, (_, index) => ({ id: `n${String(index)}`, content: 'x', status: 'pending' as const }));
    expect(store.applyMemberTaskUpdate('eng', agent.id, { op: 'upsert', items: many })).toBeUndefined();
    expect(store.getMember('eng', agent.id)?.tasks?.items).toHaveLength(1);
  });
});
// harn:end member-task-projection-is-durable-and-session-scoped

// harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=clear-context-store-transaction
describe('agent context reset transaction', () => {
  it('clears only session-scoped state in one member change', () => {
    const { owner } = openRoom(store);
    const agent = store.addMember('eng', {
      kind: 'agent', handle: 'resettable', display_name: 'Resettable', purpose: 'keep purpose',
      harness: 'acp', session_ref: 'native-old', cwd: '/work', policy: 'workspace-write',
      model: 'kept-model', thinking: 'high', state: 'idle', custody: 'owned',
      roster_stale: false,
    }, {
      acp_launch: { executable: 'agent', argv: ['acp', '--profile=keep'] },
      lifecycle: { load: true, resume: true },
      usage_baseline: { totalTokens: 30, inputTokens: 20, outputTokens: 10 },
    });
    store.updateMember('eng', agent.id, {
      misaddressed: true,
      conventions_sent: true,
      limits: [{ window: 'weekly', status: 'allowed', used_percent: 20 }],
    });
    store.applyMemberTaskUpdate('eng', agent.id, {
      op: 'replace', items: [{ id: 't', content: 'Old session task', status: 'pending' }],
    });
    store.setMemberContextWindow('eng', agent.id, 1_000_000);
    store.setAgentCredentialHash('eng', agent.id, 'a'.repeat(64));
    store.stageAgentUsageBaseline('eng', agent.id, 7, {
      totalTokens: 40, inputTokens: 25, outputTokens: 15,
    });
    const history = store.postMessage('eng', { author: owner.id, kind: 'chat', body: 'keep history' });
    const changesBefore = (store.db.prepare('SELECT COUNT(*) AS count FROM changes WHERE room_id = ?')
      .get('eng') as { count: number }).count;

    const cleared = store.clearAgentContext('eng', agent.id);

    expect(cleared).toMatchObject({
      id: agent.id, handle: 'resettable', purpose: 'keep purpose', harness: 'acp', cwd: '/work',
      policy: 'workspace-write', model: 'kept-model', thinking: 'high', state: 'idle',
      custody: 'owned', misaddressed: true, conventions_sent: false, roster_stale: true,
      limits: [{ window: 'weekly', status: 'allowed', used_percent: 20 }],
    });
    expect(cleared.session_ref).toBeUndefined();
    expect(cleared.tasks).toBeUndefined();
    expect(store.getMemberContextWindow('eng', agent.id)).toBeUndefined();
    expect(store.findAgentByCredentialHash('a'.repeat(64))).toBeUndefined();
    expect(store.getAgentRuntimeConfig('eng', agent.id)).toEqual({
      acp_launch: { executable: 'agent', argv: ['acp', '--profile=keep'] },
    });
    expect(store.getMessage('eng', history.id)?.body).toBe('keep history');
    const raw = store.db.prepare(
      'SELECT session_ref, session_lifecycle, acp_usage_baseline, acp_usage_pending, context_window, credential_hash, tasks FROM members WHERE id = ?',
    ).get(agent.id) as Record<string, unknown>;
    expect(Object.values(raw)).toEqual([null, null, null, null, null, null, null]);
    const changesAfter = (store.db.prepare('SELECT COUNT(*) AS count FROM changes WHERE room_id = ?')
      .get('eng') as { count: number }).count;
    expect(changesAfter - changesBefore).toBe(1);
  });
});
// harn:end member-context-reset-is-authorized-atomic-and-lazy

// harn:assume named-acp-provider-selection-resolves-to-private-structured-launch ref=acp-provider-store-regression
describe('a named ACP provider persists a public id while its launch stays private', () => {
  it('projects acp_provider publicly, keeps acp_launch private, and survives reopen', () => {
    openRoom(store);
    const path = join(dir, 'test.sqlite');
    const member = store.addMember('eng', {
      kind: 'agent', handle: 'kimo', display_name: 'Kimo', state: 'idle',
      harness: 'acp', acp_provider: 'kimi',
    }, { acp_launch: { executable: 'kimi', argv: ['acp'] } });

    // Public projection carries the safe id and never the command.
    expect(store.getMember('eng', member.id)?.acp_provider).toBe('kimi');
    expect(store.getMember('eng', member.id)).not.toHaveProperty('acp_launch');
    // The exact launch is retrievable only through the private runtime accessor.
    expect(store.getAgentRuntimeConfig('eng', member.id)?.acp_launch)
      .toEqual({ executable: 'kimi', argv: ['acp'] });

    // Reopening the database preserves both the public id and the private launch.
    store.close();
    const reopened = new Store(path);
    expect(reopened.getMember('eng', member.id)?.acp_provider).toBe('kimi');
    expect(reopened.getMember('eng', member.id)).not.toHaveProperty('acp_launch');
    expect(reopened.getAgentRuntimeConfig('eng', member.id)?.acp_launch)
      .toEqual({ executable: 'kimi', argv: ['acp'] });
    reopened.close();
  });

  it('leaves the public provider id untouched through an ordinary config edit', () => {
    openRoom(store);
    const member = store.addMember('eng', {
      kind: 'agent', handle: 'kimo', display_name: 'Kimo', state: 'idle',
      harness: 'acp', acp_provider: 'kimi',
    }, { acp_launch: { executable: 'kimi', argv: ['acp'] } });
    store.updateMember('eng', member.id, { policy: 'read-only' });
    expect(store.getMember('eng', member.id)?.acp_provider).toBe('kimi'); // locked identity
    expect(store.getAgentRuntimeConfig('eng', member.id)?.acp_launch)
      .toEqual({ executable: 'kimi', argv: ['acp'] }); // private launch untouched
  });
});
// harn:end named-acp-provider-selection-resolves-to-private-structured-launch

const mainObs = (over: Partial<WorktreeObservation> = {}): WorktreeObservation => ({
  path: join(dir, 'repo'),
  git_admin_id: join(dir, 'repo', '.git'),
  primary: true,
  availability: 'available',
  locked: false,
  ...over,
});

const childObs = (name: string, over: Partial<WorktreeObservation> = {}): WorktreeObservation => ({
  path: join(dir, name),
  git_admin_id: join(dir, 'repo', '.git', 'worktrees', name),
  primary: false,
  availability: 'available',
  locked: false,
  branch: `feature/${name}`,
  ...over,
});

const repoObs = () => ({
  common_path: join(dir, 'repo', '.git'),
  primary_path: join(dir, 'repo'),
  primary_git_admin_id: join(dir, 'repo', '.git'),
});

// harn:assume readable-branch-conversations-own-worktree-identity ref=readable-worktree-conversation-regression
describe('readable worktree conversation identity', () => {
  it('keeps root and full branch readable, stable, bounded, and collision-safe', () => {
    const scheduled = deterministicWorktreeConversationId('codor-main', 'feat/scheduled-messages');
    expect(scheduled).toMatch(/^codor-main-feat-scheduled-messages-[0-9a-f]{8}$/);
    expect(deterministicWorktreeConversationId('codor-main', 'feature')).toBe('codor-main-feature');
    expect(deterministicWorktreeConversationId('codor-main', 'feat/foo'))
      .not.toBe(deterministicWorktreeConversationId('codor-main', 'feat-foo'));
    expect(deterministicWorktreeConversationId('codor-main', 'feat/foo')).toBe(
      deterministicWorktreeConversationId('codor-main', 'feat/foo'),
    );
    const long = deterministicWorktreeConversationId('a'.repeat(63), `feature/${'b'.repeat(255)}`);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^a+-feature-b+-[0-9a-f]{8}$/);
  });

  it('registers normalized, case, and truncated branch collisions side by side', () => {
    openRoom(store);
    const common = `feature/${'long-prefix-'.repeat(6)}`;
    const branches = [
      'feat/foo',
      'feat-foo',
      'FEAT/FOO',
      `${common}one`,
      `${common}two`,
    ];
    const registered = branches.map((branch, index) => store.registerWorktree(
      'eng',
      repoObs(),
      mainObs(),
      childObs(`collision-${index}`, { branch }),
      'ignored',
      'adopted',
    ).worktree);

    expect(new Set(registered.map((entry) => entry.alias)).size).toBe(branches.length);
    expect(new Set(registered.map((entry) => entry.conversation_id)).size).toBe(branches.length);
    expect(registered.map((entry) => store.getRoom(entry.conversation_id)?.name)).toEqual(branches);
    expect(store.listWorktrees('eng').filter((entry) => !entry.primary).map((entry) => entry.branch).sort())
      .toEqual([...branches].sort());
  });
});
// harn:end readable-branch-conversations-own-worktree-identity

// harn:assume existing-worktree-records-repair-locally-once ref=local-worktree-record-repair-regression
describe('one-time local worktree conversation repair', () => {
  const roomTables = [
    'members', 'messages', 'deliveries', 'collaboration_groups', 'pending_interactions',
    'meters', 'mirrored_turns', 'attach_leases',
  ] as const;

  const rewriteAsLegacy = (databasePath: string, current: string, legacy: string): void => {
    const raw = new Database(databasePath);
    raw.pragma('foreign_keys = OFF');
    raw.transaction(() => {
      for (const table of roomTables) raw.prepare(`UPDATE ${table} SET room = ? WHERE room = ?`).run(legacy, current);
      raw.prepare('UPDATE messages SET author_conversation_id = ? WHERE author_conversation_id = ?')
        .run(legacy, current);
      raw.prepare('UPDATE deliveries SET target_conversation_id = ? WHERE target_conversation_id = ?')
        .run(legacy, current);
      raw.prepare('UPDATE changes SET room_id = ? WHERE room_id = ?').run(legacy, current);
      raw.prepare('UPDATE room_read_cursors SET room = ? WHERE room = ?').run(legacy, current);
      raw.prepare('UPDATE worktrees SET conversation_id = ?, alias = ? WHERE conversation_id = ?')
        .run(legacy, 'legacy-child', current);
      raw.prepare('UPDATE rooms SET id = ? WHERE id = ?').run(legacy, current);
    })();
    raw.close();
  };

  it('moves every room-keyed row and known directory once without changing Git identity', () => {
    openRoom(store);
    const registered = store.registerWorktree(
      'eng', repoObs(), mainObs(), childObs('repair'), 'ignored', 'created',
    );
    const current = registered.worktree.conversation_id;
    const legacy = 'wt-legacy-repair-child';
    const agent = store.addMember(current, {
      kind: 'agent', handle: 'repair-agent', display_name: 'Repair Agent', state: 'idle',
    });
    const target = {
      worktree_id: registered.worktree.id,
      conversation_id: current,
      member_id: agent.id,
      alias: registered.worktree.alias,
      handle: agent.handle,
    } as const;
    const message = store.postMessage(current, {
      author: agent.id, author_target: target, kind: 'chat', body: 'repair me',
    });
    store.createDelivery(current, { message_id: message.id, recipient: agent.id, target });
    store.close();

    const databasePath = join(dir, 'test.sqlite');
    const seeded = new Database(databasePath);
    seeded.prepare(
      `INSERT INTO collaboration_groups (id, room, root_message_id, state, created_ts)
       VALUES ('repair-group', ?, ?, 'open', '2026-08-11T00:00:00.000Z')`,
    ).run(current, message.id);
    seeded.prepare(
      `INSERT INTO pending_interactions
       (id, room, member_id, message_id, native_id, kind, targets, state)
       VALUES ('repair-interaction', ?, ?, ?, 'native-repair', 'ask', '[]', 'pending')`,
    ).run(current, agent.id, message.id);
    seeded.prepare(
      `INSERT INTO meters (room, day, turns, cost_usd, estimated_cost_usd, input_tokens, output_tokens)
       VALUES (?, '2026-08-11', 1, 0, 0, 2, 3)`,
    ).run(current);
    seeded.prepare(
      `INSERT INTO mirrored_turns (room, member_id, native_turn_id, message_id)
       VALUES (?, ?, 'native-turn', ?)`,
    ).run(current, agent.id, message.id);
    seeded.prepare(
      `INSERT INTO attach_leases (id, room, member_id, cli_pid, heartbeat_ts)
       VALUES ('repair-lease', ?, ?, 123, 1)`,
    ).run(current, agent.id);
    seeded.close();

    rewriteAsLegacy(databasePath, current, legacy);
    const roomDataRoots = ['blobs', 'attachments', 'artifacts', 'artifact-errors']
      .map((name) => join(dir, name));
    for (const root of roomDataRoots) {
      const legacyDir = join(root, legacy);
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, 'evidence.txt'), root);
    }

    store = new Store(databasePath, { roomDataRoots });
    const repaired = store.getWorktree('eng', registered.worktree.id)!;
    expect(repaired).toMatchObject({
      conversation_id: current,
      path: registered.worktree.path,
      branch: registered.worktree.branch,
    });
    const verified = new Database(databasePath, { readonly: true });
    for (const table of roomTables) {
      expect((verified.prepare(`SELECT count(*) AS count FROM ${table} WHERE room = ?`).get(current) as { count: number }).count)
        .toBeGreaterThan(0);
      expect((verified.prepare(`SELECT count(*) AS count FROM ${table} WHERE room = ?`).get(legacy) as { count: number }).count)
        .toBe(0);
    }
    expect((verified.prepare('SELECT count(*) AS count FROM changes WHERE room_id = ?').get(legacy) as { count: number }).count).toBe(0);
    expect((verified.prepare('SELECT count(*) AS count FROM room_read_cursors WHERE room = ?').get(legacy) as { count: number }).count).toBe(0);
    expect((verified.prepare('SELECT count(*) AS count FROM messages WHERE author_conversation_id = ?').get(current) as { count: number }).count).toBe(1);
    expect((verified.prepare('SELECT count(*) AS count FROM deliveries WHERE target_conversation_id = ?').get(current) as { count: number }).count).toBe(1);
    verified.close();
    for (const root of roomDataRoots) {
      expect(existsSync(join(root, legacy))).toBe(false);
      expect(readFileSync(join(root, current, 'evidence.txt'), 'utf8')).toBe(root);
    }

    const beforeSecondOpen = JSON.stringify({
      worktree: repaired,
      room: store.getRoom(current),
      messages: store.listMessages(current),
    });
    store.close();
    store = new Store(databasePath, { roomDataRoots });
    expect(JSON.stringify({
      worktree: store.getWorktree('eng', registered.worktree.id),
      room: store.getRoom(current),
      messages: store.listMessages(current),
    })).toBe(beforeSecondOpen);
  });

  it('fails closed when a readable database or directory destination already exists', () => {
    openRoom(store);
    const registered = store.registerWorktree(
      'eng', repoObs(), mainObs(), childObs('conflict'), 'ignored', 'created',
    );
    const current = registered.worktree.conversation_id;
    const legacy = 'wt-legacy-conflict-child';
    store.close();
    rewriteAsLegacy(join(dir, 'test.sqlite'), current, legacy);
    const root = join(dir, 'blobs');
    mkdirSync(join(root, legacy), { recursive: true });
    mkdirSync(join(root, current), { recursive: true });
    writeFileSync(join(root, legacy, 'legacy.txt'), 'legacy');
    writeFileSync(join(root, current, 'destination.txt'), 'destination');

    expect(() => new Store(join(dir, 'test.sqlite'), { roomDataRoots: [root] }))
      .toThrow(/destination already exists|conversation already exists/);
    expect(readFileSync(join(root, legacy, 'legacy.txt'), 'utf8')).toBe('legacy');
    expect(readFileSync(join(root, current, 'destination.txt'), 'utf8')).toBe('destination');
    const raw = new Database(join(dir, 'test.sqlite'), { readonly: true });
    expect((raw.prepare('SELECT conversation_id FROM worktrees WHERE id = ?').get(registered.worktree.id) as { conversation_id: string }).conversation_id)
      .toBe(legacy);
    expect(raw.prepare('SELECT id FROM rooms WHERE id = ?').get(legacy)).toBeDefined();
    raw.close();
  });
});
// harn:end existing-worktree-records-repair-locally-once

// harn:assume worktree-alias-and-child-metadata-follow-stable-identity ref=worktree-child-metadata-regression
// harn:assume registered-worktrees-materialize-stable-conversations ref=worktree-conversation-store-regression
describe('worktree child metadata follows stable identity', () => {
  it('creates children with the canonical cwd and no root starting handle', () => {
    store.createRoom({
      id: 'eng',
      name: 'Engineering',
      owner: { handle: 'richard', display_name: 'Richard' },
      config: { cwd: join(dir, 'repo'), starting_agent_handle: 'alpha' },
    });
    const rootBefore = store.getRoom('eng')!;
    const { worktree } = store.registerWorktree('eng', repoObs(), mainObs(), childObs('child'), 'child-label', 'created');
    const child = store.getRoom(worktree.conversation_id)!;
    expect(child.name).toBe('feature/child');
    expect(child.config.cwd).toBe(join(dir, 'child'));
    expect(child.config.starting_agent_handle).toBeUndefined();
    expect(store.getRoom('eng')).toEqual(rootBefore);
  });

  it('migrates a legacy child projection idempotently on reopen', () => {
    openRoom(store);
    const { worktree } = store.registerWorktree('eng', repoObs(), mainObs(), childObs('child'), 'child-label', 'created');
    // Simulate a Phase-1-era child: root config copied verbatim with a leaked handle.
    const legacyConfig = { ...store.getRoom('eng')!.config, starting_agent_handle: 'alpha' };
    const raw = new Database(join(dir, 'test.sqlite'));
    raw.prepare('UPDATE rooms SET config = ? WHERE id = ?')
      .run(JSON.stringify(legacyConfig), worktree.conversation_id);
    raw.close();
    const rootBefore = JSON.stringify(store.getRoom('eng'));
    const childSeqBefore = store.currentSeq(worktree.conversation_id);

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    const migrated = store.getRoom(worktree.conversation_id)!;
    expect(migrated.config.starting_agent_handle).toBeUndefined();
    expect(migrated.config.cwd).toBe(join(dir, 'child'));
    expect(store.currentSeq(worktree.conversation_id)).toBe(childSeqBefore + 1);
    expect(JSON.stringify(store.getRoom('eng'))).toBe(rootBefore);

    // A second open finds no drift: no further change rows.
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.currentSeq(worktree.conversation_id)).toBe(childSeqBefore + 1);
  });

  it('reconciles a moved canonical path on re-adoption and keeps history stable', () => {
    openRoom(store);
    const first = store.registerWorktree('eng', repoObs(), mainObs(), childObs('child'), 'child-label', 'created');
    const conversation = first.worktree.conversation_id;
    store.postMessage(conversation, {
      author: store.getMemberByHandle('eng', 'richard')!.id,
      kind: 'chat',
      body: 'child history',
    });
    store.unregisterWorktree('eng', first.worktree.id, '2026-08-06T00:06:00.000Z');
    const readopted = store.registerWorktree(
      'eng',
      repoObs(),
      mainObs(),
      { ...childObs('child'), path: join(dir, 'moved-child') },
      'child-label',
      'adopted',
      '2026-08-06T00:07:00.000Z',
    );
    expect(readopted.worktree.id).toBe(first.worktree.id);
    expect(readopted.worktree.conversation_id).toBe(conversation);
    expect(readopted.seeded).toEqual([]);
    expect(store.getRoom(conversation)?.config.cwd).toBe(join(dir, 'moved-child'));
    expect(store.listMessages(conversation).map((message) => message.body)).toEqual(['child history']);
  });

  it('orders actives main-first by alias and excludes tombstones through reopen', () => {
    openRoom(store);
    store.registerWorktree('eng', repoObs(), mainObs(), childObs('bravo'), 'bravo', 'created');
    store.registerWorktree('eng', repoObs(), mainObs(), childObs('alpha'), 'alpha', 'created');
    const alphaAlias = worktreeSelectorFromBranch('feature/alpha');
    const bravoAlias = worktreeSelectorFromBranch('feature/bravo');
    expect(store.listRegisteredWorktrees('eng').map((worktree) => worktree.alias))
      .toEqual(['main', alphaAlias, bravoAlias]);
    const alpha = store.listRegisteredWorktrees('eng').find((worktree) => worktree.alias === alphaAlias)!;
    store.unregisterWorktree('eng', alpha.id, '2026-08-06T00:04:00.000Z');
    expect(store.listRegisteredWorktrees('eng').map((worktree) => worktree.alias))
      .toEqual(['main', bravoAlias]);
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.listRegisteredWorktrees('eng').map((worktree) => worktree.alias))
      .toEqual(['main', bravoAlias]);
    const withTombstones = store.listWorktrees('eng', { includeTombstones: true });
    expect(withTombstones.map((worktree) => worktree.alias)).toEqual(['main', alphaAlias, bravoAlias]);
    expect(withTombstones.find((worktree) => worktree.alias === alphaAlias))
      .toMatchObject({ id: alpha.id, lifecycle: 'unregistered' });
  });

  it('derives immutable routing identity from the branch', () => {
    openRoom(store);
    const { worktree } = store.registerWorktree('eng', repoObs(), mainObs(), childObs('child'), 'child-label', 'created');
    expect(worktree.alias).toBe(worktreeSelectorFromBranch('feature/child'));
    expect(store.getRoom(worktree.conversation_id)?.name).toBe('feature/child');
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getWorktree('eng', worktree.id)).toMatchObject({
      alias: worktreeSelectorFromBranch('feature/child'), branch: 'feature/child', conversation_id: worktree.conversation_id,
    });
  });

  it('preserves child-local configuration through reopen, tombstone, and re-adoption', () => {
    openRoom(store);
    const { worktree } = store.registerWorktree('eng', repoObs(), mainObs(), childObs('child'), 'child-label', 'created');
    const child = worktree.conversation_id;
    // Room-local state the reconciliation must never touch.
    store.updateRoomConfig(child, {
      turn_brake: 3,
      spend_brake_usd: 5,
      stall_minutes: 9,
      redaction_enabled: false,
      color: '#a1b2c3',
      bridged: true,
    });
    const localConfig = store.getRoom(child)!.config;
    expect(localConfig).toMatchObject({
      turn_brake: 3,
      spend_brake_usd: 5,
      stall_minutes: 9,
      redaction_enabled: false,
      color: '#a1b2c3',
      bridged: true,
      cwd: join(dir, 'child'),
    });
    const rootBefore = JSON.stringify(store.getRoom('eng'));

    // Active reopen: migration finds no drift and preserves everything.
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getRoom(child)!.config).toEqual(localConfig);

    // Tombstone reopen: inactive mapped children keep their room-local state.
    store.unregisterWorktree('eng', worktree.id, '2026-08-06T01:00:00.000Z');
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.getRoom(child)!.config).toEqual(localConfig);

    // Re-adoption at a moved path patches ONLY the canonical cwd (and name).
    store.registerWorktree(
      'eng',
      repoObs(),
      mainObs(),
      { ...childObs('child'), path: join(dir, 'moved-child') },
      'ignored-legacy-selector',
      'adopted',
      '2026-08-06T01:01:00.000Z',
    );
    const readopted = store.getRoom(child)!;
    expect(readopted.config).toEqual({ ...localConfig, cwd: join(dir, 'moved-child') });
    expect(readopted.name).toBe('feature/child');

    // The root never moved.
    expect(JSON.stringify(store.getRoom('eng'))).toBe(rootBefore);
  });

  it('does not append a child change when branch metadata is already canonical', () => {
    openRoom(store);
    const { worktree } = store.registerWorktree('eng', repoObs(), mainObs(), childObs('child'), 'child-label', 'created');
    const seqBefore = store.currentSeq(worktree.conversation_id);
    store.registerWorktree('eng', repoObs(), mainObs(), childObs('child'), 'ignored', 'adopted');
    expect(store.currentSeq(worktree.conversation_id)).toBe(seqBefore);
  });
});
// harn:end registered-worktrees-materialize-stable-conversations
// harn:end worktree-alias-and-child-metadata-follow-stable-identity

// harn:assume worktree-lifecycle-preserves-existing-state-by-default ref=worktree-root-neutral-regression
describe('root-neutral registration', () => {
  it('leaves root room, roster, history, config, presets, and roster unchanged across lifecycle', () => {
    openRoom(store);
    store.postMessage('eng', {
      author: store.getMemberByHandle('eng', 'richard')!.id,
      kind: 'chat',
      body: 'root history',
    });
    const preset = store.createAgentPreset({ label: 'Alpha', handle: 'alpha', harness: 'fake' });
    store.replaceDefaultRoster([preset.id]);
    const snapshot = () => JSON.stringify({
      room: store.getRoom('eng'),
      members: store.listMembers('eng', { includeRemoved: true }),
      messages: store.listMessages('eng'),
      presets: store.listAgentPresets(),
      roster: store.getDefaultRoster(),
    });
    const before = snapshot();
    const first = store.registerWorktree('eng', repoObs(), mainObs(), childObs('child'), 'child-label', 'created');
    store.unregisterWorktree('eng', first.worktree.id);
    store.registerWorktree('eng', repoObs(), mainObs(), childObs('child'), 'child-label', 'adopted');
    store.removeWorktree('eng', first.worktree.id);
    expect(snapshot()).toBe(before);
  });
});
// harn:end worktree-lifecycle-preserves-existing-state-by-default

// harn:assume worktree-child-default-roster-is-an-explicit-snapshot ref=child-default-roster-store-regression
// harn:assume default-roster-channel-members-are-detached-ordered-snapshots ref=default-roster-room-seed-regression
// harn:assume default-roster-channel-members-are-detached-ordered-snapshots ref=default-roster-snapshot-regression
describe('child default roster seeding', () => {
  const makeSeed = (handle: string): import('./store.js').InitialAgent => ({
    member: {
      kind: 'agent',
      handle,
      display_name: handle,
      harness: 'fake',
      cwd: join(dir, 'child'),
      policy: 'read-only',
      host: 'test-host',
      state: 'dead',
      custody: 'owned',
    },
  });

  it('seeds ordered detached members only into a brand-new child and survives reopen', () => {
    openRoom(store);
    const seed = [makeSeed('alpha'), makeSeed('beta')];
    const first = store.registerWorktree(
      'eng', repoObs(), mainObs(), childObs('child'), 'child-label', 'created',
      '2026-08-06T00:08:00.000Z', seed,
    );
    expect(first.seeded.map((member) => member.handle)).toEqual(['alpha', 'beta']);
    expect(first.seeded.every((member) => member.state === 'dead' && member.custody === 'owned'))
      .toBe(true);
    // The roster ORDER lives in the seeded registration result above; the
    // durable member set is id-sorted, so compare it order-insensitively.
    expect(
      store.listMembers(first.worktree.conversation_id)
        .filter((member) => member.kind === 'agent')
        .map((member) => member.handle)
        .sort(),
    ).toEqual(['alpha', 'beta']);
    // Root roster untouched: no agent rows leak into the root.
    expect(store.listMembers('eng').filter((member) => member.kind === 'agent')).toEqual([]);

    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(
      store.listMembers(first.worktree.conversation_id)
        .filter((member) => member.kind === 'agent')
        .map((member) => member.handle)
        .sort(),
    ).toEqual(['alpha', 'beta']);

    // Re-adoption of the same admin identity seeds nothing again.
    store.unregisterWorktree('eng', first.worktree.id, '2026-08-06T00:09:00.000Z');
    const readopted = store.registerWorktree(
      'eng', repoObs(), mainObs(), childObs('child'), 'child-label', 'adopted',
      '2026-08-06T00:10:00.000Z', seed,
    );
    expect(readopted.seeded).toEqual([]);
    expect(
      store.listMembers(first.worktree.conversation_id)
        .filter((member) => member.kind === 'agent'),
    ).toHaveLength(2);
  });

  it('keeps child snapshots detached from later preset and roster edits', () => {
    openRoom(store);
    const preset = store.createAgentPreset({ label: 'Alpha', handle: 'alpha', harness: 'fake', model: 'm-1' });
    store.replaceDefaultRoster([preset.id]);
    const first = store.registerWorktree(
      'eng', repoObs(), mainObs(), childObs('child'), 'child-label', 'created',
      '2026-08-06T00:11:00.000Z',
      [{
        member: {
          kind: 'agent', handle: 'alpha', display_name: 'alpha', harness: 'fake',
          cwd: join(dir, 'child'), policy: 'read-only', model: 'm-1',
          host: 'test-host', state: 'dead', custody: 'owned',
        },
      }],
    );
    store.updateAgentPreset(preset.id, { label: 'Alpha', handle: 'alpha', harness: 'fake', model: 'm-2' });
    store.replaceDefaultRoster([]);
    const member = store.getMember(first.worktree.conversation_id, first.seeded[0]!.id)!;
    expect(member.handle).toBe('alpha');
    expect(member.model).toBe('m-1');
  });
});
// harn:end default-roster-channel-members-are-detached-ordered-snapshots
// harn:end default-roster-channel-members-are-detached-ordered-snapshots
// harn:end worktree-child-default-roster-is-an-explicit-snapshot

// harn:assume qualified-execution-requires-usable-checkout ref=qualified-target-usability-store-regression
describe('qualified target usability and stable identity', () => {
  it('keeps accepted branch identity stable while requiring usable checkouts', () => {
    openRoom(store);
    const registered = store.registerWorktree(
      'eng', repoObs(), mainObs(), childObs('child'), 'old-label', 'adopted',
    );
    const child = registered.worktree.conversation_id;
    const member = store.addMember(child, {
      kind: 'agent', handle: 'stable-agent', display_name: 'Stable Agent', state: 'idle',
    });
    const acceptedTarget = {
      worktree_id: registered.worktree.id,
      conversation_id: child,
      member_id: member.id,
      alias: 'child',
      handle: member.handle,
    } as const;
    const owner = store.getMemberByHandle('eng', 'richard')!;
    const acceptedMessage = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: 'accepted before metadata changed',
    });
    const accepted = store.createDelivery('eng', {
      message_id: acceptedMessage.id, recipient: member.id, target: acceptedTarget,
    });

    store.refreshWorktreeObservation('eng', registered.worktree.id, {
      ...childObs('child'),
      path: join(dir, 'moved-child'),
    });
    expect(store.routingTargetIsActive(acceptedTarget, 'eng')).toBe(true);

    // The stable target remains valid over a store restart and keeps its old
    // alias only as historical delivery attribution.
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    expect(store.routingTargetIsActive(acceptedTarget, 'eng')).toBe(true);
    expect(store.getDelivery('eng', accepted.id)?.target).toEqual(acceptedTarget);

    const newMessage = store.postMessage('eng', {
      author: owner.id, kind: 'chat', body: 'new message after alias change',
    });
    const currentTarget = { ...acceptedTarget };
    expect(store.createDelivery('eng', {
      message_id: newMessage.id, recipient: member.id, target: currentTarget,
    }).target).toEqual(currentTarget);

    for (const availability of ['available', 'locked'] as const) {
      store.refreshWorktreeObservation('eng', registered.worktree.id, {
        ...childObs('child'),
        path: join(dir, 'moved-child'),
        availability,
        locked: availability === 'locked',
      });
      expect(store.routingTargetIsActive(acceptedTarget, 'eng')).toBe(true);
    }
    for (const availability of ['missing', 'prunable'] as const) {
      store.refreshWorktreeObservation('eng', registered.worktree.id, {
        ...childObs('child'),
        path: join(dir, 'moved-child'),
        availability,
        locked: false,
      });
      expect(store.routingTargetIsActive(acceptedTarget, 'eng')).toBe(false);
    }
  });
});
// harn:end qualified-execution-requires-usable-checkout
