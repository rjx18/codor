import { readFileSync } from 'node:fs';

import { parseRunItemPayload, type WireEvent, WireEventSchema } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import {
  createTurnTranslator,
  diffFromToolUse,
  wireEventFromHook,
} from './translate.js';

function fixture(name: string, dir: 'fixtures' | 'test-fixtures' = 'fixtures'): string[] {
  return readFileSync(new URL(`../${dir}/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

const testFixture = (name: string): string[] => fixture(name, 'test-fixtures');

function replay(lines: string[]) {
  const translator = createTurnTranslator();
  const events: WireEvent[] = [];
  // harn:assume claude-sdk-message-contract-preserves-normalized-runs ref=claude-sdk-message-regression
  for (const line of lines) {
    try {
      events.push(...translator.push(JSON.parse(line) as object));
    } catch {
      events.push(...translator.push(line));
    }
  }
  // harn:end claude-sdk-message-contract-preserves-normalized-runs
  const tail = translator.end();
  const all = [...events, ...tail];
  for (const event of all) {
    if (event.type === 'run.item') {
      expect(parseRunItemPayload(event.item_type, event.payload).success).toBe(true);
    }
  }
  return { translator, events, all };
}

const completed = (events: WireEvent[]) =>
  events.find((e) => e.type === 'run.completed') as Extract<WireEvent, { type: 'run.completed' }>;

describe('pong fixture replay', () => {
  const { translator, all } = replay(fixture('pong.jsonl'));

  it('captures the session id as session_ref source', () => {
    expect(translator.sessionId()).toBe('ec6d311d-1205-4d48-961e-56bb0e995398');
  });

  it('normalizes assistant text and the result with cost_usd', () => {
    expect(all.filter((e) => e.type === 'run.item' && e.item_type === 'text_delta')).toEqual([
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'PONG' } },
    ]);
    const done = completed(all);
    expect(done.status).toBe('completed');
    expect(done.final_text).toBe('PONG');
    expect(done.usage!.cost_usd).toBeTypeOf('number');
    expect(done.usage!.input_tokens).toBeGreaterThan(0);
  });
});

// harn:assume normalized-agent-usage-telemetry-with-estimates ref=claude-usage-telemetry-regression
describe('usage telemetry fixture replay', () => {
  const { all } = replay(fixture('usage-telemetry.jsonl'));

  it('emits live cache-aware context usage from the curated model window', () => {
    expect(all.filter((event) => event.type === 'usage_updated')).toEqual([
      {
        type: 'usage_updated',
        usage: {
          contextWindowMaxTokens: 200_000,
          contextWindowUsedTokens: 60,
        },
      },
    ]);
  });

  it('snapshots normalized totals and lets the runtime window override the seed', () => {
    expect(completed(all).agent_usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 300,
      outputTokens: 8,
      totalCostUsd: 0.01,
      contextWindowMaxTokens: 250_000,
      // Current context is the last request, not the result's aggregate totals.
      contextWindowUsedTokens: 60,
    });
    expect(completed(all).agent_usage).not.toHaveProperty('percent');
  });

  // harn:assume context-ceiling-follows-main-model ref=claude-main-model-window-regression
  it('takes the window override from the session model, never a larger aux model', () => {
    const translator = createTurnTranslator();
    translator.push({
      type: 'system', subtype: 'init', session_id: 'session-x', model: 'claude-opus-4-8',
    });
    translator.push({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        content: [],
        usage: { input_tokens: 50_000, cache_read_input_tokens: 100_000 },
      },
    });
    const events = translator.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      usage: { input_tokens: 50_000, cache_read_input_tokens: 100_000, output_tokens: 10 },
      modelUsage: {
        'claude-opus-4-8': { contextWindow: 200_000 },
        'claude-sonnet-5': { contextWindow: 1_000_000 },
      },
    });
    const done = events.find((event) => event.type === 'run.completed');
    expect(done).toMatchObject({
      agent_usage: { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 150_000 },
    });
  });

  it('keeps the seeded window when multiple aux models report and none match the session', () => {
    const translator = createTurnTranslator();
    translator.push({
      type: 'system', subtype: 'init', session_id: 'session-y', model: 'claude-opus-4-8',
    });
    const events = translator.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      usage: { input_tokens: 10, output_tokens: 1 },
      modelUsage: {
        'claude-sonnet-5': { contextWindow: 1_000_000 },
        'claude-haiku-4-5': { contextWindow: 250_000 },
      },
    });
    const done = events.find((event) => event.type === 'run.completed');
    expect(done).toMatchObject({ agent_usage: { contextWindowMaxTokens: 200_000 } });
  });
  // harn:end context-ceiling-follows-main-model

  it('carries session and context telemetry across fresh turn translators', () => {
    const context = {};
    const first = createTurnTranslator(context);
    first.push({
      type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-sonnet-4-6',
    });
    first.push({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-6',
        content: [],
        usage: { input_tokens: 10, cache_read_input_tokens: 20 },
      },
    });
    const second = createTurnTranslator(context);
    const [done] = second.push({
      type: 'result', subtype: 'success', is_error: false, result: 'next',
      usage: { output_tokens: 2 },
    });

    expect(second.sessionId()).toBe('session-1');
    expect(done).toMatchObject({
      type: 'run.completed',
      agent_usage: {
        outputTokens: 2,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 30,
      },
    });
  });
});
// harn:end normalized-agent-usage-telemetry-with-estimates

describe('resume fixture replay', () => {
  it('--resume keeps the same session id', () => {
    expect(replay(fixture('resume.jsonl')).translator.sessionId()).toBe(
      replay(fixture('pong.jsonl')).translator.sessionId(),
    );
  });
});

describe('extensions via hooks (authoritative source)', () => {
  const [start, stop] = fixture('hooks-log.jsonl').map((l) => JSON.parse(l));

  it('SubagentStart maps to extension.started with native ids', () => {
    const event = wireEventFromHook(start);
    expect(event).toEqual({
      type: 'extension.started',
      parent: start.session_id,
      ext_member: start.agent_id,
      agent_type: 'general-purpose',
      transcript_path: start.transcript_path,
    });
    expect(WireEventSchema.safeParse(event).success).toBe(true);
  });

  it('SubagentStop maps to extension.ended with the summary', () => {
    const event = wireEventFromHook(stop);
    expect(event).toEqual({
      type: 'extension.ended',
      ext_member: stop.agent_id,
      summary: 'PONG',
      transcript_path: stop.agent_transcript_path,
    });
    expect(WireEventSchema.safeParse(event).success).toBe(true);
  });

  it('unknown hook payloads are dropped, not crashed on', () => {
    expect(wireEventFromHook({ hook_event_name: 'SessionStart' })).toBeUndefined();
    expect(wireEventFromHook({})).toBeUndefined();
  });

  it('the parent stream Task spawn is enrichment only (a tool_call run item)', () => {
    const { all } = replay(fixture('hooks-subagent.jsonl'));
    const toolCalls = all.filter(
      (e) => e.type === 'run.item' && e.item_type === 'tool_call',
    ) as Extract<WireEvent, { type: 'run.item' }>[];
    expect(toolCalls.some((e) => (e.payload as { tool?: string }).tool === 'Agent')).toBe(true);
    expect(all.some((e) => e.type === 'extension.started')).toBe(false); // never from the stream
  });
});

describe('robustness', () => {
  it('malformed and unknown lines are tolerated', () => {
    const { all } = replay([
      'garbage {{{',
      '{"type":"rate_limit_event","rate_limit_info":{}}',
      '{"type":"system","subtype":"init","session_id":"ec6d311d-1205-4d48-961e-56bb0e995398"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"OK","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.01}',
    ]);
    expect(completed(all)).toEqual({
      type: 'run.completed',
      status: 'completed',
      final_text: 'OK',
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.01 },
      agent_usage: { inputTokens: 1, outputTokens: 1, totalCostUsd: 0.01 },
    });
  });

  it('a failed result maps to status failed', () => {
    const { all } = replay([
      '{"type":"result","subtype":"error","is_error":true,"result":"boom","usage":{"input_tokens":1,"output_tokens":0}}',
    ]);
    expect(completed(all).status).toBe('failed');
  });
});

// harn:assume claude-result-errors-follow-native-signals ref=claude-result-failure-regression
describe('result failure contract', () => {
  it('classifies the contract-derived context overflow as error detail, never final text', () => {
    const { all } = replay(testFixture('context-overflow.jsonl'));
    expect(all).toContainEqual({
      type: 'run.item',
      item_type: 'text_delta',
      payload: { text: 'API Error: 400 Prompt is too long' },
    });
    expect(completed(all)).toMatchObject({
      type: 'run.completed',
      status: 'failed',
      error: 'Prompt is too long: 986729 tokens exceed the 1000000 token context window',
    });
    expect(completed(all)).not.toHaveProperty('final_text');
    expect(WireEventSchema.safeParse(completed(all)).success).toBe(true);
  });

  it('uses a non-success result subtype as a primary signal even when is_error is false', () => {
    const { all } = replay([
      '{"type":"result","subtype":"error_during_execution","is_error":false,"errors":["provider exploded"]}',
    ]);
    expect(completed(all)).toMatchObject({ status: 'failed', error: 'provider exploded' });
    expect(completed(all)).not.toHaveProperty('final_text');
  });

  it('keeps Prompt is too long as a secondary guard for legacy success-shaped output', () => {
    const { all } = replay([
      '{"type":"result","subtype":"success","is_error":false,"result":"Prompt is too long"}',
    ]);
    expect(completed(all)).toMatchObject({ status: 'failed', error: 'Prompt is too long' });
    expect(completed(all)).not.toHaveProperty('final_text');
  });

  it('never reclassifies a legitimate reply that merely mentions the overflow phrase', () => {
    const { all } = replay([
      '{"type":"result","subtype":"success","is_error":false,"result":"Heads up: the prompt is too long for this model, so I truncated it. Done."}',
    ]);
    expect(completed(all)).toMatchObject({
      status: 'completed',
      final_text: 'Heads up: the prompt is too long for this model, so I truncated it. Done.',
    });
    expect(completed(all)).not.toHaveProperty('error');
  });
});
// harn:end claude-result-errors-follow-native-signals

// harn:assume claude-compaction-follows-native-system-events ref=claude-compaction-regression
describe('compaction system-message contract', () => {
  const { events } = replay(testFixture('compaction.jsonl'));

  it('maps loading and completed boundaries for automatic and manual compaction', () => {
    expect(events.filter((event) => event.type === 'timeline')).toEqual([
      { type: 'timeline', item: { type: 'compaction', status: 'loading' } },
      {
        type: 'timeline',
        item: { type: 'compaction', status: 'completed', trigger: 'auto', preTokens: 149_900 },
      },
      { type: 'timeline', item: { type: 'compaction', status: 'loading' } },
      {
        type: 'timeline',
        item: { type: 'compaction', status: 'completed', trigger: 'manual', preTokens: 20_000 },
      },
    ]);
  });

  it('re-baselines the context gauge from each boundary post_tokens value', () => {
    expect(events.filter((event) => event.type === 'usage_updated')).toEqual([
      {
        type: 'usage_updated',
        usage: { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 18_700 },
      },
      {
        type: 'usage_updated',
        usage: { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 3_200 },
      },
    ]);
    for (const event of events) expect(WireEventSchema.safeParse(event).success).toBe(true);
  });

  it('keeps prior live usage when a boundary omits post_tokens instead of blanking the gauge', () => {
    const translator = createTurnTranslator();
    translator.push(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: '44444444-4444-4444-8444-444444444444',
      model: 'claude-haiku-4-5',
    }));
    translator.push(JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-haiku-4-5', content: [], usage: { input_tokens: 100, cache_read_input_tokens: 119_900 } },
    }));
    const boundary = translator.push(JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 120_000 },
    }));
    expect(boundary.filter((event) => event.type === 'usage_updated')).toEqual([]);
    expect(boundary[0]).toMatchObject({ item: { type: 'compaction', status: 'completed' } });
    // The live count survives: the next real growth emits from 120k, not from
    // a blanked gauge.
    const next = translator.push(JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-haiku-4-5', content: [], usage: { input_tokens: 100, cache_read_input_tokens: 129_900 } },
    }));
    expect(next.filter((event) => event.type === 'usage_updated')).toEqual([{
      type: 'usage_updated',
      usage: { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 130_000 },
    }]);
  });

  it('defaults an unrecognized native trigger to automatic, like paseo', () => {
    const translator = createTurnTranslator();
    expect(translator.push(JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'scheduled', pre_tokens: 10 },
    }))[0]).toEqual({
      type: 'timeline',
      item: { type: 'compaction', status: 'completed', trigger: 'auto', preTokens: 10 },
    });
  });
});
// harn:end claude-compaction-follows-native-system-events

describe('S1 content normalization (synthetic inline records)', () => {
  it('maps thinking blocks instead of dropping them', () => {
    const { events } = replay([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'Check the constraints.' }] },
      }),
    ]);
    expect(events).toEqual([{
      type: 'run.item',
      item_type: 'reasoning_summary',
      payload: { text: 'Check the constraints.' },
    }]);
  });

  it('pairs Edit results and synthesizes a unified file-change diff', () => {
    const expected = [
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,1 +1,1 @@',
      '-old()',
      '+new()',
      '',
    ].join('\n');
    expect(diffFromToolUse('Edit', {
      file_path: 'src/app.ts', old_string: 'old()', new_string: 'new()',
    })).toEqual({ path: 'src/app.ts', change: 'modified', unified: expected });
    const { events } = replay([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{
          type: 'tool_use', id: 'edit-1', name: 'Edit',
          input: { file_path: 'src/app.ts', old_string: 'old()', new_string: 'new()' },
        }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'Updated.' }] },
      }),
    ]);
    // ONE row per file operation: the diff-carrying tool_result is canonical, and no
    // trailing file_change duplicates it (the double row Richard reported live).
    expect(events.at(-1)).toMatchObject({
      type: 'run.item', item_type: 'tool_result',
      payload: { call_id: 'edit-1', status: 'ok', diff: { path: 'src/app.ts', unified: expected } },
    });
    expect(events.filter((e) => e.type === 'run.item' && e.item_type === 'file_change')).toEqual([]);
    // The call itself carries the real subject, not the bare tool name.
    expect(events.find((e) => e.type === 'run.item' && e.item_type === 'tool_call')).toMatchObject({
      payload: { title: 'src/app.ts' },
    });
  });

  it('titles every tool call with its subject, never the bare tool name', () => {
    const call = (name: string, input: Record<string, unknown>) => {
      const { events } = replay([JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: `t-${name}`, name, input }] },
      })]);
      const event = events.find((e) => e.type === 'run.item' && e.item_type === 'tool_call');
      return (event as { payload: { title: string } }).payload.title;
    };
    expect(call('Bash', { command: 'pnpm test --filter web' })).toBe('pnpm test --filter web');
    expect(call('Read', { file_path: '/repo/src/state.ts' })).toBe('/repo/src/state.ts');
    expect(call('Write', { file_path: 'notes.txt', content: 'hello' })).toBe('notes.txt');
    expect(call('Grep', { pattern: 'toolTitle', path: 'src' })).toBe('toolTitle in src');
    expect(call('Glob', { pattern: '**/*.spec.ts' })).toBe('**/*.spec.ts');
    expect(call('WebFetch', { url: 'https://example.com/x' })).toBe('https://example.com/x');
    expect(call('Task', { description: 'audit the cascade' })).toBe('audit the cascade');
    // Unknown tools with no recognisable subject fall back to the name.
    expect(call('MysteryTool', { whatever: 1 })).toBe('MysteryTool');
    // Long subjects are bounded.
    expect(call('Bash', { command: 'x'.repeat(500) }).length).toBeLessThanOrEqual(200);
  });

  it('extracts bounded base64 images from tool results', () => {
    const data = Buffer.from('image bytes').toString('base64');
    const { events } = replay([JSON.stringify({
      type: 'user',
      message: { content: [{
        type: 'tool_result', tool_use_id: 'read-1', content: [{
          type: 'image', source: { type: 'base64', media_type: 'image/png', data },
        }],
      }] },
    })]);
    expect(events[0]).toMatchObject({
      type: 'run.item', item_type: 'tool_result',
      payload: { call_id: 'read-1', status: 'ok', image: { media_type: 'image/png', data_b64: data } },
    });
  });

  it('truncates oversized output but preserves the original raw block', () => {
    const original = 'x'.repeat(256 * 1024 + 100);
    const { events } = replay([JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: original }] },
    })]);
    const payload = events[0]!.payload as { output_text: string; raw: { content: string } };
    expect(payload.output_text).toContain('[output truncated at 256 KiB]');
    expect(Buffer.byteLength(payload.output_text)).toBeLessThanOrEqual(256 * 1024);
    expect(payload.raw.content).toBe(original);
  });

  it('replaces images over 2 MiB with a marker', () => {
    const data = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64');
    const { events } = replay([JSON.stringify({
      type: 'user',
      message: { content: [{
        type: 'tool_result', tool_use_id: 'read-2', content: [{
          type: 'image', source: { type: 'base64', media_type: 'image/png', data },
        }],
      }] },
    })]);
    expect(events[0]!.payload).toMatchObject({
      call_id: 'read-2',
      output_text: '[image image/png, 2097153 bytes, too large to inline]',
    });
    expect(events[0]!.payload).not.toHaveProperty('image');
  });
});

describe('rate limit events (agent-usage-limits-reported-not-guessed)', () => {
  // Verbatim from the pinned raw fixtures — the CLI streams its limit windows.
  const FIXTURE_LINE =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1783684800,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false},"uuid":"db45626b-bc76-4332-9eb9-6f77682f9642","session_id":"ec6d311d-1205-4d48-961e-56bb0e995398"}';

  it('maps rate_limit_event onto one run.limits event', () => {
    const translator = createTurnTranslator();
    expect(translator.push(FIXTURE_LINE)).toEqual([
      {
        type: 'run.limits',
        limits: [
          {
            window: 'five_hour',
            status: 'allowed',
            resets_at: new Date(1783684800 * 1000).toISOString(),
          },
        ],
      },
    ]);
  });

  it.each([
    { label: 'a 0..1 fraction becomes percent', utilization: 0.86, used_percent: 86 },
    { label: 'the fraction ceiling maps to 100%', utilization: 1, used_percent: 100 },
    { label: 'zero stays zero', utilization: 0, used_percent: 0 },
    { label: 'an already-percent value above 1 is preserved', utilization: 87.5, used_percent: 87.5 },
  ])('normalizes stream utilization ($label)', ({ utilization, used_percent }) => {
    const translator = createTurnTranslator();
    const events = translator.push(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', rateLimitType: 'weekly', utilization },
    }));
    expect(events).toEqual([
      {
        type: 'run.limits',
        limits: [{ window: 'weekly', status: 'allowed_warning', used_percent }],
      },
    ]);
  });

  it.each([
    { label: 'above 100 after normalization', utilization: 150 },
    { label: 'negative', utilization: -0.1 },
    { label: 'not a number', utilization: 'lots' },
  ])('omits used_percent for unusable utilization ($label), never guessing', ({ utilization }) => {
    const translator = createTurnTranslator();
    const events = translator.push(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', rateLimitType: 'weekly', utilization },
    }));
    expect(events).toEqual([
      { type: 'run.limits', limits: [{ window: 'weekly', status: 'allowed' }] },
    ]);
  });

  it('reports nothing for shapes it does not recognize — never a guess', () => {
    const translator = createTurnTranslator();
    expect(translator.push('{"type":"rate_limit_event"}')).toEqual([]);
    expect(translator.push('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}')).toEqual([]);
  });
});

// harn:assume normalized-agent-task-updates-are-bounded-and-authoritative ref=claude-task-regression
describe('Claude task-list evidence maps to run.tasks', () => {
  const run = (name: string, input: unknown, result: string, isError = false): WireEvent[] => {
    const translator = createTurnTranslator();
    translator.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name, input }] } });
    return translator.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: result, is_error: isError }] } });
  };
  const taskUpdate = (events: WireEvent[]): unknown =>
    (events.find((event) => event.type === 'run.tasks') as { update?: unknown } | undefined)?.update;

  it('correlates a successful TaskCreate to its native id as a pending upsert', () => {
    expect(taskUpdate(run('TaskCreate', { subject: 'Wire the API', activeForm: 'Wiring the API' }, 'Task #7 created successfully.')))
      .toEqual({ op: 'upsert', items: [{ id: '7', content: 'Wire the API', status: 'pending', active_form: 'Wiring the API' }] });
  });

  it('ignores a TaskCreate whose result lacks the anchored native id prefix', () => {
    expect(taskUpdate(run('TaskCreate', { subject: 'x' }, 'Created a task for you'))).toBeUndefined();
  });

  it('applies a TaskUpdate by id and ignores an id-only update', () => {
    expect(taskUpdate(run('TaskUpdate', { taskId: '7', status: 'in_progress', activeForm: 'Doing it' }, 'ok')))
      .toEqual({ op: 'upsert', items: [{ id: '7', active_form: 'Doing it', status: 'in_progress' }] });
    expect(taskUpdate(run('TaskUpdate', { taskId: '7' }, 'ok'))).toBeUndefined();
  });

  it('replaces from TodoWrite with deterministic ids and clears on empty', () => {
    expect(taskUpdate(run('TodoWrite', { todos: [
      { content: 'A', status: 'completed', activeForm: 'Doing A' },
      { content: 'B', status: 'pending' },
    ] }, 'ok'))).toEqual({ op: 'replace', items: [
      { id: 'todo-0', content: 'A', status: 'completed', active_form: 'Doing A' },
      { id: 'todo-1', content: 'B', status: 'pending' },
    ] });
    expect(taskUpdate(run('TodoWrite', { todos: [] }, 'ok'))).toEqual({ op: 'replace', items: [] });
  });

  it('emits no task update for failed or malformed evidence', () => {
    expect(taskUpdate(run('TaskCreate', { subject: 'x' }, 'Task #7 created successfully', true))).toBeUndefined();
    expect(taskUpdate(run('TodoWrite', { todos: [{ content: 'A' }] }, 'ok'))).toBeUndefined();
    expect(taskUpdate(run('TaskUpdate', {}, 'ok'))).toBeUndefined();
  });
});
// harn:end normalized-agent-task-updates-are-bounded-and-authoritative
