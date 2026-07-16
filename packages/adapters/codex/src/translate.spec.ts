import { readFileSync } from 'node:fs';

import { parseRunItemPayload, type WireEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import { createTurnTranslator } from './translate.js';

function replay(lines: string[]): { events: WireEvent[]; threadId: string | undefined } {
  const translator = createTurnTranslator();
  const events: WireEvent[] = [];
  for (const line of lines) events.push(...translator.push(line));
  events.push(...translator.end());
  for (const event of events) {
    if (event.type === 'run.item') {
      expect(parseRunItemPayload(event.item_type, event.payload).success).toBe(true);
    }
  }
  return { events, threadId: translator.threadId() };
}

function fixture(name: string): string[] {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

const completed = (events: WireEvent[]) =>
  events.find((e) => e.type === 'run.completed') as Extract<WireEvent, { type: 'run.completed' }>;

describe('success fixture replay', () => {
  const { events, threadId } = replay(fixture('success.jsonl'));

  it('captures the thread id as the session_ref', () => {
    expect(threadId).toBe('019f4ae0-8022-7a92-b81a-60e25f3f1c22');
  });

  it('produces the golden event sequence', () => {
    expect(events).toEqual([
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'PONG' } },
      {
        type: 'run.completed',
        status: 'completed',
        final_text: 'PONG',
        usage: { input_tokens: 14146, output_tokens: 6 },
      },
    ]);
  });

  it('usage is tokens only — no cost_usd, ever', () => {
    expect(completed(events).usage).not.toHaveProperty('cost_usd');
  });
});

describe('multi-message fixture replay (command-success)', () => {
  const { events } = replay(fixture('command-success.jsonl'));

  it('maps plain shell tool calls to tool_call/tool_result run items', () => {
    expect(events).toEqual([
      {
        type: 'run.item',
        item_type: 'text_delta',
        payload: { text: 'I’ll count the entries from the requested command.' },
      },
      {
        type: 'run.item',
        item_type: 'tool_call',
        payload: {
          call_id: 'item_1',
          tool: 'Bash',
          title: '/bin/bash -lc ls',
          input: { command: '/bin/bash -lc ls' },
        },
      },
      {
        type: 'run.item',
        item_type: 'tool_result',
        payload: {
          call_id: 'item_1',
          status: 'ok',
          output_text: 'README.md\n',
          raw: {
            id: 'item_1',
            type: 'command_execution',
            command: '/bin/bash -lc ls',
            aggregated_output: 'README.md\n',
            exit_code: 0,
            status: 'completed',
          },
        },
      },
      { type: 'run.item', item_type: 'text_delta', payload: { text: '1' } },
      {
        type: 'run.completed',
        status: 'completed',
        final_text: '1',
        usage: { input_tokens: 26387, output_tokens: 110 },
      },
    ]);
  });

  it('the LAST agent message wins as final_text', () => {
    expect(completed(events).final_text).toBe('1');
  });
});

describe('failed fixture replay (failure-bogus-model)', () => {
  const { events } = replay(fixture('failure-bogus-model.jsonl'));

  it('turn.failed maps to run.completed{status:failed} carrying the error', () => {
    const done = completed(events);
    expect(done.status).toBe('failed');
    expect(done.final_text).toContain('totally-bogus-model');
    expect(done.usage).toBeUndefined();
  });

  it('item-level errors surface as run items before the failure', () => {
    expect(events[0]).toEqual({
      type: 'run.item',
      item_type: 'tool_result',
      payload: {
        call_id: 'item_0',
        status: 'error',
        output_text: expect.stringContaining('Model metadata'),
        raw: expect.objectContaining({ id: 'item_0', type: 'error' }),
      },
    });
  });
});

describe('interrupt fixture replay (SIGINT truncation)', () => {
  const { events } = replay(fixture('interrupt-sigint.jsonl'));

  it('EOF without a terminal event synthesizes status interrupted', () => {
    const done = completed(events);
    expect(done.status).toBe('interrupted');
    expect(done.usage).toBeUndefined();
  });

  it('the in-flight command is still visible as a tool_call item', () => {
    expect(events).toContainEqual({
      type: 'run.item',
      item_type: 'tool_call',
      payload: {
        call_id: 'item_1',
        tool: 'Bash',
        title: "/bin/bash -lc 'sleep 60'",
        input: { command: "/bin/bash -lc 'sleep 60'" },
      },
    });
  });
});

describe('kill/orphan and resume fixtures', () => {
  it('the SIGKILL fixture still completes (orphaned engine kept writing)', () => {
    const { events } = replay(fixture('kill-mid-turn.jsonl'));
    expect(completed(events).status).toBe('completed');
    expect(completed(events).final_text).toBe('DONE');
  });

  it('resume re-emits the SAME thread id (session_ref stability)', () => {
    expect(replay(fixture('resume.jsonl')).threadId).toBe(
      replay(fixture('success.jsonl')).threadId,
    );
    expect(replay(fixture('kill-mid-turn-resume.jsonl')).threadId).toBe(
      replay(fixture('kill-mid-turn.jsonl')).threadId,
    );
  });
});

