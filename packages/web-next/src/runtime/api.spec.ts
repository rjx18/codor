// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRoom, fetchAdapters, fetchRoutingCatalog, refreshAdapters } from './api.js';

// harn:assume model-catalogs-reach-a-browser-that-arrives-early ref=adapter-discovery-pending-regression
describe('adapter listing', () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (body: unknown): Response =>
    ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response;

  it('reports that discovery is still running, so the caller knows to ask again', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(respond({
      adapters: [{ id: 'opencode', capabilities: { thinking: true } }],
      discovering: true,
    })));

    const listing = await fetchAdapters({ token: 't' });
    // An empty catalog and an unfinished one are not the same thing.
    expect(listing.discovering).toBe(true);
    expect(listing.adapters[0]!.models).toBeUndefined();
  });

  it('reports discovery finished once the harnesses have answered', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(respond({
      adapters: [{ id: 'opencode', capabilities: { thinking: true }, models: ['a/b'], models_source: 'discovered' }],
      discovering: false,
    })));

    const listing = await fetchAdapters({ token: 't' });
    expect(listing.discovering).toBe(false);
    expect(listing.adapters[0]!.models).toEqual(['a/b']);
  });

  it('treats a server that says nothing as finished rather than polling forever', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(respond({ adapters: [] })));

    expect((await fetchAdapters({ token: 't' })).discovering).toBe(false);
  });

  it('posts an authenticated daemon refresh and preserves installed state', async () => {
    const fetch = vi.fn(() => Promise.resolve(respond({
      adapters: [{ id: 'codex', installed: false, capabilities: { thinking: true } }],
      discovering: false,
    })));
    vi.stubGlobal('fetch', fetch);
    const listing = await refreshAdapters({ token: 'secret' });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/adapters/refresh'), expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer secret' }),
    }));
    expect(listing.adapters[0]!.installed).toBe(false);
  });

  // harn:assume agent-selection-shows-detected-acp-and-advanced-custom ref=acp-provider-catalog-client
  it('surfaces named provider entries with safe metadata and no command material', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(respond({
      adapters: [
        { id: 'codex', installed: true, capabilities: { thinking: true } },
        {
          id: 'acp:kimi', harness: 'acp', label: 'Kimi Code CLI', transport: 'acp',
          acp_provider: 'kimi', help_url: 'https://example.test', installed: true,
          capabilities: { thinking: false },
        },
      ],
      discovering: false,
    })));
    const listing = await fetchAdapters({ token: 't' });
    const named = listing.adapters.find((adapter) => adapter.acp_provider === 'kimi')!;
    expect(named.harness).toBe('acp');
    expect(named.transport).toBe('acp');
    expect(named.label).toBe('Kimi Code CLI');
    expect(named.help_url).toBe('https://example.test');
    expect(named).not.toHaveProperty('executable');
    expect(named).not.toHaveProperty('argv');
  });
  // harn:end agent-selection-shows-detected-acp-and-advanced-custom
});

// harn:assume starting-agent-name-derives-one-valid-identity-v6 ref=actionable-rest-error-regression
describe('actionable REST errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves the server diagnostic for a rejected channel identity', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: false,
      status: 400,
      json: () => Promise.resolve({
        error: 'starting agent handle @richard is already in use by the channel owner',
      }),
    } as Response));

    await expect(createRoom({
      name: 'Review Room',
      owner: { handle: 'richard', display_name: 'Richard' },
      starting_agent: { harness: 'fake', handle: 'richard', display_name: 'Richard' },
    }, { token: 't' })).rejects.toThrow(
      'starting agent handle @richard is already in use by the channel owner',
    );
  });
});
// harn:end starting-agent-name-derives-one-valid-identity-v6

// harn:assume qualified-completion-lists-registered-targets-only ref=qualified-target-catalog-client-regression
describe('qualified target catalog client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the path-free catalog with the bearer token and validates its projection', async () => {
    const catalog = {
      room: 'eng',
      targets: [
        {
          worktree_id: '01ARZ3NDEKTSV4RRFFQ69G5FAA',
          conversation_id: 'eng',
          alias: 'main',
          primary: true,
          lifecycle: 'active',
          members: [{ member_id: '01BX5ZZKBKACTAV9WEVGEMMVRY', handle: 'richard', kind: 'human' }],
        },
        {
          worktree_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          conversation_id: 'wt-review',
          alias: 'review',
          primary: false,
          lifecycle: 'active',
          members: [{ member_id: '01BX5ZZKBKACTAV9WEVGEMMVRZ', handle: 'coder', kind: 'agent' }],
        },
      ],
      tombstones: [],
    };
    const fetch = vi.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(catalog),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetch);

    await expect(fetchRoutingCatalog('eng', { token: 'secret', origin: 'https://switchboard.test' }))
      .resolves.toEqual(catalog);
    expect(fetch).toHaveBeenCalledWith('https://switchboard.test/api/rooms/eng/routing-targets', {
      headers: { authorization: 'Bearer secret' },
    });
  });

  it('preserves an actionable server refusal and rejects malformed catalog data', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: false, status: 403, json: () => Promise.resolve({ error: 'forbidden: agent cannot use worktree management' }),
    } as unknown as Response));
    await expect(fetchRoutingCatalog('eng', { token: 'agent-token' }))
      .rejects.toThrow('forbidden: agent cannot use worktree management');

    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve({ room: 'eng', targets: [{ path: '/tmp/leak' }], tombstones: [] }),
    } as unknown as Response));
    await expect(fetchRoutingCatalog('eng', { token: 'secret' })).rejects.toThrow();

    // A secondary-only projection has no stable primary main target; the wire
    // invariant rejects it instead of letting completion route around main.
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        room: 'eng',
        targets: [{
          worktree_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          conversation_id: 'wt-review',
          alias: 'review',
          primary: false,
          lifecycle: 'active',
          members: [{ member_id: '01BX5ZZKBKACTAV9WEVGEMMVRZ', handle: 'coder', kind: 'agent' }],
        }],
        tombstones: [],
      }),
    } as unknown as Response));
    await expect(fetchRoutingCatalog('eng', { token: 'secret' })).rejects.toThrow();
  });
});
// harn:end qualified-completion-lists-registered-targets-only
