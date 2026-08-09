// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAgentPreset,
  createRoom,
  deleteAgentPreset,
  fetchAdapters,
  fetchAgentPreset,
  fetchAgentPresets,
  fetchDefaultRoster,
  fetchRoutingCatalog,
  fetchTranscriptHistory,
  refreshAdapters,
  replaceDefaultRoster,
  updateAgentPreset,
} from './api.js';
import {
  adoptWorktree,
  createWorktree,
  discoverWorktrees,
  fetchRegisteredWorktrees,
  previewWorktreeRemoval,
  removeWorktree,
  unregisterWorktree,
  updateWorktreeAlias,
} from './api.js';
import { setRelayTransport } from './relay-transport.js';

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

  // harn:assume default-roster-channel-selection-is-exclusive-and-preflighted ref=default-roster-create-rest-regression
  it('passes the typed default-roster selector through the hosted create helper', async () => {
    const response = (body: unknown): Response =>
      ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response;
    const fetch = vi.fn(() => Promise.resolve(response({
      room: { id: 'roster-room', name: 'Roster Room' },
    })));
    vi.stubGlobal('fetch', fetch);

    await createRoom({
      name: 'Roster Room',
      owner: { handle: 'owner', display_name: 'Owner' },
      default_roster: true,
    }, { token: 'secret' });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/rooms'), expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        name: 'Roster Room',
        owner: { handle: 'owner', display_name: 'Owner' },
        default_roster: true,
      }),
    }));
  });
  // harn:end default-roster-channel-selection-is-exclusive-and-preflighted
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

// harn:assume default-roster-channel-selection-is-exclusive-and-preflighted ref=default-roster-create-rest-regression
describe('roster room creation transport parity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setRelayTransport(undefined);
  });

  const respond = (body: unknown): Response =>
    ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response;

  it('keeps the typed selector, bearer, and legacy body identical across native and relay transport', async () => {
    const room = { id: 'transport-roster', name: 'Transport Roster' };
    const rosterRequest = {
      name: 'Transport Roster',
      owner: { handle: 'transport-owner', display_name: 'Transport Owner' },
      default_roster: true as const,
    };
    const nativeFetch = vi.fn(() => Promise.resolve(respond({ room })));
    vi.stubGlobal('fetch', nativeFetch);

    await createRoom(rosterRequest, {
      token: 'native-token', origin: 'https://switchboard.example',
    });
    expect(nativeFetch).toHaveBeenCalledWith(
      'https://switchboard.example/api/rooms',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer native-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(rosterRequest),
      }),
    );

    const relayFetch = vi.fn(() => Promise.resolve(respond({ room })));
    setRelayTransport({ origin: 'https://relay.example', fetch: relayFetch });
    await createRoom(rosterRequest, {
      token: 'relay-token', origin: 'https://relay.example',
    });
    expect(relayFetch).toHaveBeenCalledWith(
      '/api/rooms',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer relay-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(rosterRequest),
      }),
    );

    setRelayTransport(undefined);
    const legacyRequest = {
      name: 'Legacy Transport',
      owner: { handle: 'legacy-transport-owner', display_name: 'Legacy Owner' },
    };
    await createRoom(legacyRequest, {
      token: 'native-token', origin: 'https://switchboard.example',
    });
    const legacyCall = nativeFetch.mock.calls[1] as unknown as
      [unknown, { body?: unknown }?] | undefined;
    expect(legacyCall?.[1]?.body).toBe(JSON.stringify(legacyRequest));
  });
});
// harn:end default-roster-channel-selection-is-exclusive-and-preflighted

