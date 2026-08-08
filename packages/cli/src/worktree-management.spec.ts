import type {
  RegisteredWorktree,
  WorktreeListResponse,
  WorktreeRemovalPreviewResponse,
} from '@codor/protocol';
import { describe, expect, it, vi } from 'vitest';

import { MANAGEMENT_EXIT_CODES } from './management.js';
import {
  adoptWorktree,
  confirmWorktreeRemoval,
  createWorktree,
  listWorktrees,
  previewWorktreeRemoval,
  projectWorktreeList,
  removeFilesystemWorktree,
  removeWorktree,
  renderWorktreeList,
  resolveWorktreeSelector,
  type WorktreeRestClient,
} from './worktree-management.js';

const mainId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const alphaId = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const betaId = '01C4F6Y9J4QJ5F4KZ5T6X2V3W4';
const head = '0123456789abcdef0123456789abcdef01234567';

const main: RegisteredWorktree = {
  id: mainId,
  repository_id: '01D4F6Y9J4QJ5F4KZ5T6X2V3W4',
  room: 'eng',
  conversation_id: 'eng',
  alias: 'main',
  path: '/repo/main',
  git_admin_id: '/repo/main/.git',
  primary: true,
  source: 'main',
  lifecycle: 'active',
  availability: 'available',
  locked: false,
  head,
  branch: 'main',
  registered_ts: '2026-08-08T00:00:00.000Z',
  updated_ts: '2026-08-08T00:00:00.000Z',
};

const alpha: RegisteredWorktree = {
  ...main,
  id: alphaId,
  conversation_id: 'alpha-room',
  alias: 'alpha',
  path: '/repo/alpha\tchild',
  git_admin_id: '/repo/main/.git/worktrees/alpha',
  primary: false,
  source: 'adopted',
  branch: 'feature/alpha',
};

const beta: RegisteredWorktree = {
  ...alpha,
  id: betaId,
  conversation_id: 'beta-room',
  alias: 'beta',
  path: '/repo/beta',
  git_admin_id: '/repo/main/.git/worktrees/beta',
  source: 'created',
  branch: 'feature/beta',
};

const response: WorktreeListResponse = {
  repository: {
    id: main.repository_id,
    room: 'eng',
    common_path: '/repo',
    primary_path: main.path,
    primary_git_admin_id: '/repo/main/.git',
    created_ts: main.registered_ts,
    updated_ts: main.updated_ts,
  },
  registered: [beta, main, alpha],
  discovered: [
    {
      path: '/repo/zeta\nchild',
      git_admin_id: '/repo/main/.git/worktrees/zeta',
      primary: false,
      availability: 'available',
      locked: false,
      head,
      branch: 'feature/zeta',
    },
    {
      path: '/repo/main',
      git_admin_id: '/repo/main/.git',
      primary: true,
      availability: 'available',
      locked: false,
      head,
      branch: 'main',
      registered_id: main.id,
      alias: main.alias,
      conversation_id: main.conversation_id,
    },
  ],
};

const lifecycle = (worktree: RegisteredWorktree) => ({
  repository: response.repository!,
  worktree,
});

