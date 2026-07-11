import type { WireEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import { formatRunDuration, mergeRunEvents, presentRunEvents } from './run-presenter.js';

const indexed = (events: WireEvent[]) => events.map((event, index) => ({ event, index }));

describe('run presenter', () => {
  // harn:assume normalized-run-items-presented-live ref=normalized-run-presenter
  it('pairs tool calls and results while preserving interleaved prose', () => {
    const rows = presentRunEvents(indexed([
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'Checking ' } },
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'the suite.' } },
      {
        type: 'run.item', item_type: 'tool_call',
        payload: { call_id: 'bash-1', tool: 'Bash', title: 'pnpm test --filter web' },
      },
      {
        type: 'run.item', item_type: 'tool_result',
        payload: { call_id: 'bash-1', status: 'ok', output_text: 'passed', duration_ms: 2100 },
      },
      {
        type: 'run.item', item_type: 'file_change',
        payload: {
          path: 'src/App.tsx', change: 'modified',
          diff: { path: 'src/App.tsx', unified: '--- a/src/App.tsx\n+++ b/src/App.tsx\n-old\n+new\n+more\n' },
        },
      },
    ]));

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: 'prose', text: 'Checking the suite.' });
    expect(rows[1]).toMatchObject({
      icon: 'terminal', title: 'Bash', detail: 'pnpm test --filter web', status: 'ok', duration_ms: 2100,
      output_text: 'passed', eventIndex: 2, resultEventIndex: 3,
    });
    expect(rows[2]).toMatchObject({
      icon: 'edit', title: 'Edit', detail: 'src/App.tsx · +2 -1', status: 'ok',
    });
  });

  it('degrades malformed third-party payloads to explicit generic rows', () => {
    expect(presentRunEvents(indexed([
      { type: 'run.item', item_type: 'tool_call', payload: { provider_shape: true } },
      { type: 'run.started', member: '01ARZ3NDEKTSV4RRFFQ69G5FAV', trigger_msg: 1 },
    ]))).toEqual([
      expect.objectContaining({ title: 'Tool call', icon: 'generic', status: 'info' }),
    ]);
  });
  // harn:end normalized-run-items-presented-live

  it('merges a stale journal and capped live tail by absolute event index', () => {
    const first: WireEvent = { type: 'run.item', item_type: 'text_delta', payload: { text: 'first' } };
    const second: WireEvent = { type: 'run.item', item_type: 'text_delta', payload: { text: 'second' } };
    const third: WireEvent = { type: 'run.item', item_type: 'text_delta', payload: { text: 'third' } };
    expect(mergeRunEvents([first, second], { events: [second, third], dropped_count: 1 })).toEqual([
      { index: 0, event: first },
      { index: 1, event: second },
      { index: 2, event: third },
    ]);
  });

  it('formats elapsed durations without viewport-dependent sizing', () => {
    expect(formatRunDuration(900)).toBe('0s');
    expect(formatRunDuration(62_900)).toBe('1m02s');
  });
});
