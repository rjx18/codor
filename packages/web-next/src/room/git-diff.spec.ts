// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetActiveComputerForTest, setActiveComputer } from '@runtime/active-computer.js';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@runtime/relay-transport.js', () => ({ relayFetch: transport.fetch }));

import {
  cachedGitWorkingState,
  fetchGitCommitState,
  fetchGitHistory,
  fetchGitWorkingState,
  rememberGitWorkingState,
  resetGitWorkingStateCacheForTest,
  type GitWorkingState,
} from './git-diff.js';

beforeEach(() => {
  resetActiveComputerForTest();
  resetGitWorkingStateCacheForTest();
  transport.fetch.mockReset();
});

describe('git history client', () => {
  it('does not reuse an identical room working tree across computers', () => {
    const state: GitWorkingState = {
      cwds: ['/a'], selected: '/a', repository: true, clean: true, files: [],
    };
    setActiveComputer('A');
    rememberGitWorkingState('shared', undefined, state);
    expect(cachedGitWorkingState('shared')).toEqual(state);

    setActiveComputer('B');
    expect(cachedGitWorkingState('shared')).toBeUndefined();
  });

  it('encodes cwd, cursor, limit, and browser authorization through the relay transport', async () => {
    transport.fetch.mockImplementation(async (_input: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ commits: [] }), { status: 200 }));

    await fetchGitHistory('team room', 'secret', { cwd: '/tmp/a & b', cursor: 5, limit: 5 });

    expect(transport.fetch).toHaveBeenCalledWith(
      `${window.location.origin}/api/rooms/team%20room/git-history?cwd=%2Ftmp%2Fa+%26+b&cursor=5&limit=5`,
      { headers: { authorization: 'Bearer secret' } },
    );
  });

  it('addresses commit detail only by the supplied full hash', async () => {
    transport.fetch.mockImplementation(async (_input: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ files: [] }), { status: 200 }));
    const hash = 'a'.repeat(40);

    await fetchGitCommitState('eng', 'token', hash, '/repo');

    expect(transport.fetch.mock.calls[0]?.[0]).toBe(
      `${window.location.origin}/api/rooms/eng/git-diff?commit=${hash}&cwd=%2Frepo`,
    );
  });

  it('rejects a failed server read instead of inventing empty history', async () => {
    transport.fetch.mockImplementation(async () => new Response('no', { status: 400 }));
    await expect(fetchGitHistory('eng', 'token')).rejects.toThrow(/400/);
  });

  // harn:assume room-git-inspection-read-only-from-known-cwds ref=room-git-inspection-contract
  it('carries honest repository truth for the selected cwd through the transport', async () => {
    transport.fetch.mockImplementation(async () => new Response(
      JSON.stringify({ cwds: ['/plain'], selected: '/plain', repository: false, clean: true, files: [] }),
      { status: 200 },
    ));
    const state = await fetchGitWorkingState('plain-room', 'token');
    expect(state.repository).toBe(false);
    expect(state.files).toEqual([]);
    expect(transport.fetch).toHaveBeenCalledWith(
      `${window.location.origin}/api/rooms/plain-room/git-diff`,
      { headers: { authorization: 'Bearer token' } },
    );
  });
  // harn:end room-git-inspection-read-only-from-known-cwds
});
