import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

type OpenCodeEvent = {
  type: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    tokens?: { input?: number; output?: number };
    cost?: number;
  };
};

function events(): OpenCodeEvent[] {
  return readFileSync(new URL('../fixtures/live-pong-1.17.14.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as OpenCodeEvent);
}

describe('OpenCode 1.17.14 single-shot live PONG fixture', () => {
  it('pins the complete raw event sequence and stable native session id', () => {
    const fixture = events();
    expect(fixture.map((event) => event.type)).toEqual(['step_start', 'text', 'step_finish']);
    expect(new Set(fixture.map((event) => event.sessionID))).toEqual(
      new Set(['ses_0b418b8aeffelyQqZS0JoBHFvF']),
    );
    expect(fixture[1]?.part).toMatchObject({ type: 'text', text: 'PONG' });
  });

  it('reports exact tokens and zero-dollar cost without an invented price', () => {
    expect(events().at(-1)?.part).toMatchObject({
      type: 'step-finish',
      tokens: { input: 10119, output: 3 },
      cost: 0,
    });
  });
});
