import { describe, expect, it } from 'vitest';

import {
  BAD_CODE_THRESHOLD_MS,
  EXTENDED_THRESHOLD_MS,
  classifyPairingTime,
  classifySession,
  type SessionSignals,
} from './connection-state.js';

const base: SessionSignals = {
  connected: false,
  navigatorOnLine: true,
  authRefused: false,
  downMs: 0,
  extendedThresholdMs: EXTENDED_THRESHOLD_MS,
};

describe('classifySession', () => {
  it('is online whenever the session is connected', () => {
    // Even with every offline signal set, a live session wins.
    expect(classifySession({ ...base, connected: true, navigatorOnLine: false, authRefused: true }))
      .toBe('online');
  });

  it('reports device-offline when the device network is down, above all offline causes', () => {
    // device-offline outranks a positive auth refusal: never blame the pairing
    // when the device itself is offline.
    expect(classifySession({ ...base, navigatorOnLine: false, authRefused: true })).toBe('device-offline');
  });

  it('reports pairing-dead only on a positive auth refusal (device online)', () => {
    expect(classifySession({ ...base, authRefused: true })).toBe('pairing-dead');
  });

  it('reports agent-offline while the host is merely absent within the threshold', () => {
    expect(classifySession({ ...base, downMs: EXTENDED_THRESHOLD_MS - 1 })).toBe('agent-offline');
  });

  it('escalates to the dual-path agent-offline-extended at the threshold, not pairing-dead', () => {
    // The crux: long absence never becomes pairing-dead without positive evidence.
    expect(classifySession({ ...base, downMs: EXTENDED_THRESHOLD_MS })).toBe('agent-offline-extended');
    expect(classifySession({ ...base, downMs: EXTENDED_THRESHOLD_MS * 10 })).toBe('agent-offline-extended');
  });
});

describe('classifyPairingTime', () => {
  it('stays joining while the host may still answer', () => {
    expect(classifyPairingTime({ failed: false, waitingMs: BAD_CODE_THRESHOLD_MS - 1, badCodeThresholdMs: BAD_CODE_THRESHOLD_MS }))
      .toBe('joining');
  });

  it('reports code-bad on an explicit failure', () => {
    expect(classifyPairingTime({ failed: true, waitingMs: 0, badCodeThresholdMs: BAD_CODE_THRESHOLD_MS }))
      .toBe('code-bad');
  });

  it('reports code-bad when the host never joins the room past the threshold', () => {
    expect(classifyPairingTime({ failed: false, waitingMs: BAD_CODE_THRESHOLD_MS, badCodeThresholdMs: BAD_CODE_THRESHOLD_MS }))
      .toBe('code-bad');
  });
});
