import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { worktreeSelectorFromBranch } from '@codor/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store, type InitialAgent } from './store.js';
import { WorktreeManager } from './worktrees.js';

const makeSeed = (handle: string, cwd: string): InitialAgent => ({
  member: {
    kind: 'agent',
    handle,
    display_name: handle,
    harness: 'fake',
    cwd,
    policy: 'read-only',
    host: 'test-host',
    state: 'dead',
    custody: 'owned',
  },
});

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
    const adopted = await manager.adopt('eng', repositoryPath, { path: secondaryPath });
    expect(adopted.worktree).toMatchObject({
      alias: worktreeSelectorFromBranch('review/one'),
      source: 'adopted',
      lifecycle: 'active',
    });
    expect(adopted.worktree.conversation_id).toMatch(/^eng-review-one-[a-f0-9]{8}$/);
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

  it('keeps detached worktrees discoverable but refuses branchless registration', async () => {
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

    await expect(manager.adopt('eng', repositoryPath, { path: secondaryPath }))
      .rejects.toThrow('detached worktree cannot be adopted');
    expect(store.listRegisteredWorktrees('eng')).toEqual([]);
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

  it('serves the background registered projection without Git and persists no unselected candidate', async () => {
    const secondaryPath = join(fixtureRoot, 'background candidate');
    git(repositoryPath, ['worktree', 'add', '-b', 'background', secondaryPath, 'HEAD']);
    const adopted = await manager.adopt('eng', repositoryPath, { path: secondaryPath, alias: 'background' });
    const unselectedPath = join(fixtureRoot, 'unselected background');
    git(repositoryPath, ['worktree', 'add', '-b', 'unselected', unselectedPath, 'HEAD']);

    // The background projection is store-only: a Git runner that always fails
    // proves no discovery runs for it.
    const noGit = new WorktreeManager(store, {
      git: () => Promise.reject(new Error('git must not run for the registered projection')),
    });
    const projection = noGit.registered('eng');
    expect(projection.repository?.id).toBe(adopted.repository.id);
    expect(projection.registered.map((worktree) => worktree.alias)).toEqual(['main', 'background']);
    expect(projection.registered.every((worktree) => worktree.lifecycle === 'active')).toBe(true);

    // Explicit Find runs discovery but persists nothing until a human selects.
    const found = await manager.list('eng', repositoryPath);
    expect(found.discovered.map((candidate) => candidate.path)).toContain(unselectedPath);
    expect(store.listRegisteredWorktrees('eng').map((worktree) => worktree.alias))
      .toEqual(['main', 'background']);
  });
});
// harn:end worktree-discovery-never-registers-candidates

