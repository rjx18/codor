import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchGitCommitState, fetchGitHistory } from './git-diff.js';

afterEach(() => vi.unstubAllGlobals());

describe('git history client', () => {
  it('encodes cwd, cursor, limit, and browser authorization', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ commits: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchGitHistory('team room', 'secret', { cwd: '/tmp/a & b', cursor: 5, limit: 5 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/rooms/team%20room/git-history?cwd=%2Ftmp%2Fa+%26+b&cursor=5&limit=5',
      { headers: { authorization: 'Bearer secret' } },
    );
  });

  it('addresses commit detail only by the supplied full hash', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ files: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const hash = 'a'.repeat(40);

    await fetchGitCommitState('eng', 'token', hash, '/repo');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/rooms/eng/git-diff?commit=${hash}&cwd=%2Frepo`,
    );
  });

  it('rejects a failed server read instead of inventing empty history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 400 })));
    await expect(fetchGitHistory('eng', 'token')).rejects.toThrow(/400/);
  });
});
