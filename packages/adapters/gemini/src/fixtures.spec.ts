import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

type GeminiEvent = {
  type: string;
  session_id?: string;
  role?: string;
  content?: string;
  status?: string;
  stats?: Record<string, unknown>;
};

function events(name: string): GeminiEvent[] {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GeminiEvent);
}

describe('SYNTHETIC documented-format Gemini fixtures', () => {
  it('are prominently marked as synthetic', () => {
    const notice = readFileSync(new URL('../fixtures/SYNTHETIC.md', import.meta.url), 'utf8');
    expect(notice).toContain('SYNTHETIC fixtures');
    expect(notice).toContain('not live');
  });

  it('pins init UUID, assistant deltas, and token-only success statistics', () => {
    const fixture = events('synthetic-success.jsonl');
    expect(fixture[0]).toMatchObject({
      type: 'init',
      session_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(fixture.filter((event) => event.role === 'assistant').map((event) => event.content))
      .toEqual(['PO', 'NG']);
    expect(fixture.at(-1)).toMatchObject({
      type: 'result',
      status: 'success',
      stats: { input_tokens: 12, output_tokens: 2 },
    });
    expect(JSON.stringify(fixture)).not.toContain('cost_usd');
  });

  it('pins error followed by a failed terminal result', () => {
    expect(events('synthetic-failure.jsonl').map((event) => event.type))
      .toEqual(['init', 'error', 'result']);
  });
});
