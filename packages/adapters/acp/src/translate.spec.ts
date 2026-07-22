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
      usage: {
        totalTokens: 20, inputTokens: 10, outputTokens: 5,
        cachedReadTokens: 3, cachedWriteTokens: 2,
      },
    })).toMatchObject({
      events: [expect.objectContaining({
        type: 'run.completed',
        status: 'completed',
        usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5 },
      })],
      baseline: { totalTokens: 20, inputTokens: 10, outputTokens: 5 },
    });
  });

  it('derives non-overlapping turn usage and treats lower totals as a reset', () => {
    const translator = createAcpTurnTranslator();
    const previous = {
      totalTokens: 20, inputTokens: 10, outputTokens: 5,
      cachedReadTokens: 3, cachedWriteTokens: 2,
    };
    const second = translator.complete({
      stopReason: 'end_turn',
      usage: {
        totalTokens: 33, inputTokens: 16, outputTokens: 9,
        cachedReadTokens: 5, cachedWriteTokens: 3,
      },
    }, previous);
    expect(second.events[0]).toMatchObject({
      usage: { input_tokens: 6, cached_input_tokens: 2, output_tokens: 4 },
    });
    const reset = translator.complete({
      stopReason: 'end_turn',
      usage: { totalTokens: 8, inputTokens: 4, outputTokens: 2, cachedReadTokens: 2 },
    }, second.baseline);
    expect(reset.events[0]).toMatchObject({
      usage: { input_tokens: 4, cached_input_tokens: 2, output_tokens: 2 },
    });
  });

  it('does not recharge an identical cumulative snapshot', () => {
    const baseline = {
      totalTokens: 20, inputTokens: 10, outputTokens: 5,
      cachedReadTokens: 3, cachedWriteTokens: 2,
    };
    const repeated = createAcpTurnTranslator().complete({
      stopReason: 'end_turn',
      usage: {
        totalTokens: 20, inputTokens: 10, outputTokens: 5,
        cachedReadTokens: 3, cachedWriteTokens: 2,
      },
    }, baseline);
    expect(repeated.events[0]).toMatchObject({
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(repeated.events[0]).not.toHaveProperty('usage.cached_input_tokens');
  });

  it('does not infer file deletion from an edit whose resulting content is empty', () => {
    const translator = createAcpTurnTranslator();
    translator.push({
      sessionUpdate: 'tool_call', toolCallId: 'empty', title: 'Empty', kind: 'edit', status: 'in_progress',
    });
    expect(translator.push({
      sessionUpdate: 'tool_call_update', toolCallId: 'empty', status: 'completed',
      content: [{ type: 'diff', path: 'empty.txt', oldText: 'old\n', newText: '' }],
    })).toContainEqual(expect.objectContaining({
      item_type: 'file_change', payload: expect.objectContaining({ change: 'modified' }),
    }));
  });

  it('maps refusal, cancellation, and limit stops to honest terminal outcomes', () => {
    expect(createAcpTurnTranslator().complete({ stopReason: 'refusal' }).events[0]).toMatchObject({
      status: 'failed', error: 'ACP agent refused the turn',
    });
    expect(createAcpTurnTranslator().complete({ stopReason: 'cancelled' }).events[0]).toMatchObject({
      status: 'interrupted',
    });
    expect(createAcpTurnTranslator().complete({ stopReason: 'max_tokens' }).events[0]).toMatchObject({
      status: 'interrupted', error: expect.stringContaining('token limit'),
    });
    expect(createAcpTurnTranslator().complete({ stopReason: 'max_turn_requests' }).events[0]).toMatchObject({
      status: 'interrupted', error: expect.stringContaining('turn request limit'),
    });
  });
});
