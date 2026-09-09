// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { createClientStore } from '../app/store.js';
import { archiveConnectionReady, canArchiveChannel, nextRoomAfterArchive } from './RoomPage.js';

describe('channel archive rail helpers', () => {
  it('uses the captured connection readiness and never treats offline as ready', () => {
    const connected = { state: () => 'connected' as const, roomReadiness: () => 'unsubscribed' as const };
    const connecting = { state: () => 'connected' as const, roomReadiness: () => 'connecting' as const };
    const offline = { state: () => 'disconnected' as const, roomReadiness: () => 'offline' as const };

    expect(archiveConnectionReady(connected, 'ops')).toBe(true);
    expect(archiveConnectionReady(connecting, 'ops')).toBe(false);
    expect(archiveConnectionReady(offline, 'ops')).toBe(false);
  });

  it('falls back to the next authorized row without inventing an empty room', () => {
    expect(nextRoomAfterArchive([{ id: 'eng' }, { id: 'ops' }], 'eng')).toBe('ops');
    expect(nextRoomAfterArchive([{ id: 'eng' }], 'eng')).toBeUndefined();
  });

  // harn:assume channel-archive-ui-captures-source-and-authoritative-result ref=channel-archive-action-regression
  it('uses the target room role when it is already hydrated', () => {
    const store = createClientStore();
    store.getState().applyFrame({ type: 'self', room: 'eng', member_id: 'human' });
    store.getState().applyFrame({
      type: 'member', room: 'eng', seq: 1,
      member: { id: 'human', kind: 'human', role: 'owner' },
    } as never);
    store.getState().applyFrame({ type: 'sync_complete', room: 'eng', seq: 1 });
    expect(canArchiveChannel(store, 'eng', false)).toBe(true);

    store.getState().applyFrame({ type: 'self', room: 'ops', member_id: 'ops-human' });
    store.getState().applyFrame({
      type: 'member', room: 'ops', seq: 1,
      member: { id: 'ops-human', kind: 'human', role: 'observer' },
    } as never);
    store.getState().applyFrame({ type: 'sync_complete', room: 'ops', seq: 1 });
    expect(canArchiveChannel(store, 'ops', true)).toBe(false);
    expect(canArchiveChannel(store, 'unknown', true)).toBe(true);
  });
  // harn:end channel-archive-ui-captures-source-and-authoritative-result
});
