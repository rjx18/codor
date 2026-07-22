import { readFileSync } from 'node:fs';

import { parseRunItemPayload, type WireEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import {
  agentUsageFromTokenUsage,
  createTurnTranslator,
} from './translate.js';

interface FixtureNotification {
  method: string;
  params?: unknown;
}

function fixture(name: string): FixtureNotification[] {
  return readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as FixtureNotification);
}

function replay(messages: FixtureNotification[]): WireEvent[] {
  const translator = createTurnTranslator();
  const events = messages.flatMap((message) => translator.push(message.method, message.params));
  events.push(...translator.end());
  for (const event of events) {
    if (event.type === 'run.item') {
      expect(parseRunItemPayload(event.item_type, event.payload).success).toBe(true);
    }
  }
  return events;
}

const completed = (events: WireEvent[]) =>
  events.find((event) => event.type === 'run.completed') as Extract<
    WireEvent,
    { type: 'run.completed' }
  >;

describe('Codex 0.144.5 app-server fixture translation', () => {
  const events = replay(fixture('app-server-turn.jsonl'));

  it('preserves normalized reasoning, command, file, and final text items', () => {
    expect(events).toContainEqual({
      type: 'run.item',
      item_type: 'reasoning_summary',
      payload: { text: 'Inspecting the fixture' },
    });
    expect(events).toContainEqual({
      type: 'run.item',
      item_type: 'tool_call',
      payload: {
        call_id: 'command-1',
        tool: 'Bash',
        title: 'pwd',
        input: { command: 'pwd' },
      },
    });
    expect(events).toContainEqual({
      type: 'run.item',
      item_type: 'tool_result',
      payload: expect.objectContaining({
        call_id: 'command-1',
        status: 'ok',
        output_text: '/work\n',
        duration_ms: 12,
      }),
    });
    expect(events).toContainEqual({
      type: 'run.item',
      item_type: 'tool_call',
      payload: {
        call_id: 'change-1',
        tool: 'Write',
        title: '/work/new.txt',
        input: { file_path: '/work/new.txt', change: 'created' },
      },
    });
    expect(events).toContainEqual({
      type: 'run.item',
      item_type: 'tool_result',
      payload: expect.objectContaining({
        call_id: 'change-1',
        status: 'ok',
        diff: { path: '/work/new.txt', unified: '--- /dev/null\n+++ b/new.txt\n' },
      }),
    });
    expect(completed(events)).toMatchObject({
      status: 'completed',
      final_text: 'DONE',
    });
  });

  // harn:assume codex-turn-and-manual-compaction-follow-native-events ref=codex-app-server-compaction-regression
  it('deduplicates the canonical item completion and compatibility notification', () => {
    expect(events.filter((event) => event.type === 'timeline')).toEqual([
      {
        type: 'timeline',
        item: { type: 'compaction', status: 'loading', trigger: 'auto' },
      },
      {
        type: 'timeline',
        item: { type: 'compaction', status: 'completed', trigger: 'auto' },
      },
    ]);
  });

  it('also deduplicates when thread/compacted arrives before item/completed', () => {
    const events = replay([
      { method: 'item/started', params: { item: { id: 'c', type: 'contextCompaction' } } },
      { method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 'turn-1' } },
      { method: 'item/completed', params: { item: { id: 'c', type: 'contextCompaction' } } },
      {
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'completed', error: null } },
      },
    ]);
    expect(events.filter((event) => event.type === 'timeline')).toHaveLength(2);
  });
  // harn:end codex-turn-and-manual-compaction-follow-native-events

  // harn:assume normalized-agent-usage-telemetry-with-estimates ref=codex-usage-telemetry-regression
  // harn:assume codex-app-server-usage-is-context-aware-and-uncosted ref=codex-app-server-usage-regression
  it('emits live and terminal native context telemetry with no invented cost', () => {
    const expected = {
      inputTokens: 6000,
      cachedInputTokens: 3000,
      outputTokens: 1000,
      contextWindowMaxTokens: 200000,
      contextWindowUsedTokens: 7000,
    };
    expect(events).toContainEqual({ type: 'usage_updated', usage: expected });
    expect(completed(events)).toMatchObject({
      usage: { input_tokens: 6000, output_tokens: 1000 },
      agent_usage: expected,
    });
    expect(completed(events).usage).not.toHaveProperty('cost_usd');
    expect(completed(events).agent_usage).not.toHaveProperty('totalCostUsd');
  });

  it('omits both context fields when either native half is absent', () => {
    expect(agentUsageFromTokenUsage({
      last: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 2, outputTokens: 2 },
      modelContextWindow: null,
    })).toEqual({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 2 });
    expect(agentUsageFromTokenUsage({
      last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 2 },
      modelContextWindow: 200000,
    })).toEqual({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 2 });
  });
  // harn:end codex-app-server-usage-is-context-aware-and-uncosted
  // harn:end normalized-agent-usage-telemetry-with-estimates
});