// harn:assume worktree-git-execution-is-argument-safe ref=worktree-git-runner-regression
// harn:assume branch-worktree-creation-registers-only-its-result ref=branch-worktree-create-regression
describe('safe creation and conservative removal', () => {
  it('passes spaces and option-looking labels as argv values and registers only the result', async () => {
    const target = join(fixtureRoot, 'created target with spaces');
    const created = await manager.create('eng', repositoryPath, {
      alias: ' -- Review / One -- ',
      branch: 'feature/created-one',
      path: target,
    });
    expect(created.worktree).toMatchObject({
      alias: worktreeSelectorFromBranch('feature/created-one'), branch: 'feature/created-one',
    });
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

  it('previews removal read-only and rechecks fresh state before the destructive act', async () => {
    const created = await manager.create('eng', repositoryPath, {
      alias: 'preview-target', branch: 'feature/preview-target', path: join(fixtureRoot, 'preview-target'),
    });
    const storeBefore = JSON.stringify(store.listRegisteredWorktrees('eng'));

    const clean = await manager.previewRemoval('eng', repositoryPath, created.worktree.id);
    expect(clean).toMatchObject({ state: 'clean', branch_preserved: true });
    expect(JSON.stringify(store.listRegisteredWorktrees('eng'))).toBe(storeBefore);

    // Dirty the checkout: the preview reports it truthfully and remove refuses.
    writeFileSync(join(created.worktree.path, 'dirty.txt'), 'dirty\n');
    const dirty = await manager.previewRemoval('eng', repositoryPath, created.worktree.id);
    expect(dirty).toMatchObject({ state: 'dirty', branch_preserved: true });
    await expect(manager.remove('eng', repositoryPath, created.worktree.id))
      .rejects.toThrow('clean before removal');
    expect(existsSync(created.worktree.path)).toBe(true);
    expect(JSON.stringify(store.listRegisteredWorktrees('eng'))).toBe(storeBefore);

    // Clean again: the destructive act revalidates instead of trusting the preview.
    rmSync(join(created.worktree.path, 'dirty.txt'));
    expect((await manager.previewRemoval('eng', repositoryPath, created.worktree.id)).state).toBe('clean');
    const removed = await manager.remove('eng', repositoryPath, created.worktree.id);
    expect(removed.worktree.lifecycle).toBe('removed');
    expect(existsSync(created.worktree.path)).toBe(false);
    expect(branchExists(repositoryPath, 'feature/preview-target')).toBe(true);
  });

  it('reports locked, missing, mismatched, and unavailable previews without mutation', async () => {
    const lockedTarget = await manager.create('eng', repositoryPath, {
      alias: 'preview-locked', branch: 'feature/preview-locked', path: join(fixtureRoot, 'preview-locked'),
    });
    git(repositoryPath, ['worktree', 'lock', lockedTarget.worktree.path]);
    expect((await manager.previewRemoval('eng', repositoryPath, lockedTarget.worktree.id)).state)
      .toBe('locked');
    git(repositoryPath, ['worktree', 'unlock', lockedTarget.worktree.path]);

    const goneTarget = await manager.create('eng', repositoryPath, {
      alias: 'preview-gone', branch: 'feature/preview-gone', path: join(fixtureRoot, 'preview-gone'),
    });
    rmSync(goneTarget.worktree.path, { recursive: true, force: true });
    expect((await manager.previewRemoval('eng', repositoryPath, goneTarget.worktree.id)).state)
      .toBe('missing');

    const movedTarget = await manager.create('eng', repositoryPath, {
      alias: 'preview-moved', branch: 'feature/preview-moved', path: join(fixtureRoot, 'preview-moved'),
    });
    git(repositoryPath, ['worktree', 'move', movedTarget.worktree.path, join(fixtureRoot, 'preview-moved-elsewhere')]);
    expect((await manager.previewRemoval('eng', repositoryPath, movedTarget.worktree.id)).state)
      .toBe('mismatched');

    // A non-Git cwd makes the inspection itself unavailable.
    expect((await manager.previewRemoval('eng', fixtureRoot, lockedTarget.worktree.id)).state)
      .toBe('unavailable');

    // A tombstone has no removable target at all.
    manager.unregister('eng', lockedTarget.worktree.id);
    await expect(manager.previewRemoval('eng', repositoryPath, lockedTarget.worktree.id))
      .rejects.toThrow('active secondary');
    expect(existsSync(join(fixtureRoot, 'preview-moved-elsewhere'))).toBe(true);
  });
  // harn:end worktree-removal-is-clean-and-branch-preserving

  it('seeds preflighted members into only the created child at its canonical cwd', async () => {
    const empty = await manager.create('eng', repositoryPath, {
      alias: 'roster-empty', branch: 'feature/roster-empty', path: join(fixtureRoot, 'roster-empty'),
    });
    expect(empty.seeded).toEqual([]);
    expect(store.listMembers(empty.worktree.conversation_id).filter((member) => member.kind === 'agent'))
      .toEqual([]);

    let boundCwd: string | undefined;
    const seeded = await manager.create('eng', repositoryPath, {
      alias: 'roster-seeded', branch: 'feature/roster-seeded', path: join(fixtureRoot, 'roster-seeded'),
    }, (canonicalCwd) => {
      boundCwd = canonicalCwd;
      return [makeSeed('seeded-alpha', canonicalCwd), makeSeed('seeded-beta', canonicalCwd)];
    });
    expect(boundCwd).toBe(seeded.worktree.path);
    expect(seeded.seeded.map((member) => member.handle)).toEqual(['seeded-alpha', 'seeded-beta']);
    expect(
      store.listMembers(seeded.worktree.conversation_id)
        .filter((member) => member.kind === 'agent'),
    ).toHaveLength(2);
    expect(store.listMembers('eng').filter((member) => member.kind === 'agent')).toEqual([]);
    expect(store.getRoom(seeded.worktree.conversation_id)?.config.cwd).toBe(seeded.worktree.path);
  });

  it('cleans up non-force and preserves the branch when registration fails after Git', async () => {
    const rollbackTarget = join(fixtureRoot, 'roster-rollback');
    const sabotaged = new Store(join(fixtureRoot, 'codor.sqlite'));
    const throwing = (() => {
      throw new Error('injected registration failure');
    }) as unknown as Store['registerWorktree'];
    sabotaged.registerWorktree = throwing;
    const rollbackManager = new WorktreeManager(sabotaged);
    await expect(rollbackManager.create('eng', repositoryPath, {
      alias: 'roster-rollback', branch: 'feature/roster-rollback', path: rollbackTarget,
    })).rejects.toThrow(/registration failed/);
    expect(existsSync(rollbackTarget)).toBe(false);
    expect(branchExists(repositoryPath, 'feature/roster-rollback')).toBe(true);
    // No durable residue: neither the repository nor any worktree row landed.
    expect(store.getRepository('eng')).toBeUndefined();
    expect(store.listRegisteredWorktrees('eng')).toEqual([]);
    sabotaged.close();
  });

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
// harn:end branch-worktree-creation-registers-only-its-result
// harn:end worktree-git-execution-is-argument-safe

// harn:assume worktree-lifecycle-preserves-existing-state-by-default ref=worktree-roster-neutrality-regression
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
// harn:end worktree-lifecycle-preserves-existing-state-by-default

function adoptedId(current: Store, alias: string): string {
  const worktree = current.listRegisteredWorktrees('eng').find((item) => item.alias === alias);
  if (worktree === undefined) throw new Error(`fixture worktree ${alias} was not registered`);
  return worktree.id;
}

// harn:assume worktree-removal-is-clean-and-branch-preserving ref=phase5-git-fixture-safety-regression
// harn:assume worktree-git-execution-is-argument-safe ref=phase5-git-fixture-safety-regression
// harn:assume worktree-discovery-never-registers-candidates ref=phase5-git-fixture-safety-regression
// harn:assume branch-worktree-creation-registers-only-its-result ref=phase5-git-fixture-safety-regression
describe('Phase 5 disposable Git fixture safety', () => {
  it('keeps an unselected checkout and every branch intact across the full lifecycle', async () => {
    const unselectedPath = join(fixtureRoot, 'unselected secondary with spaces');
    const adoptedPath = join(fixtureRoot, 'selected secondary with spaces');
    git(repositoryPath, ['worktree', 'add', '-b', 'feature/unselected', unselectedPath, 'HEAD']);
    git(repositoryPath, ['worktree', 'add', '-b', 'feature/adopted', adoptedPath, 'HEAD']);

    const unselectedBefore = {
      gitFile: readFileSync(join(unselectedPath, '.git'), 'utf8'),
      head: git(unselectedPath, ['rev-parse', 'HEAD']),
      status: git(unselectedPath, ['status', '--porcelain=v1', '-z']),
    };
    const refsBefore = git(repositoryPath, ['show-ref'])
      .split('\n').filter((line) => line !== '');
    const calls: { cwd: string; args: readonly string[] }[] = [];
    const traced = new WorktreeManager(store, {
      git: async (cwd, args) => {
        calls.push({ cwd, args: [...args] });
        try {
          return {
            stdout: execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }),
            stderr: '',
          };
        } catch (error) {
          // WorktreeManager's runner contract exposes Git's exit status as
          // `code`; execFileSync stores the same status as `status`.
          const status = (error as { status?: number }).status;
          if (status !== undefined && (error as { code?: number }).code === undefined) {
            Object.defineProperty(error, 'code', { value: status });
          }
          throw error;
        }
      },
    });

    const discovered = await traced.list('eng', repositoryPath);
    expect(discovered.registered).toEqual([]);
    expect(discovered.discovered.map((candidate) => candidate.path)).toEqual(
      expect.arrayContaining([unselectedPath, adoptedPath]),
    );

    const adopted = await traced.adopt('eng', repositoryPath, {
      path: adoptedPath, alias: 'selected-adopted',
    });
    const created = await traced.create('eng', repositoryPath, {
      alias: 'selected-created', branch: 'feature/created',
      path: join(fixtureRoot, 'selected created secondary'),
    });
    expect(store.listRegisteredWorktrees('eng').map((worktree) => worktree.alias))
      .toEqual([
        'main',
        worktreeSelectorFromBranch('feature/adopted'),
        worktreeSelectorFromBranch('feature/created'),
      ]);

    // Unregister is database-only and does not touch the adopted checkout.
    expect(traced.unregister('eng', adopted.worktree.id).lifecycle).toBe('unregistered');
    expect(existsSync(adoptedPath)).toBe(true);

    writeFileSync(join(created.worktree.path, 'dirty.txt'), 'must refuse\n');
    await expect(traced.remove('eng', repositoryPath, created.worktree.id))
      .rejects.toThrow('clean before removal');
    expect(existsSync(created.worktree.path)).toBe(true);
    rmSync(join(created.worktree.path, 'dirty.txt'));
    const removed = await traced.remove('eng', repositoryPath, created.worktree.id);
    expect(removed.worktree.lifecycle).toBe('removed');
    expect(existsSync(created.worktree.path)).toBe(false);

    const refsAfter = git(repositoryPath, ['show-ref']).split('\n').filter((line) => line !== '');
    for (const ref of refsBefore) expect(refsAfter).toContain(ref);
    expect(refsAfter.some((line) => line.endsWith('refs/heads/feature/created'))).toBe(true);
    expect(readFileSync(join(unselectedPath, '.git'), 'utf8')).toBe(unselectedBefore.gitFile);
    expect(git(unselectedPath, ['rev-parse', 'HEAD'])).toBe(unselectedBefore.head);
    expect(git(unselectedPath, ['status', '--porcelain=v1', '-z'])).toBe(unselectedBefore.status);
    expect(existsSync(unselectedPath)).toBe(true);

    expect(calls.every(({ args }) => !args.includes('--force') && !args.includes('prune'))).toBe(true);
    expect(calls.every(({ args }) => !(args[0] === 'branch' && args.some((arg) => arg === '-d' || arg === '-D'))))
      .toBe(true);
    const unselectedMutations = calls.filter(({ cwd, args }) =>
      (cwd === unselectedPath || args.includes(unselectedPath)) &&
      args[0] === 'worktree' && ['add', 'remove', 'move', 'lock', 'unlock'].includes(args[1] ?? ''));
    expect(unselectedMutations).toEqual([]);
    expect(calls.every(({ args }) => args.every((arg) => !/[;&|<>]/.test(arg)))).toBe(true);
  });
});
// harn:end branch-worktree-creation-registers-only-its-result
// harn:end worktree-discovery-never-registers-candidates
// harn:end worktree-git-execution-is-argument-safe
// harn:end worktree-removal-is-clean-and-branch-preserving
