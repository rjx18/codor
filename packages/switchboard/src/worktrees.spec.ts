import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store } from './store.js';
import { WorktreeManager } from './worktrees.js';

let fixtureRoot: string;
let repositoryPath: string;
let store: Store;
let manager: WorktreeManager;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function makeFixture(): void {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'codor-worktree-fixture-'));
  repositoryPath = join(fixtureRoot, 'primary checkout with spaces');
  mkdirSync(repositoryPath, { recursive: true });
  git(repositoryPath, ['init', '-q', '-b', 'main']);
  git(repositoryPath, ['config', 'user.email', 'fixture@example.test']);
  git(repositoryPath, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(repositoryPath, 'README.md'), 'fixture\n');
  git(repositoryPath, ['add', 'README.md']);
  git(repositoryPath, ['commit', '-qm', 'fixture']);
  store = new Store(join(fixtureRoot, 'codor.sqlite'));
  store.createRoom({
    id: 'eng',
    name: 'Engineering',
    owner: { handle: 'owner', display_name: 'Owner' },
    config: { cwd: repositoryPath },
  });
  manager = new WorktreeManager(store);
}

beforeEach(makeFixture);
afterEach(() => {
  store.close();
  // This is the per-test fixture root. No lifecycle test touches a real user
  // checkout or a path outside this directory.
  rmSync(fixtureRoot, { recursive: true, force: true });
});