describe('agent preset runtime API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setRelayTransport(undefined);
  });

  const preset = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    schema_version: 1,
    created_ts: '2026-08-06T00:00:00.000Z',
    updated_ts: '2026-08-06T00:00:00.000Z',
    label: 'Review helper',
    handle: 'review-helper',
    harness: 'codex',
  };
  const roster = {
    id: 'default' as const,
    schema_version: 1 as const,
    updated_ts: '2026-08-06T00:00:00.000Z',
    preset_ids: [preset.id],
  };
  const respond = (body: unknown, status = 200): Response =>
    ({ ok: true, status, json: () => Promise.resolve(body) }) as unknown as Response;

  it('uses native fetch with bearer headers and typed CRUD/order shapes', async () => {
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.endsWith('/api/agent-presets')) {
        return Promise.resolve(respond({ presets: [preset] }));
      }
      if (method === 'GET' && url.endsWith(`/api/agent-presets/${preset.id}`)) {
        return Promise.resolve(respond({ preset }));
      }
      if (method === 'GET' && url.endsWith('/api/default-roster')) {
        return Promise.resolve(respond({ roster }));
      }
      if (method === 'POST') return Promise.resolve(respond({ preset }, 201));
      if (method === 'PUT' && url.endsWith('/api/agent-presets/' + preset.id)) {
        return Promise.resolve(respond({ preset }));
      }
      if (method === 'PUT') return Promise.resolve(respond({ roster }));
      return Promise.resolve(respond(undefined, 204));
    });
    vi.stubGlobal('fetch', fetch);

    expect(await fetchAgentPresets({ token: 'secret' })).toEqual([preset]);
    expect(await fetchAgentPreset(preset.id, { token: 'secret' })).toEqual(preset);
    expect(await createAgentPreset({
      label: preset.label, handle: preset.handle, harness: preset.harness,
    }, { token: 'secret' })).toEqual(preset);
    expect(await updateAgentPreset(preset.id, {
      label: preset.label, handle: preset.handle, harness: preset.harness,
    }, { token: 'secret' })).toEqual(preset);
    expect(await fetchDefaultRoster({ token: 'secret' })).toEqual(roster);
    expect(await replaceDefaultRoster({ preset_ids: roster.preset_ids }, { token: 'secret' }))
      .toEqual(roster);
    await deleteAgentPreset(preset.id, { token: 'secret' });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/agent-presets'),
      expect.objectContaining({ headers: { authorization: 'Bearer secret' } }),
    );
    const put = fetch.mock.calls.find((call) => call[1]?.method === 'PUT');
    expect(put?.[1]?.headers).toEqual({
      authorization: 'Bearer secret', 'content-type': 'application/json',
    });
  });

  it('routes hosted calls through the active relay transport', async () => {
    const relayFetch = vi.fn(() => Promise.resolve(respond({ roster })));
    setRelayTransport({ origin: 'https://relay.example', fetch: relayFetch });
    const result = await fetchDefaultRoster({
      token: 'hosted-token', origin: 'https://relay.example',
    });
    expect(result).toEqual(roster);
    expect(relayFetch).toHaveBeenCalledWith(
      '/api/default-roster',
      expect.objectContaining({ headers: { authorization: 'Bearer hosted-token' } }),
    );
  });

  it('rejects malformed preset list and addressed responses at the runtime boundary', async () => {
    const fetch = vi.fn((url: string) => Promise.resolve(
      respond(url.endsWith('/api/agent-presets') ? { presets: [{ ...preset, schema_version: 99 }] } : {
        preset: { ...preset, label: '' },
      }),
    ));
    vi.stubGlobal('fetch', fetch);

    await expect(fetchAgentPresets({ token: 'secret' })).rejects.toThrow();
    await expect(fetchAgentPreset(preset.id, { token: 'secret' })).rejects.toThrow();
  });

  it('strictly validates mutation projections and correlates addressed ids on native and relay transport', async () => {
    const malformedPreset = { ...preset, label: '' };
    const malformedRoster = { ...roster, schema_version: 99 };
    const nativeFetch = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') return Promise.resolve(respond({ preset: malformedPreset }));
      if (method === 'PUT' && url.includes('/api/agent-presets/')) {
        return Promise.resolve(respond({ preset: malformedPreset }));
      }
      if (method === 'PUT') return Promise.resolve(respond({ roster: malformedRoster }));
      if (url.endsWith('/api/default-roster')) return Promise.resolve(respond({ roster: malformedRoster }));
      return Promise.resolve(respond({ preset: { ...preset, id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' } }));
    });
    vi.stubGlobal('fetch', nativeFetch);

    await expect(createAgentPreset({
      label: 'Create', handle: 'create', harness: 'codex',
    }, { token: 'secret' })).rejects.toThrow();
    await expect(updateAgentPreset(preset.id, {
      label: 'Update', handle: 'update', harness: 'codex',
    }, { token: 'secret' })).rejects.toThrow();
    await expect(fetchDefaultRoster({ token: 'secret' })).rejects.toThrow();
    await expect(replaceDefaultRoster({ preset_ids: [] }, { token: 'secret' })).rejects.toThrow();
    await expect(fetchAgentPreset(preset.id, { token: 'secret' })).rejects.toThrow(/did not match requested preset/);

    const relayFetch = vi.fn((path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') return Promise.resolve(respond({ preset: malformedPreset }));
      if (method === 'PUT' && path.includes('/api/agent-presets/')) {
        return Promise.resolve(respond({ preset: malformedPreset }));
      }
      if (method === 'PUT') return Promise.resolve(respond({ roster: malformedRoster }));
      if (path.includes('/api/agent-presets/')) {
        return Promise.resolve(respond({ preset: { ...preset, id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' } }));
      }
      return Promise.resolve(respond({ roster: malformedRoster }));
    });
    setRelayTransport({ origin: 'https://relay.example', fetch: relayFetch });
    await expect(createAgentPreset({
      label: 'Create', handle: 'create', harness: 'codex',
    }, { token: 'relay-secret', origin: 'https://relay.example' })).rejects.toThrow();
    await expect(updateAgentPreset(preset.id, {
      label: 'Update', handle: 'update', harness: 'codex',
    }, { token: 'relay-secret', origin: 'https://relay.example' })).rejects.toThrow();
    await expect(fetchDefaultRoster({ token: 'relay-secret', origin: 'https://relay.example' })).rejects.toThrow();
    await expect(replaceDefaultRoster({ preset_ids: [] }, {
      token: 'relay-secret', origin: 'https://relay.example',
    })).rejects.toThrow();
    await expect(fetchAgentPreset(preset.id, {
      token: 'relay-secret', origin: 'https://relay.example',
    })).rejects.toThrow(/did not match requested preset/);
    expect(relayFetch).toHaveBeenCalledWith('/api/default-roster', expect.objectContaining({
      headers: { authorization: 'Bearer relay-secret' },
    }));
  });

  it('correlates schema-valid addressed update responses on native and relay transport', async () => {
    const mismatchedPreset = {
      ...preset,
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    };
    const nativeFetch = vi.fn(() => Promise.resolve(respond({ preset: mismatchedPreset })));
    vi.stubGlobal('fetch', nativeFetch);

    await expect(updateAgentPreset(preset.id, {
      label: 'Update', handle: 'update', harness: 'codex',
    }, { token: 'native-secret' })).rejects.toThrow(/did not match requested preset/);

    const relayFetch = vi.fn(() => Promise.resolve(respond({ preset: mismatchedPreset })));
    setRelayTransport({ origin: 'https://relay.example', fetch: relayFetch });
    await expect(updateAgentPreset(preset.id, {
      label: 'Update', handle: 'update', harness: 'codex',
    }, { token: 'relay-secret', origin: 'https://relay.example' }))
      .rejects.toThrow(/did not match requested preset/);
    expect(relayFetch).toHaveBeenCalledWith(
      `/api/agent-presets/${preset.id}`,
      expect.objectContaining({
        method: 'PUT',
        headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
      }),
    );
  });
});

// harn:assume registered-worktree-navigation-is-promotion-gated ref=registered-worktree-client
// harn:assume worktree-lifecycle-ui-is-explicit-and-recoverable ref=worktree-lifecycle-client
describe('worktree lifecycle client', () => {
  afterEach(() => vi.unstubAllGlobals());

  const repository = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAA',
    room: 'eng',
    common_path: '/repo/.git',
    primary_path: '/repo',
    primary_git_admin_id: '/repo/.git',
    created_ts: '2026-08-07T00:00:00.000Z',
    updated_ts: '2026-08-07T00:00:00.000Z',
  };
  const main = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAB',
    repository_id: repository.id,
    room: 'eng',
    conversation_id: 'eng',
    alias: 'main',
    path: '/repo',
    git_admin_id: '/repo/.git',
    primary: true,
    source: 'main',
    lifecycle: 'active',
    availability: 'available',
    locked: false,
    registered_ts: repository.created_ts,
    updated_ts: repository.updated_ts,
  };
  const child = {
    ...main,
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAC',
    conversation_id: 'wt-01arz3ndektsv4rrffq69g5fac',
    alias: 'review',
    path: '/repo-review',
    git_admin_id: '/repo/.git/worktrees/review',
    primary: false,
    source: 'adopted',
  };
  const respond = (body: unknown, status = 200): Response =>
    ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as unknown as Response;

  it('parses the store-only registered projection strictly and preserves errors', async () => {
    const fetch = vi.fn(() => Promise.resolve(respond({ repository, registered: [main, child] })));
    vi.stubGlobal('fetch', fetch);
    const projection = await fetchRegisteredWorktrees('eng', { token: 'secret' });
    expect(projection.registered.map((worktree) => worktree.alias)).toEqual(['main', 'review']);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/rooms/eng/worktrees/registered'),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer secret' }) }),
    );

    vi.stubGlobal('fetch', () => Promise.resolve(respond({
      repository, registered: [main, child], discovered: [],
    })));
    await expect(fetchRegisteredWorktrees('eng', { token: 'secret' })).rejects.toThrow();

    vi.stubGlobal('fetch', () => Promise.resolve(respond({ error: 'forbidden: agent cannot use worktree management' }, 403)));
    await expect(fetchRegisteredWorktrees('eng', { token: 'agent-token' }))
      .rejects.toThrow('forbidden: agent cannot use worktree management');
  });

  it('runs discovery only through the explicit Find call', async () => {
    const fetch = vi.fn(() => Promise.resolve(respond({
      repository, registered: [main, child], discovered: [],
    })));
    vi.stubGlobal('fetch', fetch);
    const found = await discoverWorktrees('eng', { token: 'secret' });
    expect(found.registered).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/rooms/eng/worktrees/discover'),
      expect.anything(),
    );
  });

  it('sends lifecycle mutations to their exact routes and parses projections', async () => {
    const lifecycle = { repository, worktree: child };
    const calls: [string, RequestInit?][] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve(respond(lifecycle, 201));
    });
    await adoptWorktree('eng', { path: '/repo-review', alias: 'review' }, { token: 't' });
    await createWorktree('eng', {
      alias: 'created', branch: 'feature/created', path: '/repo-created', default_roster: true,
    }, { token: 't' });
    await updateWorktreeAlias('eng', child.id, 'renamed', { token: 't' });
    await unregisterWorktree('eng', child.id, { token: 't' });
    await removeWorktree('eng', child.id, { token: 't' });
    expect(calls.map(([url]) => url)).toEqual([
      expect.stringContaining('/api/rooms/eng/worktrees/adopt'),
      expect.stringContaining('/api/rooms/eng/worktrees/create'),
      expect.stringContaining(`/api/rooms/eng/worktrees/${child.id}/alias`),
      expect.stringContaining(`/api/rooms/eng/worktrees/${child.id}/unregister`),
      expect.stringContaining(`/api/rooms/eng/worktrees/${child.id}/remove`),
    ]);
    expect(JSON.parse(String(calls[1]![1]?.body))).toMatchObject({ default_roster: true });
    expect(JSON.parse(String(calls[2]![1]?.body))).toEqual({ alias: 'renamed' });
  });

  it('parses removal previews and rejects malformed states', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(respond({
      repository, worktree: child, state: 'dirty', branch_preserved: true, detail: 'untracked files',
    })));
    const preview = await previewWorktreeRemoval('eng', child.id, { token: 't' });
    expect(preview).toMatchObject({ state: 'dirty', branch_preserved: true });

    vi.stubGlobal('fetch', () => Promise.resolve(respond({
      repository, worktree: child, state: 'gone', branch_preserved: true,
    })));
    await expect(previewWorktreeRemoval('eng', child.id, { token: 't' })).rejects.toThrow();
  });
});
// harn:end worktree-lifecycle-ui-is-explicit-and-recoverable
// harn:end registered-worktree-navigation-is-promotion-gated

