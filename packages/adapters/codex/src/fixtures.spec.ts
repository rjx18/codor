import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// harn:assume codex-event-contract-pinned ref=codex-fixture-invariants
// These specs assert the invariants of the RAW captured `codex exec --json`
// fixtures (see ../NOTES.md). If they fail after a fixture change, the change
// must have come from re-probing the CLI — never from hand-editing.

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
// harn:end codex-event-contract-pinned
