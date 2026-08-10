// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const connection = vi.hoisted(() => ({ state: 'agent-offline' as string, downMs: 10_000 }));
const sessions = vi.hoisted(() => ({ managed: true }));
vi.mock('../app/use-connection-state.js', () => ({ useConnectionState: () => connection }));
vi.mock('../app/computer-sessions.js', () => ({ computerSessions: () => sessions.managed ? {} : undefined }));

import { resetClientStoreForTest, useClientStore } from '../app/store.js';
import { RecoveryOverlay } from './RecoveryOverlay.js';

afterEach(() => {
  sessions.managed = true;
  resetClientStoreForTest();
  document.body.innerHTML = '';
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
});
// harn:end readable-reconnecting-room-never-admits-mutation