describe('file_change item replay (live capture 2026-07-16, gpt-5.6-luna)', () => {
  // Raw lines verbatim from the paid diagnostic run (/tmp/diag-codex-raw.jsonl):
  // codex reports file operations as their own file_change items, not tool pairs.
  const capture = [
    '{"type":"thread.started","thread_id":"019f6ae9-6c1f-7d20-a9be-59bba22c7149"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll create, read, and update the file as requested."}}',
    '{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/codor-diag-codexraw-n7jC18/notes.txt","kind":"add"}],"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/codor-diag-codexraw-n7jC18/notes.txt","kind":"add"}],"status":"completed"}}',
    '{"type":"item.started","item":{"id":"item_3","type":"file_change","changes":[{"path":"/tmp/codor-diag-codexraw-n7jC18/notes.txt","kind":"update"}],"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_3","type":"file_change","changes":[{"path":"/tmp/codor-diag-codexraw-n7jC18/notes.txt","kind":"update"}],"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"DONE"}}',
    '{"type":"turn.completed","usage":{"input_tokens":49625,"cached_input_tokens":45056,"output_tokens":235,"reasoning_output_tokens":20}}',
  ];
  const { events } = replay(capture);
  const fileChanges = events.filter(
    (e) => e.type === 'run.item' && e.item_type === 'file_change',
  );

  it('emits one settled file_change run item per completed operation', () => {
    expect(fileChanges).toEqual([
      {
        type: 'run.item',
        item_type: 'file_change',
        payload: { path: '/tmp/codor-diag-codexraw-n7jC18/notes.txt', change: 'created' },
      },
      {
        type: 'run.item',
        item_type: 'file_change',
        payload: { path: '/tmp/codor-diag-codexraw-n7jC18/notes.txt', change: 'modified' },
      },
    ]);
  });

  it('item.started file_change emits nothing — completion is the single row', () => {
    const translator = createTurnTranslator();
    expect(translator.push(capture[3]!)).toEqual([]);
    expect(translator.push(capture[5]!)).toEqual([]);
  });

  it('the turn still completes normally around the file operations', () => {
    expect(completed(events).final_text).toBe('DONE');
  });
});

describe('file_change kind mapping', () => {
  const changeEvents = (changes: unknown) =>
    createTurnTranslator().push(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_9', type: 'file_change', changes, status: 'completed' },
      }),
    );

  it('maps delete to deleted and unknown kinds to modified', () => {
    expect(changeEvents([
      { path: 'a.txt', kind: 'delete' },
      { path: 'b.txt', kind: 'future_kind' },
    ])).toEqual([
      { type: 'run.item', item_type: 'file_change', payload: { path: 'a.txt', change: 'deleted' } },
      { type: 'run.item', item_type: 'file_change', payload: { path: 'b.txt', change: 'modified' } },
    ]);
  });

  it('tolerates malformed change entries silently', () => {
    expect(changeEvents([null, 42, { kind: 'add' }, 'nope'])).toEqual([]);
    expect(changeEvents(undefined)).toEqual([]);
    expect(changeEvents('not-an-array')).toEqual([]);
  });
});

describe('refused-write fixture replay (invisible unified-exec)', () => {
  it('completes normally with the agent-reported denial — no tool items', () => {
    const { events } = replay(fixture('refused-write.jsonl'));
    expect(completed(events).status).toBe('completed');
    expect(completed(events).final_text).toContain('Read-only file system');
    expect(events.filter((e) => e.type === 'run.item' && e.item_type === 'tool_call')).toEqual([]);
  });
});

describe('malformed input', () => {
  it('skips garbage lines and still completes the turn', () => {
    const { events } = replay([
      '{"type":"thread.started","thread_id":"019f4ae0-8022-7a92-b81a-60e25f3f1c22"}',
      'not json at all {{{',
      '{"type":"turn.started"}',
      '{"truncated":',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ]);
    expect(completed(events)).toEqual({
      type: 'run.completed',
      status: 'completed',
      final_text: 'OK',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  it('unknown event and item types are tolerated silently', () => {
    const { events } = replay([
      '{"type":"future.event","data":1}',
      '{"type":"item.completed","item":{"id":"item_0","type":"future_item"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ]);
    expect(events).toHaveLength(1);
    expect(completed(events).status).toBe('completed');
  });

  it('an empty stream (spawn failure shape) yields one interrupted event', () => {
    const { events } = replay([]);
    expect(events).toEqual([
      { type: 'run.completed', status: 'interrupted', final_text: undefined },
    ]);
  });
});
