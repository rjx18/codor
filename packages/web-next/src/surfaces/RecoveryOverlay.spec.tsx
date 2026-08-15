// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const connection = vi.hoisted(() => ({ state: 'agent-offline' as string, downMs: 10_000 }));
const sessions = vi.hoisted(() => ({
  managed: true,
  manager: {
    subscribe: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(() => ({ activeId: undefined as string | undefined, computers: [] as Array<Record<string, unknown>> })),
    forget: vi.fn(async () => true),
    active: vi.fn(() => true),
  },
}));
vi.mock('../app/use-connection-state.js', () => ({ useConnectionState: () => connection }));
vi.mock('../app/computer-sessions.js', () => ({ computerSessions: () => sessions.managed ? sessions.manager : undefined }));
vi.mock('../runtime/crypto.js', () => ({ forgetRelayPairing: vi.fn() }));

import { resetClientStoreForTest, useClientStore } from '../app/store.js';
import { writeComputerAppearances } from '../room/ComputerChoice.js';
import { RecoveryCard } from './RecoveryCard.js';
import {
  loadingPillState,
  RecoveryOverlay,
  type LoadingPillInputs,
} from './RecoveryOverlay.js';

afterEach(() => {
  sessions.managed = true;
  sessions.manager.getSnapshot.mockReturnValue({ activeId: undefined, computers: [] });
  sessions.manager.forget.mockClear();
  sessions.manager.active.mockClear();
  resetClientStoreForTest();
  document.body.innerHTML = '';
  window.localStorage.clear();
});

function hydrateCachedUnit(): void {
  useClientStore.getState().hydrateLastGoodRoom(
    {
      id: 'room-a', name: 'Room A', created_ts: '2026-08-10T00:00:00.000Z',
      config: { turn_brake: null, spend_brake_usd: null, stall_minutes: 30, redaction_enabled: true, bridged: false },
    },
    [],
    {
      messages: {}, journals: {}, units: [{ kind: 'message', message_id: 1 }],
      beforeCursor: null, hasMore: false,
    },
  );
}

// harn:assume prioritized-room-loading-pill-uses-existing-readiness ref=loading-pill-unit-regression
describe('prioritized room loading pill', () => {
  const base: LoadingPillInputs = {
    connectionState: 'online',
    connected: true,
    readableReconnect: false,
    roomHydrated: true,
    roomReady: true,
    loadingHead: false,
    loadingCursor: undefined,
  };

  it('projects each existing state and keeps the first true state', () => {
    expect(loadingPillState({ ...base, connected: false, readableReconnect: true })).toBe('reconnecting');
    expect(loadingPillState({ ...base, roomHydrated: false })).toBe('channel');
    expect(loadingPillState({ ...base, roomReady: false })).toBe('channel');
    expect(loadingPillState({ ...base, loadingHead: true })).toBe('syncing');
    expect(loadingPillState({ ...base, loadingCursor: 'older-1' })).toBe('older');
    expect(loadingPillState({ ...base, loadingHead: true, loadingCursor: 'older-1' })).toBe('syncing');
    expect(loadingPillState({ ...base, roomReady: false, loadingHead: true, loadingCursor: 'older-1' })).toBe('channel');
    expect(loadingPillState(base)).toBeUndefined();
  });

  it('does not show the reconnect pill for a non-readable direct failure', () => {
    expect(loadingPillState({
      ...base,
      connectionState: 'agent-offline',
      connected: false,
    })).toBeUndefined();
  });

  it('renders the existing history-head signal as one syncing pill', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    hydrateCachedUnit();
    useClientStore.getState().setConnected(true);
    useClientStore.getState().markRoomLive('room-a');
    useClientStore.getState().updateTranscriptHistory('room-a', (history) => ({ ...history, loadingHead: true }));
    connection.state = 'online';
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(<RecoveryOverlay><p>room</p></RecoveryOverlay>); });
    const pill = host.querySelector<HTMLElement>('[data-testid="reconnecting-pill"]');
    expect(pill?.dataset.loadingState).toBe('syncing');
    expect(pill?.textContent).toContain('Syncing messages');
    expect(host.querySelectorAll('[data-loading-state]')).toHaveLength(1);
    await act(async () => { root.unmount(); });
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
// harn:end prioritized-room-loading-pill-uses-existing-readiness

// harn:assume readable-reconnecting-room-never-admits-mutation ref=nonmodal-reconnecting-regression
describe('RecoveryOverlay readable reconnect', () => {
  it('keeps retained content nonmodal, preserves read controls, and disables mutations', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    hydrateCachedUnit();
    connection.state = 'agent-offline';
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <RecoveryOverlay>
          <button data-testid="toggle-message-search">Search</button>
          <button data-testid="send">Send</button>
        </RecoveryOverlay>,
      );
    });

    expect(host.querySelector('[data-testid="reconnecting-pill"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="recovery"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="toggle-message-search"]')?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="send"]')?.disabled).toBe(true);

    await act(async () => { root.unmount(); });
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps terminal pairing failure modal even when retained content exists', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    hydrateCachedUnit();
    connection.state = 'pairing-dead';
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(<RecoveryOverlay><p>cached</p></RecoveryOverlay>); });
    expect(host.querySelector('[data-testid="recovery"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="reconnecting-pill"]')).toBeNull();
    await act(async () => { root.unmount(); });
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('leaves the direct reconnect presentation unchanged', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    hydrateCachedUnit();
    sessions.managed = false;
    connection.state = 'agent-offline';
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(<RecoveryOverlay><p>retained direct room</p></RecoveryOverlay>); });
    expect(host.querySelector('[data-testid="recovery"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="reconnecting-pill"]')).toBeNull();
    await act(async () => { root.unmount(); });
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  // harn:assume computer-appearance-is-purged-on-forget ref=appearance-forget-recovery-regression
  it('purges the active computer appearance when recovery drives Forget', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    sessions.manager.getSnapshot.mockReturnValue({
      activeId: 'A',
      computers: [
        { id: 'A', label: 'Desk', active: true, ready: true, connected: false, authRefused: false, unread: 0, attention: false, working: 0 },
        { id: 'B', label: 'Laptop', active: false, ready: true, connected: true, authRefused: false, unread: 0, attention: false, working: 0 },
      ],
    });
    writeComputerAppearances({
      A: { glyph: '🐈', color: '#0f766e' },
      B: { glyph: '🚀', color: '#15803d' },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(<RecoveryCard state="pairing-dead" presentation="fullscreen" />); });
    await act(async () => { (host.querySelector('[data-testid="recovery-repair"]') as HTMLButtonElement).click(); });
    expect(sessions.manager.forget).toHaveBeenCalledWith('A');
    expect(JSON.parse(window.localStorage.getItem('codor.computer-appearance.v1') ?? '{}')).toEqual({
      B: { glyph: '🚀', color: '#15803d' },
    });
    await act(async () => { root.unmount(); });
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  // harn:end computer-appearance-is-purged-on-forget
});
// harn:end readable-reconnecting-room-never-admits-mutation
