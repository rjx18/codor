// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRoom, fetchAdapters } from './api.js';

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
});

// harn:assume starting-agent-name-derives-one-valid-identity-v5 ref=actionable-rest-error-regression
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
// harn:end starting-agent-name-derives-one-valid-identity-v5
