import type { Delivery } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import {
  composeGroupRoundPayload,
  deliveryBatchClass,
  selectDeliveryBatchPrefix,
} from './collaboration.js';

const delivery = (
  id: string,
  group?: { id: string; round: number },
): Delivery => ({
  id,
  room: 'eng',
  message_id: 1,
  recipient: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  state: 'queued',
  attempt_count: 0,
  ...(group && { group_id: group.id, group_round: group.round }),
  ts: '2026-07-14T12:00:00.000Z',
});

// harn:assume group-round-payloads-share-one-ordered-view ref=group-round-payload-goldens
// harn:assume group-round-routing-instruction-is-always-on ref=group-routing-instruction-regression
describe('group round payload composition', () => {
  const context = {
    groupId: 'group-1',
    roundNumber: 2,
    room: 'eng',
    root: {
      messageId: 4,
      authorHandle: 'richard',
      body: '@alpha @beta investigate #2 with [[risk]]',
    },
    refs: [{
      id: 2,
      authorHandle: 'richard',
      ts: '2026-07-14T11:27:42.000Z',
      body: 'Earlier evidence.',
    }],
    ledgerRefs: [{ name: 'risk', body: 'Do not duplicate work.' }],
    priorRoundNumber: 1,
    results: [
      { ordinal: 4, memberHandle: 'echo', status: 'skipped' as const },
      {
        ordinal: 0,
        memberHandle: 'alpha',
        status: 'completed' as const,
        messageId: 5,
        body: 'Alpha found the cause. @gamma inspect it.',
      },
      {
        ordinal: 2,
        memberHandle: 'charlie',
        status: 'failed' as const,
      },
      {
        ordinal: 1,
        memberHandle: 'beta',
        status: 'acknowledged' as const,
        messageId: 6,
        body: '<ACK_OK>',
      },
      {
        ordinal: 3,
        memberHandle: 'delta',
        status: 'interrupted' as const,
      },
    ],
  };

  it('renders root context and every terminal result in participant ordinal', () => {
    const payload = composeGroupRoundPayload(context, 'gamma');
    expect(payload).toBe(
      '[codor group=group-1 round=2 channel=eng\n' +
      ' root=#4 - you=@gamma]\n\n' +
      '--- group request #4 - @richard ---\n' +
      '@alpha @beta investigate #2 with [[risk]]\n' +
      '--- end group request ---\n\n' +
      '--- referenced #2 - @richard - 2026-07-14T11:27Z ---\n' +
      'Earlier evidence.\n' +
      '--- end reference ---\n\n' +
      '--- ledger [[risk]] ---\n' +
      'Do not duplicate work.\n' +
      '--- end ledger note ---\n\n' +
      '--- completed round 1 result 1/5 - @alpha - completed - #5 ---\n' +
      'Alpha found the cause. @gamma inspect it.\n' +
      '--- end result ---\n\n' +
      '--- completed round 1 result 2/5 - @beta - acknowledged - #6 ---\n' +
      '[@beta acknowledged; no substantive response.]\n' +
      '--- end result ---\n\n' +
      '--- completed round 1 result 3/5 - @charlie - failed ---\n' +
      '[No final response. The run failed.]\n' +
      '--- end result ---\n\n' +
      '--- completed round 1 result 4/5 - @delta - interrupted ---\n' +
      '[No final response. The run was interrupted.]\n' +
      '--- end result ---\n\n' +
      '--- completed round 1 result 5/5 - @echo - skipped ---\n' +
      '[No turn started. The member was removed or unavailable.]\n' +
      '--- end result ---\n\n' +
      '[group routing: all participants in this round run independently. Your normal final reply ' +
      'posts to the channel immediately; peer agents receive all terminal results together only as ' +
      'the next-round context after this round ends. Use codor post only for an immediate in-round ' +
      'update, question, or answer. An @mention in your final response starts another paid group ' +
      "round, so use one only when you genuinely intend to invoke that member; write the member's " +
      'plain name without @ when merely discussing them. If every peer you are waiting on finishes ' +
      'without an interim reply, Codor ends the wait automatically. Use <ACK_OK> as your entire ' +
      'onward response only when no action and no answer are needed; never append it after doing ' +
      'work or as a sign-off.]\n',
    );
    expect(payload).not.toContain('\n<ACK_OK>\n');
  });

  // harn:assume group-routing-briefing-names-cost-and-wait-outcome ref=group-routing-cost-wait-regression
  it('names the paid next round and automatic terminal-peer wait outcome', () => {
    const payload = composeGroupRoundPayload(context, 'gamma');
    expect(payload).toContain('starts another paid group round');
    expect(payload).toContain('Codor ends the wait automatically');
  });
  // harn:end group-routing-briefing-names-cost-and-wait-outcome

  it('changes composed bytes between recipients only at the you field', () => {
    const alpha = composeGroupRoundPayload(context, 'alpha');
    const gamma = composeGroupRoundPayload(context, 'gamma');
    expect(alpha.replace('you=@alpha', 'you=@recipient'))
      .toBe(gamma.replace('you=@gamma', 'you=@recipient'));
  });
});
// harn:end group-round-routing-instruction-is-always-on
// harn:end group-round-payloads-share-one-ordered-view

// harn:assume grouped-deliveries-have-an-isolated-batch-class ref=group-delivery-batch-regression
describe('group delivery batching', () => {
  it('classifies ordinary work separately from an exact group and round', () => {
    expect(deliveryBatchClass(delivery('ordinary'))).toEqual({ kind: 'ordinary' });
    expect(deliveryBatchClass(delivery('grouped', { id: 'group-1', round: 2 }))).toEqual({
      kind: 'group',
      groupId: 'group-1',
      roundNumber: 2,
    });
  });

  it('takes only the FIFO-contiguous prefix matching the first delivery class', () => {
    const ordinaryA = delivery('ordinary-a');
    const ordinaryB = delivery('ordinary-b');
    const groupOneA = delivery('group-1-a', { id: 'group-1', round: 1 });
    const groupOneB = delivery('group-1-b', { id: 'group-1', round: 1 });
    const groupTwo = delivery('group-2', { id: 'group-1', round: 2 });

    expect(selectDeliveryBatchPrefix([ordinaryA, ordinaryB, groupOneA, ordinaryB]))
      .toEqual([ordinaryA, ordinaryB]);
    expect(selectDeliveryBatchPrefix([groupOneA, groupOneB, groupTwo, ordinaryA]))
      .toEqual([groupOneA, groupOneB]);
    expect(selectDeliveryBatchPrefix([])).toEqual([]);
  });
});
// harn:end grouped-deliveries-have-an-isolated-batch-class