// harn:assume repository-primary-identity-is-git-derived ref=git-repository-fixtures
// harn:assume registered-worktrees-materialize-stable-conversations ref=worktree-conversation-git-regression
describe('Git repository identity and read-only discovery', () => {
  it('discovers linked worktrees without registering them and keeps main across branch changes', async () => {
    const secondaryPath = join(fixtureRoot, 'unselected linked worktree');
    git(repositoryPath, ['worktree', 'add', '-b', 'review/one', secondaryPath, 'HEAD']);

    const before = await manager.list('eng', repositoryPath);
    expect(before.repository).toBeNull();
    expect(before.registered).toEqual([]);
    expect(before.discovered.map((candidate) => candidate.path)).toEqual(
      expect.arrayContaining([repositoryPath, secondaryPath]),
    );
    expect(before.discovered.every((candidate) => candidate.conversation_id === undefined)).toBe(true);
    expect(store.listRooms().map((room) => room.id)).toEqual(['eng']);
    expect(store.getRepository('eng')).toBeUndefined();

    const beforeSeq = store.currentSeq('eng');
    const adopted = await manager.adopt('eng', repositoryPath, {
      path: secondaryPath,
      alias: ' Review / One ',
    });
    expect(adopted.worktree).toMatchObject({
      alias: 'review-one',
      source: 'adopted',
      lifecycle: 'active',
    });
    expect(adopted.worktree.conversation_id).toMatch(/^wt-/);
    expect((await manager.list('eng', repositoryPath)).discovered.find((candidate) =>
      candidate.path === secondaryPath)).toMatchObject({
      registered_id: adopted.worktree.id,
      conversation_id: adopted.worktree.conversation_id,
    });
    expect(store.listRooms().map((room) => room.id)).toEqual(
      expect.arrayContaining(['eng', adopted.worktree.conversation_id]),
    );
    const main = store.listRegisteredWorktrees('eng').find((worktree) => worktree.primary)!;
    const seqAfterAdopt = store.currentSeq('eng');
    expect(main).toMatchObject({ alias: 'main', primary: true, branch: 'main' });
    expect(seqAfterAdopt).toBe(beforeSeq);

    git(repositoryPath, ['branch', '-M', 'trunk']);
    const afterRename = await manager.list('eng', repositoryPath);
    expect(afterRename.registered.find((worktree) => worktree.id === main.id)).toMatchObject({
      primary: true,
      alias: 'main',
      branch: 'trunk',
    });
    expect(afterRename.registered.find((worktree) => worktree.id === adopted.worktree.id)?.id)
      .toBe(adopted.worktree.id);

    store.close();
    store = new Store(join(fixtureRoot, 'codor.sqlite'));
    manager = new WorktreeManager(store);
    expect(store.getWorktree('eng', adopted.worktree.id)?.id).toBe(adopted.worktree.id);
    expect(store.getWorktree('eng', adopted.worktree.id)?.conversation_id)
      .toBe(adopted.worktree.conversation_id);
    expect((await manager.list('eng', repositoryPath)).registered.map((item) => item.id))
      .toEqual(expect.arrayContaining([main.id, adopted.worktree.id]));
  });

  it('keeps detached primary and secondary identities stable across refresh and reopen', async () => {
    const secondaryPath = join(fixtureRoot, 'detached secondary');
    git(repositoryPath, ['checkout', '--detach', 'HEAD']);
    git(repositoryPath, ['worktree', 'add', '--detach', secondaryPath, 'HEAD']);

    const inspection = await manager.inspect(repositoryPath);
    expect(inspection?.worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: repositoryPath, primary: true }),
      expect.objectContaining({ path: secondaryPath, primary: false }),
    ]));
    expect(inspection?.worktrees.find((worktree) => worktree.path === repositoryPath)?.branch).toBeUndefined();
    expect(inspection?.worktrees.find((worktree) => worktree.path === secondaryPath)?.branch).toBeUndefined();

    const adopted = await manager.adopt('eng', repositoryPath, {
      path: secondaryPath,
      alias: 'detached-secondary',
    });
    const main = store.listRegisteredWorktrees('eng').find((worktree) => worktree.primary)!;
    const repositoryId = adopted.repository.id;
    const ids = { main: main.id, secondary: adopted.worktree.id };
    expect(main.branch).toBeUndefined();
    expect(adopted.worktree.branch).toBeUndefined();
    expect(adopted.worktree.conversation_id).toMatch(/^wt-/);

    const refreshed = await manager.list('eng', repositoryPath);
    expect(refreshed.repository?.id).toBe(repositoryId);
    expect(refreshed.registered.find((worktree) => worktree.id === ids.main))
      .toMatchObject({ id: ids.main, primary: true });
    expect(refreshed.registered.find((worktree) => worktree.id === ids.secondary))
      .toMatchObject({ id: ids.secondary, primary: false });
    expect(refreshed.registered.find((worktree) => worktree.id === ids.main)?.branch).toBeUndefined();
    expect(refreshed.registered.find((worktree) => worktree.id === ids.secondary)?.branch).toBeUndefined();

    store.close();
    store = new Store(join(fixtureRoot, 'codor.sqlite'));
    manager = new WorktreeManager(store);
    const reopened = await manager.list('eng', repositoryPath);
    expect(reopened.repository?.id).toBe(repositoryId);
    expect(reopened.registered.map((worktree) => worktree.id))
      .toEqual(expect.arrayContaining([ids.main, ids.secondary]));
    expect(reopened.registered.find((worktree) => worktree.id === ids.main)?.branch).toBeUndefined();
    expect(reopened.registered.find((worktree) => worktree.id === ids.secondary)?.branch).toBeUndefined();
    expect(reopened.registered.find((worktree) => worktree.id === ids.secondary)?.conversation_id)
      .toBe(adopted.worktree.conversation_id);
  });

  it('returns no repository for a non-Git directory', async () => {
    const nonGit = join(fixtureRoot, 'plain directory');
    mkdirSync(nonGit);
    expect(await manager.list('eng', nonGit)).toMatchObject({
      repository: null,
      registered: [],
      discovered: [],
    });
  });
});
// harn:end registered-worktrees-materialize-stable-conversations
// harn:end repository-primary-identity-is-git-derived

