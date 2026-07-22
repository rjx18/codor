import { describe, expect, it } from 'vitest';

import { createAcpTurnTranslator } from './translate.js';

describe('ACP event normalization', () => {
  it('maps text, plans, tools, durable diffs, context and cached usage', () => {
    const translator = createAcpTurnTranslator();
    expect(translator.push({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    })).toContainEqual({ type: 'run.item', item_type: 'text_delta', payload: { text: 'hello' } });
    expect(translator.push({
      sessionUpdate: 'plan',
      entries: [{ content: 'change it', priority: 'high', status: 'in_progress' }],
    })[0]).toMatchObject({ item_type: 'reasoning_summary', payload: { text: '[in_progress] change it' } });
    expect(translator.push({
      sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Edit', kind: 'edit', status: 'in_progress',
    })[0]).toMatchObject({ item_type: 'tool_call', payload: { call_id: 'a', tool: 'edit' } });
    const completed = translator.push({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'a',
      status: 'completed',
      content: [{ type: 'diff', path: '/work/a.txt', oldText: 'old\n', newText: 'new\n' }],
    });
    expect(completed).toContainEqual(expect.objectContaining({
      item_type: 'file_change',
      payload: expect.objectContaining({
        path: '/work/a.txt',
        diff: expect.objectContaining({ unified: expect.stringContaining('-old\n+new') }),
      }),
    }));
    expect(completed).toContainEqual(expect.objectContaining({
      item_type: 'tool_result',
      payload: expect.objectContaining({ call_id: 'a', status: 'ok' }),
    }));
    expect(translator.push({ sessionUpdate: 'usage_update', used: 25, size: 100 })).toEqual([{
      type: 'usage_updated', usage: { contextWindowUsedTokens: 25, contextWindowMaxTokens: 100 },
    }]);
    expect(translator.complete({
      stopReason: 'end_turn',
      usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5, cachedReadTokens: 3 },
    })).toEqual([expect.objectContaining({
      type: 'run.completed',
      status: 'completed',
      usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5 },
    })]);
  });

  it('maps refusal and cancellation to honest terminal outcomes', () => {
    expect(createAcpTurnTranslator().complete({ stopReason: 'refusal' })[0]).toMatchObject({
      status: 'failed', error: 'ACP agent refused the turn',
    });
    expect(createAcpTurnTranslator().complete({ stopReason: 'cancelled' })[0]).toMatchObject({
      status: 'interrupted',
    });
  });
});
