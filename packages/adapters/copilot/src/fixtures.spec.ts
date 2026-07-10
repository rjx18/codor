import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

type CopilotEvent = {
  id: string;
  timestamp: string;
  parentId: string | null;
  ephemeral?: boolean;
  type: string;
  data: Record<string, unknown>;
};

function events(name: string): CopilotEvent[] {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CopilotEvent);
}

describe('SYNTHETIC documented-format Copilot fixtures', () => {
  it('are prominently marked as synthetic', () => {
    const notice = readFileSync(new URL('../fixtures/SYNTHETIC.md', import.meta.url), 'utf8');
    expect(notice).toContain('SYNTHETIC fixtures');
    expect(notice).toContain('not live');
  });

  it('uses the documented event envelope and linked parent chain', () => {
    const fixture = events('synthetic-success.jsonl');
    for (const [index, event] of fixture.entries()) {
      expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(event.timestamp)).not.toBeNaN();
      expect(event.parentId).toBe(index === 0 ? null : fixture[index - 1]!.id);
      expect(event.data).toBeTypeOf('object');
    }
  });

  it('pins assistant, tool, usage, subagent, idle, and error vocabulary', () => {
    expect(events('synthetic-success.jsonl').map((event) => event.type)).toEqual([
      'assistant.turn_start',
      'subagent.started',
      'subagent.completed',
      'tool.execution_start',
      'tool.execution_complete',
      'assistant.message_delta',
      'assistant.message_delta',
      'assistant.message',
      'assistant.usage',
      'assistant.turn_end',
      'session.idle',
    ]);
    expect(events('synthetic-failure.jsonl')[0]).toMatchObject({
      type: 'session.error',
      data: { errorType: 'authentication', message: 'Authentication required' },
    });
  });

  it('marks billing cost as present but never labels it USD', () => {
    const fixture = events('synthetic-success.jsonl');
    expect(fixture.find((event) => event.type === 'assistant.usage')?.data.cost).toBe(0.33);
    expect(JSON.stringify(fixture)).not.toContain('cost_usd');
  });
});
