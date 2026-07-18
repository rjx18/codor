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
      item_type: 'file_change',
      payload: {
        path: '/work/new.txt',
        change: 'created',
        diff: { path: '/work/new.txt', unified: '--- /dev/null\n+++ b/new.txt\n' },
      },
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