// harn:assume worktree-discovery-never-registers-candidates ref=worktree-discovery-regression
describe('explicit adoption and tombstones', () => {
  it('restores the same stable id after DB-only unregister and never mutates Git', async () => {
    const secondaryPath = join(fixtureRoot, 'selected secondary');
    git(repositoryPath, ['worktree', 'add', '-b', 'selected', secondaryPath, 'HEAD']);
    const beforeHead = git(repositoryPath, ['rev-parse', 'HEAD']);
    const adopted = await manager.adopt('eng', repositoryPath, { path: secondaryPath, alias: 'selected' });
    const unregistered = manager.unregister('eng', adopted.worktree.id);
    expect(unregistered.lifecycle).toBe('unregistered');
    expect(existsSync(secondaryPath)).toBe(true);
    expect(git(repositoryPath, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect((await manager.list('eng', repositoryPath)).registered).toEqual([
      expect.objectContaining({ primary: true }),
    ]);

    const readopted = await manager.adopt('eng', repositoryPath, { path: secondaryPath });
    expect(readopted.worktree.id).toBe(adopted.worktree.id);
    expect(readopted.worktree.lifecycle).toBe('active');
  });
});
// harn:end worktree-discovery-never-registers-candidates

// harn:assume worktree-git-execution-is-argument-safe ref=worktree-git-runner-regression
// harn:assume worktree-creation-registers-only-a-new-secondary ref=worktree-create-regression
describe('safe creation and conservative removal', () => {
  it('passes spaces and option-looking labels as argv values and registers only the result', async () => {
    const target = join(fixtureRoot, 'created target with spaces');
    const created = await manager.create('eng', repositoryPath, {
      alias: ' -- Review / One -- ',
      branch: 'feature/created-one',
      path: target,
    });
    expect(created.worktree).toMatchObject({ alias: 'review-one', branch: 'feature/created-one' });
    expect(store.listRegisteredWorktrees('eng').filter((item) => item.id === created.worktree.id))
      .toHaveLength(1);
    expect(store.listRegisteredWorktrees('eng').filter((item) => item.path === target)).toHaveLength(1);
  });

  // harn:assume worktree-removal-is-clean-and-branch-preserving ref=worktree-remove-regression
  it('refuses dirty removal and removes only a clean registered worktree without deleting its branch', async () => {
    const target = join(fixtureRoot, 'clean target');
    const created = await manager.create('eng', repositoryPath, {
      alias: 'clean-target', branch: 'feature/clean-target', path: target,
    });
    writeFileSync(join(target, 'untracked.txt'), 'must refuse\n');
    await expect(manager.remove('eng', repositoryPath, created.worktree.id))
      .rejects.toThrow('clean before removal');
    expect(existsSync(target)).toBe(true);
    expect(git(repositoryPath, ['show-ref', '--verify', 'refs/heads/feature/clean-target'])).toContain('feature/clean-target');

    rmSync(join(target, 'untracked.txt'));
    const removed = await manager.remove('eng', repositoryPath, created.worktree.id);
    expect(removed.worktree).toMatchObject({ lifecycle: 'removed', availability: 'missing' });
    expect(existsSync(target)).toBe(false);
    expect(git(repositoryPath, ['show-ref', '--verify', 'refs/heads/feature/clean-target'])).toContain('feature/clean-target');
  });
  // harn:end worktree-removal-is-clean-and-branch-preserving

  it('refuses collisions before Git mutation', async () => {
    const existingTarget = join(fixtureRoot, 'already exists');
    mkdirSync(existingTarget);
    await expect(manager.create('eng', repositoryPath, {
      alias: 'collision', branch: 'feature/collision', path: existingTarget,
    })).rejects.toThrow('already exists');
    expect(branchExists(repositoryPath, 'feature/collision')).toBe(false);
  });

  it('refuses a second repository before adoption or creation can mutate it', async () => {
    const firstSecondary = join(fixtureRoot, 'first repository secondary');
    git(repositoryPath, ['worktree', 'add', '-b', 'first/review', firstSecondary, 'HEAD']);
    await manager.adopt('eng', repositoryPath, { path: firstSecondary, alias: 'first-review' });
    const repositoryBefore = store.getRepository('eng')!;
    const registryBefore = JSON.stringify({
      repository: repositoryBefore,
      worktrees: store.listRegisteredWorktrees('eng'),
    });

    const secondRepository = join(fixtureRoot, 'second repository');
    const secondSecondary = join(fixtureRoot, 'second repository secondary');
    mkdirSync(secondRepository, { recursive: true });
    git(secondRepository, ['init', '-q', '-b', 'main']);
    git(secondRepository, ['config', 'user.email', 'fixture@example.test']);
    git(secondRepository, ['config', 'user.name', 'Fixture']);
    writeFileSync(join(secondRepository, 'README.md'), 'second fixture\n');
    git(secondRepository, ['add', 'README.md']);
    git(secondRepository, ['commit', '-qm', 'second fixture']);
    git(secondRepository, ['worktree', 'add', '-b', 'second/review', secondSecondary, 'HEAD']);

    const refsBefore = git(secondRepository, ['show-ref']);
    const worktreesBefore = git(secondRepository, ['worktree', 'list', '--porcelain', '-z']);
    await expect(manager.adopt('eng', secondRepository, {
      path: secondSecondary,
      alias: 'cross-repository-adopt',
    })).rejects.toThrow('one Git repository');
    expect(store.getRepository('eng')).toMatchObject({
      id: repositoryBefore.id,
      common_path: repositoryBefore.common_path,
    });
    expect(JSON.stringify({
      repository: store.getRepository('eng'),
      worktrees: store.listRegisteredWorktrees('eng'),
    })).toBe(registryBefore);
    expect(git(secondRepository, ['show-ref'])).toBe(refsBefore);
    expect(git(secondRepository, ['worktree', 'list', '--porcelain', '-z'])).toBe(worktreesBefore);
    expect(existsSync(secondSecondary)).toBe(true);

    const createTarget = join(fixtureRoot, 'second repository created');
    await expect(manager.create('eng', secondRepository, {
      alias: 'cross-repository-create',
      branch: 'feature/cross-repository',
      path: createTarget,
    })).rejects.toThrow('one Git repository');
    expect(branchExists(secondRepository, 'feature/cross-repository')).toBe(false);
    expect(existsSync(createTarget)).toBe(false);
    expect(git(secondRepository, ['show-ref'])).toBe(refsBefore);
    expect(git(secondRepository, ['worktree', 'list', '--porcelain', '-z'])).toBe(worktreesBefore);
    expect(JSON.stringify({
      repository: store.getRepository('eng'),
      worktrees: store.listRegisteredWorktrees('eng'),
    })).toBe(registryBefore);
  });

  it('refuses locked, missing, main, unregistered, moved, and mismatched targets', async () => {
    const lockedTarget = join(fixtureRoot, 'locked target');
    git(repositoryPath, ['worktree', 'add', '-b', 'feature/locked-target', lockedTarget, 'HEAD']);
    const locked = await manager.adopt('eng', repositoryPath, {
      path: lockedTarget, alias: 'locked-target',
    });
    git(repositoryPath, ['worktree', 'lock', lockedTarget]);
    await expect(manager.remove('eng', repositoryPath, locked.worktree.id))
      .rejects.toThrow(/locked|unavailable/);
    expect(existsSync(lockedTarget)).toBe(true);
    expect(branchExists(repositoryPath, 'feature/locked-target')).toBe(true);

    const missingTarget = join(fixtureRoot, 'missing target');
    git(repositoryPath, ['worktree', 'add', '-b', 'feature/missing-target', missingTarget, 'HEAD']);
    const missing = await manager.adopt('eng', repositoryPath, {
      path: missingTarget, alias: 'missing-target',
    });
    rmSync(missingTarget, { recursive: true, force: true });
    await expect(manager.remove('eng', repositoryPath, missing.worktree.id))
      .rejects.toThrow(/missing|unavailable|prunable/);
    expect(branchExists(repositoryPath, 'feature/missing-target')).toBe(true);

    const movedTarget = join(fixtureRoot, 'moved target');
    const movedPath = join(fixtureRoot, 'moved target again');
    git(repositoryPath, ['worktree', 'add', '-b', 'feature/moved-target', movedTarget, 'HEAD']);
    const moved = await manager.adopt('eng', repositoryPath, {
      path: movedTarget, alias: 'moved-target',
    });
    git(repositoryPath, ['worktree', 'move', movedTarget, movedPath]);
    await expect(manager.remove('eng', repositoryPath, moved.worktree.id))
      .rejects.toThrow(/missing or mismatched/);
    expect(store.getWorktree('eng', moved.worktree.id)).toMatchObject({
      id: moved.worktree.id,
      path: movedTarget,
      branch: 'feature/moved-target',
      lifecycle: 'active',
    });
    expect(existsSync(movedPath)).toBe(true);
    expect(branchExists(repositoryPath, 'feature/moved-target')).toBe(true);

    const refreshed = await manager.list('eng', repositoryPath);
    expect(refreshed.registered.find((item) => item.id === moved.worktree.id)).toMatchObject({
      id: moved.worktree.id, path: movedPath,
    });

    const removedMoved = await manager.remove('eng', repositoryPath, moved.worktree.id);
    expect(removedMoved.worktree).toMatchObject({ lifecycle: 'removed', availability: 'missing' });
    expect(existsSync(movedPath)).toBe(false);
    expect(branchExists(repositoryPath, 'feature/moved-target')).toBe(true);

    const mismatchedTarget = join(fixtureRoot, 'mismatched target');
    git(repositoryPath, ['worktree', 'add', '-b', 'feature/mismatched-target', mismatchedTarget, 'HEAD']);
    const mismatched = await manager.adopt('eng', repositoryPath, {
      path: mismatchedTarget, alias: 'mismatched-target',
    });
    store.refreshWorktreeObservation('eng', mismatched.worktree.id, {
      path: mismatchedTarget,
      git_admin_id: join(fixtureRoot, 'wrong administrative identity'),
      primary: false,
      availability: 'available',
      locked: false,
    });
    await expect(manager.remove('eng', repositoryPath, mismatched.worktree.id))
      .rejects.toThrow(/missing or mismatched/);
    expect(existsSync(mismatchedTarget)).toBe(true);
    expect(branchExists(repositoryPath, 'feature/mismatched-target')).toBe(true);

    const main = store.listRegisteredWorktrees('eng').find((item) => item.primary);
    expect(main).toBeDefined();
    await expect(manager.remove('eng', repositoryPath, main!.id))
      .rejects.toThrow('active secondary');
    const unregisteredTarget = join(fixtureRoot, 'unregistered target');
    git(repositoryPath, ['worktree', 'add', '-b', 'feature/unregistered-target', unregisteredTarget, 'HEAD']);
    const unregistered = await manager.adopt('eng', repositoryPath, {
      path: unregisteredTarget, alias: 'unregistered-target',
    });
    manager.unregister('eng', unregistered.worktree.id);
    await expect(manager.remove('eng', repositoryPath, unregistered.worktree.id))
      .rejects.toThrow('active secondary');
    expect(existsSync(unregisteredTarget)).toBe(true);
    expect(branchExists(repositoryPath, 'feature/unregistered-target')).toBe(true);
  });
});
// harn:end worktree-creation-registers-only-a-new-secondary
// harn:end worktree-git-execution-is-argument-safe

// harn:assume worktree-lifecycle-is-roster-neutral ref=worktree-roster-neutrality-regression
describe('registry storage neutrality', () => {
  it('does not rewrite room, roster, transcript, or delivery state across lifecycle operations', async () => {
    const snapshot = () => JSON.stringify({
      room: store.getRoom('eng'),
      members: store.listMembers('eng', { includeRemoved: true }),
      messages: store.listMessages('eng'),
      deliveries: store.listDeliveries('eng'),
    });
    const before = snapshot();
    const secondaryPath = join(fixtureRoot, 'neutrality secondary');
    git(repositoryPath, ['worktree', 'add', '-b', 'neutrality', secondaryPath, 'HEAD']);
    await manager.adopt('eng', repositoryPath, { path: secondaryPath, alias: 'neutrality' });
    const created = await manager.create('eng', repositoryPath, {
      alias: 'neutrality-created', branch: 'feature/neutrality-created',
      path: join(fixtureRoot, 'neutrality-created'),
    });
    manager.unregister('eng', adoptedId(store, 'neutrality'));
    await manager.remove('eng', repositoryPath, created.worktree.id);
    expect(snapshot()).toBe(before);
    for (const worktree of store.listRegisteredWorktrees('eng')) {
      if (worktree.primary) continue;
      expect(store.listMembers(worktree.conversation_id).filter((member) => member.kind === 'agent'))
        .toEqual([]);
      expect(store.listMessages(worktree.conversation_id)).toEqual([]);
      expect(store.listDeliveries(worktree.conversation_id)).toEqual([]);
    }
  });

  it('keeps populated presets and the ordered default roster neutral across lifecycle and reopen', async () => {
    // Preset configuration is independent durable state: lifecycle operations
    // must neither read nor disturb it, and both domains survive a Store reopen.
    const first = store.createAgentPreset({ label: 'Review helper', handle: 'review-helper', harness: 'codex' });
    const second = store.createAgentPreset({
      label: 'Docs writer', handle: 'docs-writer', harness: 'claude', display_name: 'Docs Writer',
    });
    store.replaceDefaultRoster([first.id, second.id]);
    const configuration = () => JSON.stringify({
      presets: store.listAgentPresets(),
      roster: store.getDefaultRoster(),
    });
    const mainRoster = () => JSON.stringify(store.listMembers('eng', { includeRemoved: true }));
    // Child conversation ids are captured while registered; after unregister and
    // removal the durable conversations are queried directly by those ids.
    const childRosters = (conversationIds: readonly string[]) => JSON.stringify(Object.fromEntries(
      conversationIds.map((conversationId) => [
        conversationId,
        store.listMembers(conversationId, { includeRemoved: true }),
      ]),
    ));
    const configurationBefore = configuration();
    const mainRosterBefore = mainRoster();

    // Discovery alone registers nothing and disturbs nothing.
    const secondaryPath = join(fixtureRoot, 'roster neutral secondary');
    git(repositoryPath, ['worktree', 'add', '-b', 'roster-neutral', secondaryPath, 'HEAD']);
    const discovered = await manager.list('eng', repositoryPath);
    expect(discovered.registered).toEqual([]);
    expect(discovered.discovered.map((candidate) => candidate.path)).toContain(secondaryPath);

    await manager.adopt('eng', repositoryPath, { path: secondaryPath, alias: 'roster-neutral' });
    const created = await manager.create('eng', repositoryPath, {
      alias: 'roster-neutral-created',
      branch: 'feature/roster-neutral-created',
      path: join(fixtureRoot, 'roster-neutral-created'),
    });
    const childIds = store.listRegisteredWorktrees('eng')
      .filter((worktree) => !worktree.primary)
      .map((worktree) => worktree.conversation_id);
    expect(childIds).toHaveLength(2);
    const childRostersBefore = childRosters(childIds);
    manager.unregister('eng', adoptedId(store, 'roster-neutral'));
    await manager.remove('eng', repositoryPath, created.worktree.id);

    expect(configuration()).toBe(configurationBefore);
    expect(mainRoster()).toBe(mainRosterBefore);
    expect(childRosters(childIds)).toBe(childRostersBefore);

    // Reopen: both domains persist exactly as the lifecycle left them.
    store.close();
    store = new Store(join(fixtureRoot, 'codor.sqlite'));
    expect(configuration()).toBe(configurationBefore);
    expect(mainRoster()).toBe(mainRosterBefore);
    expect(childRosters(childIds)).toBe(childRostersBefore);
  });
});
// harn:end worktree-lifecycle-is-roster-neutral

function adoptedId(current: Store, alias: string): string {
  const worktree = current.listRegisteredWorktrees('eng').find((item) => item.alias === alias);
  if (worktree === undefined) throw new Error(`fixture worktree ${alias} was not registered`);
  return worktree.id;
}
