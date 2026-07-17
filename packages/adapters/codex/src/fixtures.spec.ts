import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Historical raw `codex exec --json` captures from the retired per-turn
// transport. They remain immutable provenance/regression evidence, but the
// active adapter contract is the app-server fixture and fake server.

type CodexEvent = {
  type: string;
  thread_id?: string;
  usage?: Record<string, unknown>;
  error?: { message: string };
  message?: string;
  item?: {
    id: string;
    type: string;
    text?: string;
    command?: string;
    exit_code?: number | null;
    status?: string;
    aggregated_output?: string;
    changes?: Array<{ path?: string; kind?: string }>;
  };
};

function raw(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}

function events(name: string): CodexEvent[] {
  return raw(name)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CodexEvent);
}

const TOKEN_USAGE_KEYS = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
];

describe('codex fixtures parse as JSONL', () => {
  for (const name of [
    'success.jsonl',
    'resume.jsonl',
    'refused-write.jsonl',
    'interrupt-sigint.jsonl',
    'kill-mid-turn.jsonl',
    'kill-mid-turn-resume.jsonl',
  ]) {
    it(`${name} parses and starts with thread.started`, () => {
      const evs = events(name);
      expect(evs.length).toBeGreaterThan(0);
      expect(evs[0]!.type).toBe('thread.started');
      expect(evs[0]!.thread_id).toMatch(/^[0-9a-f-]{36}$/);
    });
  }
});

describe('success turn', () => {
  const evs = events('success.jsonl');

  it('delivers the final text as an agent_message item', () => {
    const messages = evs.filter((e) => e.item?.type === 'agent_message');
    expect(messages.at(-1)?.item?.text).toBe('PONG');
  });

  it('ends with turn.completed carrying token-only usage (no cost_usd)', () => {
    const last = evs.at(-1)!;
    expect(last.type).toBe('turn.completed');
    expect(Object.keys(last.usage!).sort()).toEqual([...TOKEN_USAGE_KEYS].sort());
    expect(JSON.stringify(evs)).not.toContain('cost_usd');
  });
});

describe('resume', () => {
  it('re-emits the SAME thread_id as the original session', () => {
    expect(events('resume.jsonl')[0]!.thread_id).toBe(events('success.jsonl')[0]!.thread_id);
  });

  it('retains context and completes (answered with the prior turn word)', () => {
    const evs = events('resume.jsonl');
    expect(evs.some((e) => e.item?.type === 'agent_message' && e.item.text === 'PONG')).toBe(true);
    expect(evs.at(-1)!.type).toBe('turn.completed');
  });
});

describe('read-only sandbox write refusal', () => {
  const evs = events('refused-write.jsonl');

  it('does NOT fail the turn — refusal ends in turn.completed', () => {
    expect(evs.at(-1)!.type).toBe('turn.completed');
    expect(evs.some((e) => e.type === 'turn.failed')).toBe(false);
  });

  it('the denied command is INVISIBLE on the wire (unified-exec tool emits no item)', () => {
    expect(evs.some((e) => e.item?.type === 'command_execution')).toBe(false);
    const messages = evs.filter((e) => e.item?.type === 'agent_message');
    expect(messages.at(-1)?.item?.text).toContain('Read-only file system');
  });
});

describe('CLI spawn failure (bogus flag)', () => {
  it('emits NO JSONL at all — stdout is empty', () => {
    expect(raw('failure-bogus-flag.jsonl')).toBe('');
  });

  it('reports the argv error on stderr', () => {
    expect(raw('failure-bogus-flag.stderr.txt')).toContain(
      "unexpected argument '--bogus-flag' found",
    );
  });
});

describe('SIGINT mid-turn', () => {
  const evs = events('interrupt-sigint.jsonl');

  it('truncates the stream mid-command with no terminal turn event', () => {
    const last = evs.at(-1)!;
    expect(last.type).toBe('item.started');
    expect(last.item?.type).toBe('command_execution');
    expect(last.item?.status).toBe('in_progress');
    expect(last.item?.exit_code).toBeNull();
    expect(evs.some((e) => e.type === 'turn.completed' || e.type === 'turn.failed')).toBe(false);
  });

  it('command_execution items carry the full shell invocation', () => {
    const cmd = evs.find((e) => e.item?.type === 'command_execution');
    expect(cmd?.item?.command).toContain('sleep 60');
  });
});

describe('SIGKILL mid-turn (npm shim orphans the engine)', () => {
  const evs = events('kill-mid-turn.jsonl');

  it('stream CONTINUES past the kill: the orphaned engine finishes the turn', () => {
    // The capture killed the shim during the in_progress command, yet the
    // fixture contains the command completion and turn.completed written by
    // the orphaned native binary through the inherited pipe.
    const started = evs.find((e) => e.type === 'item.started' && e.item?.type === 'command_execution');
    expect(started?.item?.status).toBe('in_progress');
    const completed = evs.find(
      (e) => e.type === 'item.completed' && e.item?.type === 'command_execution',
    );
    expect(completed?.item?.exit_code).toBe(0);
    expect(evs.at(-1)!.type).toBe('turn.completed');
  });
});

describe('file_change items (live re-probe 2026-07-16, gpt-5.6-luna)', () => {
  // Captured raw from `codex exec --json` (/tmp/diag-codex-raw.jsonl). File
  // operations are NOT tool pairs: they arrive as item.started/item.completed
  // with type "file_change" carrying changes:[{path,kind}] and NO diff body.
  const capture: CodexEvent[] = [
    '{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/codor-diag-codexraw-n7jC18/notes.txt","kind":"add"}],"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/codor-diag-codexraw-n7jC18/notes.txt","kind":"add"}],"status":"completed"}}',
    '{"type":"item.started","item":{"id":"item_3","type":"file_change","changes":[{"path":"/tmp/codor-diag-codexraw-n7jC18/notes.txt","kind":"update"}],"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_3","type":"file_change","changes":[{"path":"/tmp/codor-diag-codexraw-n7jC18/notes.txt","kind":"update"}],"status":"completed"}}',
  ].map((line) => JSON.parse(line) as CodexEvent);

  it('arrive as started/completed pairs carrying changes:[{path,kind}]', () => {
    expect(capture.map((e) => e.type)).toEqual([
      'item.started',
      'item.completed',
      'item.started',
      'item.completed',
    ]);
    for (const event of capture) {
      expect(event.item?.type).toBe('file_change');
      expect(event.item?.changes).toHaveLength(1);
      expect(event.item?.changes?.[0]?.path).toMatch(/notes\.txt$/);
    }
  });

  it('kinds observed live are add and update; no diff body is reported', () => {
    expect(capture.map((e) => e.item?.changes?.[0]?.kind)).toEqual([
      'add',
      'add',
      'update',
      'update',
    ]);
    expect(JSON.stringify(capture)).not.toContain('diff');
    expect(JSON.stringify(capture)).not.toContain('unified');
  });
});

describe('resume after SIGKILL', () => {
  it('the killed thread resumes under the same thread_id and completes', () => {
    const killed = events('kill-mid-turn.jsonl');
    const resumed = events('kill-mid-turn-resume.jsonl');
    expect(resumed[0]!.thread_id).toBe(killed[0]!.thread_id);
    expect(resumed.at(-1)!.type).toBe('turn.completed');
    const messages = resumed.filter((e) => e.item?.type === 'agent_message');
    expect(messages.at(-1)?.item?.text).toContain('sleep 60');
  });
});
