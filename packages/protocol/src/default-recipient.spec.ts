import type { Member } from './member.js';
import { describe, expect, it } from 'vitest';

import { effectiveDefaultAgent } from './default-recipient.js';

const agent = (id: string, handle: string, state: Member['state'] = 'idle'): Member => ({
  id,
  kind: 'agent',
  handle,
  display_name: handle,
  state,
  conventions_sent: false,
  misaddressed: false,
  roster_stale: true,
});

// harn:assume default-recipient-fallback-chain ref=effective-default-agent-regression
describe('effectiveDefaultAgent', () => {
  it('preserves the latest finalized active agent as first precedence', () => {
    const codor = agent('01ARZ3NDEKTSV4RRFFQ69G5AAA', 'codor');
    const tester = agent('01ARZ3NDEKTSV4RRFFQ69G5AAB', 'tester');
    expect(effectiveDefaultAgent({
      members: [codor, tester],
      latestFinalizedAgentId: tester.id,
      startingAgentHandle: 'codor',
    })).toBe(tester);
  });

  it('uses the live configured starting agent before a sole-agent fallback', () => {
    const codor = agent('01ARZ3NDEKTSV4RRFFQ69G5AAC', 'codor');
    const tester = agent('01ARZ3NDEKTSV4RRFFQ69G5AAD', 'tester');
    expect(effectiveDefaultAgent({
      members: [codor, tester],
      startingAgentHandle: 'codor',
    })).toBe(codor);
  });

  it('uses the sole live agent when no configured starting agent is live', () => {
    const codor = agent('01ARZ3NDEKTSV4RRFFQ69G5AAE', 'codor', 'dead');
    const tester = agent('01ARZ3NDEKTSV4RRFFQ69G5AAF', 'tester');
    expect(effectiveDefaultAgent({
      members: [codor, tester],
      startingAgentHandle: 'codor',
    })).toBe(tester);
  });

  it('excludes removed agents and returns none for multiple unconfigured live agents', () => {
    const removed = {
      ...agent('01ARZ3NDEKTSV4RRFFQ69G5AAG', 'codor'),
      removed_ts: '2026-07-12T00:00:00.000Z',
    };
    const tester = agent('01ARZ3NDEKTSV4RRFFQ69G5AAH', 'tester');
    const writer = agent('01ARZ3NDEKTSV4RRFFQ69G5AAJ', 'writer');
    expect(effectiveDefaultAgent({
      members: [removed, tester],
      startingAgentHandle: 'codor',
    })).toBe(tester);
    expect(effectiveDefaultAgent({ members: [tester, writer] })).toBeUndefined();
    expect(effectiveDefaultAgent({ members: [] })).toBeUndefined();
  });
});
// harn:end default-recipient-fallback-chain
