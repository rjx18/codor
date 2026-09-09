import { Store } from '@codor/switchboard';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';
import type { Delivery } from '@codor/protocol';
vi.mock('./markdown.js', () => ({ renderMarkdown: (body: string) => body }));
import { deliveryIndicator, TurnBlock } from './Transcript.js';

describe('handling evidence from real skipped collaboration work', () => {
  it('keeps skipped-before-start at one tick, including grouped human rows', () => {
    const store = new Store(':memory:');
    try {
      const { owner } = store.createRoom({id:'eng',name:'Eng',owner:{handle:'owner',display_name:'Owner'}});
      const dead = store.addMember('eng',{kind:'agent',handle:'dead',display_name:'Dead',state:'dead'});
      const live = store.addMember('eng',{kind:'agent',handle:'live',display_name:'Live',state:'idle'});
      const message = store.postMessage('eng',{author:owner.id,kind:'chat',body:'@dead @live work'});
      const group = store.createCollaborationGroup('eng',{groupId:'review-skip',rootMessageId:message.id,
        participants:[{memberId:dead.id,payloadSnapshot:'work'},{memberId:live.id,payloadSnapshot:'work'}]});
      const {delivery:skipped,participant} = store.skipCollaborationParticipant('eng',group.deliveries[0]!.id,new Date().toISOString());
      expect(participant.terminal_status).toBe('skipped');
      expect(skipped).toMatchObject({state:'consumed',attempt_count:0});
      expect(skipped.run_msg_id).toBeUndefined(); expect(dead.removed_ts).toBeUndefined();
      expect(deliveryIndicator([skipped]).seen).toBe(false);
      const run = store.postMessage('eng',{author:live.id,kind:'run',body:'done',run:{status:'completed',
        started_ts:new Date().toISOString(),ended_ts:new Date().toISOString(),tool_calls:0,events_ref:'runs/review.jsonl'}});
      const handled = store.updateDelivery('eng',group.deliveries[1]!.id,{state:'consumed',run_msg_id:run.id,attempt_count:1});
      expect(deliveryIndicator([skipped,handled]).seen).toBe(false);
      expect(deliveryIndicator([handled]).seen).toBe(true);
      const bothHandled = [handled,{...skipped,run_msg_id:run.id+1,attempt_count:1}];
      expect(deliveryIndicator(bothHandled).seen).toBe(true);
      const render = (deliveries:Delivery[], removed=false) => renderToStaticMarkup(<TurnBlock {...{
        message,author:owner,members:{[owner.id]:owner,[dead.id]:{...dead,...(removed&&{removed_ts:new Date().toISOString()})},[live.id]:live},
        grouped:true,mine:true,canPin:false,canDelete:false,canRetry:false,room:'eng',token:()=>'',connection:{act:vi.fn()},
        deliveries:Object.fromEntries(deliveries.map(d=>[d.id,d])),actionErrorCount:0,
      } as unknown as ComponentProps<typeof TurnBlock>} />);
      const html = render([skipped]);
      expect(html).toContain('data-seen="false"');
      expect(html).toContain('lucide-check'); expect(html).not.toContain('lucide-check-check');
      expect(html).toContain('no handling evidence');
      expect(render([handled])).toContain('lucide-check-check');
      expect(render(bothHandled)).toContain('data-seen="true"');
      expect(render([skipped],true)).toContain('data-seen="false"');
      expect(render([{...skipped,recipient:owner.id,read_ts:new Date().toISOString()}])).toContain('data-seen="false"');
      for (const state of ['queued','held'] as const) expect(deliveryIndicator([{...skipped,state}]).seen).toBe(false);
      expect(deliveryIndicator([{...skipped,steered_ts:new Date().toISOString()}]).seen).toBe(true);
    } finally { store.close(); }
  });
});