describe('Codex command actions and durable file-change evidence', () => {
  const events = replay(fixture('app-server-actions.jsonl'));

  it('maps a native read action instead of flattening it to Bash', () => {
    expect(events).toContainEqual({
      type: 'run.item',
      item_type: 'tool_call',
      payload: {
        call_id: 'read-1',
        tool: 'Read',
        title: '/work/src/app.ts',
        input: {
          type: 'read',
          command: 'cat src/app.ts',
          name: 'src/app.ts',
          path: '/work/src/app.ts',
        },
      },
    });
  });

  it('pairs each file change and retains a diff with real body counts', () => {
    const calls = events.filter((event) => event.type === 'run.item' && event.item_type === 'tool_call');
    const results = events.filter((event) => event.type === 'run.item' && event.item_type === 'tool_result');
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ call_id: 'change-1:0', tool: 'Write' }) }),
      expect.objectContaining({ payload: expect.objectContaining({ call_id: 'change-1:1', tool: 'Edit' }) }),
    ]));
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          call_id: 'change-1:0',
          status: 'ok',
          diff: expect.objectContaining({ unified: expect.stringContaining('+export const one = 1;') }),
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          call_id: 'change-1:1',
          status: 'ok',
          diff: expect.objectContaining({ unified: expect.stringContaining('-export const value = 1;') }),
        }),
      }),
    ]));

    const update = results.find(
      (event) => event.type === 'run.item' && event.item_type === 'tool_result' &&
        (event.payload as { call_id?: string }).call_id === 'change-1:1',
    );
    const unified = (update?.payload as { diff?: { unified?: string } }).diff?.unified ?? '';
    const body = unified.split('\n').filter((line) => !line.startsWith('+++') && !line.startsWith('---'));
    expect(body.filter((line) => line.startsWith('+'))).toHaveLength(1);
    expect(body.filter((line) => line.startsWith('-'))).toHaveLength(1);
  });

  it.each([
    ['listFiles', { type: 'listFiles', command: 'find src', path: '/work/src' }, 'Glob', '/work/src'],
    ['search', { type: 'search', command: 'rg needle src', query: 'needle', path: '/work/src' }, 'Grep', 'needle in /work/src'],
    ['unknown', { type: 'unknown', command: 'git status' }, 'Bash', 'git status'],
  ])('maps the %s command action', (_type, action, tool, title) => {
    const translator = createTurnTranslator();
    expect(translator.push('item/started', {
      item: { type: 'commandExecution', id: `action-${_type}`, command: action.command, commandActions: [action] },
    })).toEqual([{
      type: 'run.item',
      item_type: 'tool_call',
      payload: { call_id: `action-${_type}`, tool, title, input: action },
    }]);
  });

  it('keeps multiple native actions as one honest composite shell call', () => {
    const actions = [
      { type: 'read', command: 'cat a', name: 'a', path: '/work/a' },
      { type: 'search', command: 'rg needle', query: 'needle', path: '/work' },
    ];
    const translator = createTurnTranslator();
    expect(translator.push('item/started', {
      item: { type: 'commandExecution', id: 'composite-1', command: 'cat a && rg needle', commandActions: actions },
    })).toEqual([{
      type: 'run.item',
      item_type: 'tool_call',
      payload: {
        call_id: 'composite-1',
        tool: 'Bash',
        title: 'cat a && rg needle',
        input: { command: 'cat a && rg needle', actions },
      },
    }]);
  });

  it('surfaces native file-change failure and pairs completion-only evidence', () => {
    const translator = createTurnTranslator();
    const events = translator.push('item/completed', {
      item: {
        type: 'fileChange',
        id: 'failed-change',
        status: 'failed',
        changes: [{ path: '/work/bad.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' }],
      },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ item_type: 'tool_call', payload: { call_id: 'failed-change', tool: 'Edit' } });
    expect(events[1]).toMatchObject({
      item_type: 'tool_result',
      payload: { call_id: 'failed-change', status: 'error', output_text: 'File change failed' },
    });
  });
});

describe('terminal app-server semantics', () => {
  it('keeps failure detail structurally separate from reply text', () => {
    const events = replay([{
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-failed',
          status: 'failed',
          error: { message: 'Prompt is too long' },
        },
      },
    }]);
    expect(completed(events)).toEqual({
      type: 'run.completed',
      status: 'failed',
      error: 'Prompt is too long',
    });
    expect(completed(events).final_text).toBeUndefined();
  });

  it('maps interruption and tolerates unknown or malformed notifications', () => {
    const translator = createTurnTranslator();
    expect(translator.push('future/notification', { future: true })).toEqual([]);
    expect(translator.push('item/completed', { item: null })).toEqual([]);
    expect(translator.push('turn/completed', {
      turn: { id: 'turn-interrupted', status: 'interrupted', error: null },
    })).toEqual([{ type: 'run.completed', status: 'interrupted' }]);
  });
});
