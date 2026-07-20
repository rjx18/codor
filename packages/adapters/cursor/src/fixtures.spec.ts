import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

type CursorEvent = {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  timestamp_ms?: number;
  message?: { role?: string; content?: Array<{ text?: string }> };
  usage?: Record<string, unknown>;
};

function events(name: string): CursorEvent[] {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CursorEvent);
}

describe('SYNTHETIC documented-format cursor fixtures', () => {
  it('are prominently marked as synthetic', () => {
    const notice = readFileSync(new URL('../fixtures/SYNTHETIC.md', import.meta.url), 'utf8');
    expect(notice).toContain('SYNTHETIC fixtures');
    expect(notice).toContain('not live');
  });

  it('pins init UUID, streaming assistant deltas, and token-only success usage', () => {
    const fixture = events('synthetic-success.jsonl');
    expect(fixture[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: '11111111-1111-4111-8111-111111111111',
    });
    // Only the delta events carry timestamp_ms; the cumulative echo does not.
    expect(
      fixture
        .filter((event) => event.type === 'assistant' && event.timestamp_ms !== undefined)
        .map((event) => event.message?.content?.[0]?.text),
    ).toEqual(['PO', 'NG']);
    expect(fixture.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'success',
      usage: { inputTokens: 12, outputTokens: 2 },
    });
  });

  it('pins an errored terminal result', () => {
    const fixture = events('synthetic-failure.jsonl');
    expect(fixture.map((event) => event.type)).toEqual(['system', 'result']);
    expect(fixture.at(-1)).toMatchObject({ type: 'result', is_error: true });
  });
});
