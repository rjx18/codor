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
  refreshAdapters,
  replaceDefaultRoster,
  updateAgentPreset,
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
