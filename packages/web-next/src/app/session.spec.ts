// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';

import { pageParams, roomUrl, useAdapterCatalog } from './session.js';

// harn:assume registered-worktree-navigation-is-promotion-gated ref=worktree-url-selector
describe('worktree url selector', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('parses the public root and the optional stable worktree id', () => {
    window.history.replaceState(null, '', '/?room=eng');
    expect(pageParams()).toEqual({ room: 'eng' });

    window.history.replaceState(null, '', '/?room=eng&worktree=01ARZ3NDEKTSV4RRFFQ69G5FAC');
    expect(pageParams()).toEqual({ room: 'eng', worktree: '01ARZ3NDEKTSV4RRFFQ69G5FAC' });

    // An empty selector is the main conversation, not a malformed selection.
    window.history.replaceState(null, '', '/?room=eng&worktree=');
    expect(pageParams()).toEqual({ room: 'eng' });
  });

  it('writes only the public root and stable worktree id into navigation state', () => {
    expect(roomUrl('eng')).toBe('/?room=eng');
    expect(roomUrl('eng', '01ARZ3NDEKTSV4RRFFQ69G5FAC'))
      .toBe('/?room=eng&worktree=01ARZ3NDEKTSV4RRFFQ69G5FAC');
    // A child conversation id or alias never becomes a URL parameter.
    expect(roomUrl('eng', '01ARZ3NDEKTSV4RRFFQ69G5FAC')).not.toContain('wt-');
  });
});
// harn:end registered-worktree-navigation-is-promotion-gated

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function CatalogProbe(): null {
  // Stable identity like the production accessors: a fresh closure per render
  // would retrigger the catalog effect on every state update.
  useAdapterCatalog(stableToken);
  return null;
}

function stableToken(): string {
  return 't';
}

// harn:assume model-catalogs-reach-a-browser-that-arrives-early ref=adapter-discovery-poll-budget
describe('adapter discovery poll budget', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let discovering = true;

  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ adapters: [], discovering }), { status: 200 }),
  );

  beforeEach(() => {
    discovering = true;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root !== undefined) {
      const unmounting = root;
      root = undefined;
      await act(async () => { unmounting.unmount(); });
    }
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(CatalogProbe));
    });
  }

  it('keeps polling while discovering past the slowest probe budget', async () => {
    // Requirement: the slowest probe runs 30 s, so the client must still ask at 31 s.
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(62);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock.mock.calls.length).toBe(71);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock.mock.calls.length).toBe(71);
  });

  it('stops polling once the catalog reports discovery finished', async () => {
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    discovering = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    const settled = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock.mock.calls.length).toBe(settled);
  });
});
