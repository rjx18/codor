import type { WireEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import {
  compactRunRow,
  diffStat,
  formatRunDuration,
  mergeRunEvents,
  middleEllipsis,
  presentRunEvents,
  type RunRow,
} from './run-presenter.js';

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

// harn:assume compact-one-line-tool-rows ref=compact-run-row-regression
describe('compact one-line tool rows', () => {
  const row = (over: Partial<RunRow>): RunRow => ({
    id: 'r', eventIndex: 0, kind: 'tool', icon: 'tool', title: 'Tool',
    status: 'ok', event: {} as never, ...over,
  });

  it('shows the verbatim command a shell tool ran', () => {
    expect(compactRunRow(row({ title: 'Bash', detail: 'pnpm test --filter web' })))
      .toEqual({ icon: 'terminal', label: 'pnpm test --filter web', mono: true });
  });

  it('shows the file a read-like tool explored, not its path', () => {
    expect(compactRunRow(row({ title: 'Read', detail: '/home/richard/git/codor/src/App.tsx' })))
      .toMatchObject({ icon: 'search', label: 'Explored App.tsx' });
  });

  it('shows a diff as its added and removed counts against the file', () => {
    const unified = [
      '--- a/src/shell.tsx', '+++ b/src/shell.tsx',
      '@@ -1,2 +1,3 @@', ' keep', '-gone', '+added', '+added too',
    ].join('\n');
    expect(compactRunRow(row({ title: 'Edit', diff: { path: 'src/shell.tsx', unified } as never })))
      .toEqual({ icon: 'edit', label: '+2 −1 shell.tsx', mono: true });
  });

  it('does not count the diff file headers as changed lines', () => {
    const { added, removed } = diffStat('--- a/x\n+++ b/x\n+one\n-two\n');
    expect({ added, removed }).toEqual({ added: 1, removed: 1 });
  });

  it('names the tool and its title when it is nothing more specific', () => {
    expect(compactRunRow(row({ title: 'Task', detail: 'spawn a reviewer' })))
      .toMatchObject({ label: 'Task: spawn a reviewer' });
  });

  it('recognises the shell tools other harnesses actually emit', () => {
    // Codex says local_shell; Gemini says run_shell_command. Exact-matching "bash"
    // would drop both to the generic branch and lose the verbatim command.
    for (const tool of ['Bash', 'local_shell', 'run_shell_command', 'shell']) {
      expect(compactRunRow(row({ title: tool, detail: 'ls -la' })), tool)
        .toMatchObject({ icon: 'terminal', label: 'ls -la', mono: true });
    }
  });

  it('recognises the read tools other harnesses actually emit', () => {
    for (const tool of ['Read', 'read_file', 'read_many_files', 'list_directory', 'search_file_content']) {
      expect(compactRunRow(row({ title: tool, detail: '/a/b/App.tsx' })), tool)
        .toMatchObject({ label: 'Explored App.tsx' });
    }
  });

  it('says a file was deleted rather than showing it as an edit of nothing', () => {
    const unified = '--- a/gone.ts\n+++ /dev/null\n-one\n-two\n';
    expect(compactRunRow(row({ title: 'Delete', diff: { path: 'src/gone.ts', unified } as never })))
      .toMatchObject({ label: 'Deleted gone.ts' });
  });

  it('counts a content line that begins with a plus as an addition', () => {
    // `+++i;` is real C. Only `+++ ` with a space is a file header.
    expect(diffStat('--- a/x.c\n+++ b/x.c\n++++i;\n---j;\n')).toEqual({ added: 1, removed: 1 });
  });

  it('does not split an emoji when it elides', () => {
    const label = middleEllipsis(`echo ${'🙂'.repeat(60)} done`, 20);
    expect(label).not.toContain('\uFFFD');
    expect([...label]).toHaveLength(20);
  });

  it('elides a long command in the middle, keeping both ends legible', () => {
    const long = `pnpm ${'x'.repeat(120)} --end`;
    const { label } = compactRunRow(row({ title: 'Bash', detail: long }));
    expect(label).toHaveLength(80);
    expect(label.startsWith('pnpm ')).toBe(true);
    expect(label.endsWith('--end')).toBe(true);
    expect(label).toContain('…');
  });

  it('leaves a short command untouched', () => {
    expect(middleEllipsis('ls -la')).toBe('ls -la');
  });
});