// harn:assume structured-worktree-cli-uses-accepted-lifecycle ref=worktree-management-client-regression
describe('worktree management client and projections', () => {
  it('projects only public fields in stable bytewise order and escapes human cells', () => {
    const projected = projectWorktreeList(response);
    expect(projected.repository).toEqual({ id: response.repository!.id, room: 'eng', primary_path: '/repo/main' });
    expect(projected.registered.map((worktree) => worktree.alias)).toEqual(['main', 'alpha', 'beta']);
    expect(projected.discovered.map((worktree) => worktree.path)).toEqual(['/repo/main', '/repo/zeta\nchild']);
    expect(JSON.stringify(projected)).not.toContain('git_admin_id');
    expect(JSON.stringify(projected)).not.toContain('common_path');
    expect(JSON.parse(renderWorktreeList(projected, true)).discovered[1].path).toBe('/repo/zeta\nchild');

    const human = renderWorktreeList(projected, false);
    expect(human).toContain('/repo/alpha\\tchild');
    expect(human).toContain('/repo/zeta\\nchild');
    expect(human).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u001b]/);
    expect(human.split('\n')).toHaveLength(6);
  });

  it('uses the accepted REST paths, query/body schemas, and safe lifecycle projections', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const client: WorktreeRestClient = {
      get: vi.fn(async (path: string) => {
        calls.push({ method: 'GET', path });
        if (path.includes('/removal-preview')) {
          return {
            repository: response.repository,
            worktree: alpha,
            state: 'clean',
            branch_preserved: true,
          } satisfies WorktreeRemovalPreviewResponse;
        }
        return response;
      }),
      post: vi.fn(async (path: string, body?: unknown) => {
        calls.push({ method: 'POST', path, body });
        if (path.endsWith('/unregister')) return lifecycle(alpha);
        if (path.endsWith('/remove')) return lifecycle(beta);
        if (path.endsWith('/adopt')) return lifecycle(alpha);
        return lifecycle(beta);
      }),
    };

    await listWorktrees(client, 'eng', '/repo with spaces');
    await adoptWorktree(client, 'eng', { path: '/repo/child with spaces', alias: 'child' }, '/repo');
    await createWorktree(client, 'eng', { path: '/repo/new', alias: 'new', branch: 'feature/new' }, '/repo');
    await previewWorktreeRemoval(client, 'eng', alpha.id, '/repo');
    await removeWorktree(client, 'eng', alpha.id, '/repo');
    await removeFilesystemWorktree(client, 'eng', beta.id, '/repo');

    expect(calls).toEqual([
      { method: 'GET', path: '/api/rooms/eng/worktrees?cwd=%2Frepo+with+spaces' },
      { method: 'POST', path: '/api/rooms/eng/worktrees/adopt?cwd=%2Frepo', body: { path: '/repo/child with spaces', alias: 'child' } },
      { method: 'POST', path: '/api/rooms/eng/worktrees?cwd=%2Frepo', body: { path: '/repo/new', alias: 'new', branch: 'feature/new' } },
      { method: 'GET', path: `/api/rooms/eng/worktrees/${alpha.id}/removal-preview?cwd=%2Frepo` },
      { method: 'POST', path: `/api/rooms/eng/worktrees/${alpha.id}/unregister`, body: {} },
      { method: 'POST', path: `/api/rooms/eng/worktrees/${beta.id}/remove?cwd=%2Frepo`, body: {} },
    ]);
  });
});
// harn:end structured-worktree-cli-uses-accepted-lifecycle

// harn:assume worktree-cli-removal-requires-previewed-consent ref=worktree-removal-confirmation-regression
describe('worktree removal consent and selectors', () => {
  it('resolves stable ids before aliases and refuses main or ambiguous selectors', () => {
    const registered = projectWorktreeList(response).registered;
    expect(resolveWorktreeSelector(registered, alpha.id)).toMatchObject({ alias: 'alpha' });
    expect(resolveWorktreeSelector(registered, 'beta')).toMatchObject({ id: beta.id });
    expect(() => resolveWorktreeSelector(registered, 'main')).toThrowError(
      expect.objectContaining({ exitCode: MANAGEMENT_EXIT_CODES.conflict }),
    );
    expect(() => resolveWorktreeSelector([], alpha.id)).toThrowError(
      expect.objectContaining({ exitCode: MANAGEMENT_EXIT_CODES.notFound }),
    );
    expect(() => resolveWorktreeSelector([
      registered[1]!,
      { ...registered[2]!, alias: 'alpha' },
    ], 'alpha')).toThrowError(
      expect.objectContaining({ exitCode: MANAGEMENT_EXIT_CODES.conflict }),
    );
  });

  it('prompts once with escaped data and requires --yes outside a TTY', async () => {
    const stderr: string[] = [];
    await expect(confirmWorktreeRemoval({
      alias: 'bad\nname',
      path: '/tmp/child\u001b[31m',
      isTTY: true,
      stderr: (line) => stderr.push(line),
      confirm: async () => 'yes',
    })).resolves.toBeUndefined();
    expect(stderr).toEqual(['Remove worktree bad\\nname at /tmp/child\\x1b[31m? Branch will be preserved. [y/N]']);
    expect(stderr[0]).not.toMatch(/[\r\n\u001b]/);

    await expect(confirmWorktreeRemoval({
      alias: 'child',
      path: '/tmp/child',
      json: true,
      isTTY: false,
      stderr: () => undefined,
    })).rejects.toMatchObject({ exitCode: MANAGEMENT_EXIT_CODES.invocation });
    await expect(confirmWorktreeRemoval({
      alias: 'child',
      path: '/tmp/child',
      yes: true,
      json: true,
      isTTY: false,
      stderr: () => undefined,
    })).resolves.toBeUndefined();
  });
});
// harn:end worktree-cli-removal-requires-previewed-consent