// harn:assume finalized-browser-history-is-combined-page-owned ref=combined-history-api-client
describe('combined transcript history client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setRelayTransport(undefined);
  });

  it('routes an opaque cursor with bearer authentication and validates the response', async () => {
    const fetch = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        messages: [], journals: [], units: [], before_cursor: null, has_more: false,
      }),
    } as Response));
    vi.stubGlobal('fetch', fetch);
    const page = await fetchTranscriptHistory('a room', 'opaque/+ cursor', { token: 'secret' });
    expect(page.units).toEqual([]);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/rooms/a%20room/transcript-history?cursor=opaque%2F%2B%20cursor'),
      expect.objectContaining({ headers: { authorization: 'Bearer secret' } }),
    );
  });

  // harn:assume merged-worktree-reliability-contracts-coexist ref=cross-stack-api-transport-regression
  it('keeps worktree routing and combined history distinct on one hosted relay transport', async () => {
    const catalog = {
      room: 'eng',
      targets: [{
        worktree_id: '01ARZ3NDEKTSV4RRFFQ69G5FAA',
        conversation_id: 'eng',
        alias: 'main',
        primary: true,
        lifecycle: 'active',
        members: [{ member_id: '01BX5ZZKBKACTAV9WEVGEMMVRY', handle: 'owner', kind: 'human' }],
      }],
      tombstones: [],
    };
    const relayFetch = vi.fn((path: string, _init?: RequestInit) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(path.endsWith('/routing-targets')
        ? catalog
        : { messages: [], journals: [], units: [], before_cursor: null, has_more: false }),
    } as Response));
    setRelayTransport({ origin: 'https://relay.example', fetch: relayFetch });

    const options = { token: 'hosted-token', origin: 'https://relay.example' };
    const [routing, history] = await Promise.all([
      fetchRoutingCatalog('eng', options),
      fetchTranscriptHistory('eng', undefined, options),
    ]);
    expect(routing.targets[0]?.alias).toBe('main');
    expect(history.units).toEqual([]);
    expect(relayFetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/rooms/eng/routing-targets',
      '/api/rooms/eng/transcript-history',
    ]);
    expect(relayFetch.mock.calls.every(([, init]) =>
      init?.headers && (init.headers as Record<string, string>).authorization === 'Bearer hosted-token'))
      .toBe(true);
  });
  // harn:end merged-worktree-reliability-contracts-coexist
});
// harn:end finalized-browser-history-is-combined-page-owned
