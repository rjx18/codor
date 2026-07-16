import { readFileSync } from 'node:fs';

import { parseRunItemPayload, type WireEvent, WireEventSchema } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import { composeControlResponse } from './adapter.js';
import {
  cardFromControlRequest,
  type ControlRequest,
  createTurnTranslator,
  diffFromToolUse,
  wireEventFromHook,
} from './translate.js';

function fixture(name: string): string[] {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

function replay(lines: string[]) {
  const translator = createTurnTranslator();
  const events: WireEvent[] = [];
  for (const line of lines) events.push(...translator.push(line));
  const tail = translator.end();
  const all = [...events, ...tail];
  for (const event of all) {
    if (event.type === 'run.item') {
      expect(parseRunItemPayload(event.item_type, event.payload).success).toBe(true);
    }
  }
  return { translator, events, all };
}

const completed = (events: WireEvent[]) =>
  events.find((e) => e.type === 'run.completed') as Extract<WireEvent, { type: 'run.completed' }>;

const firstCard = (events: WireEvent[]) => {
  const raised = events.find((e) => e.type === 'ask.raised' || e.type === 'approval.raised') as
    | Extract<WireEvent, { type: 'ask.raised' }>
    | Extract<WireEvent, { type: 'approval.raised' }>;
  return raised;
};

const requestFromFixture = (name: string): ControlRequest => {
  const line = fixture(name).find((l) => JSON.parse(l).type === 'control_request')!;
  const parsed = JSON.parse(line);
  return { request_id: parsed.request_id, request: parsed.request };
};

const responseFromStdinFixture = (name: string): Record<string, unknown> => {
  const line = fixture(name).find((l) => JSON.parse(l).type === 'control_response')!;
  return JSON.parse(line);
};

describe('pong fixture replay', () => {
  const { translator, all } = replay(fixture('pong.jsonl'));

  it('captures the session id as session_ref source', () => {
    expect(translator.sessionId()).toBe('ec6d311d-1205-4d48-961e-56bb0e995398');
  });

  it('normalizes assistant text and the result with cost_usd', () => {
    expect(all.filter((e) => e.type === 'run.item' && e.item_type === 'text_delta')).toEqual([
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'PONG' } },
    ]);
    const done = completed(all);
    expect(done.status).toBe('completed');
    expect(done.final_text).toBe('PONG');
    expect(done.usage!.cost_usd).toBeTypeOf('number');
    expect(done.usage!.input_tokens).toBeGreaterThan(0);
  });
});

describe('resume fixture replay', () => {
  it('--resume keeps the same session id', () => {
    expect(replay(fixture('resume.jsonl')).translator.sessionId()).toBe(
      replay(fixture('pong.jsonl')).translator.sessionId(),
    );
  });
});

describe('ask → answer → resume-of-turn (fixture replay)', () => {
  const lines = fixture('ask-user-question.jsonl');
  const { translator, all } = replay(lines);

  it('the control_request normalizes to exactly one blocking ask card', () => {
    const raisedEvents = all.filter((e) => e.type === 'ask.raised');
    expect(raisedEvents).toHaveLength(1);
    const card = firstCard(all).card;
    expect(card).toEqual({
      interaction_id: '315adf4a-1770-46d0-8b66-e341049410ea',
      kind: 'ask',
      prompt: 'Which codeword?',
      options: [
        { label: 'ALPHA', description: 'Select the codeword ALPHA.' },
        { label: 'BETA', description: 'Select the codeword BETA.' },
      ],
      multi: false,
    });
  });

  it('the composed answer equals the recorded stdin control_response byte-for-byte', () => {
    const request = translator.pendingRequest('315adf4a-1770-46d0-8b66-e341049410ea')!;
    const composed = composeControlResponse(request, { 'Which codeword?': 'ALPHA' });
    expect(composed).toEqual(responseFromStdinFixture('ask-user-question.stdin.jsonl'));
  });

  it('a plain-string answer maps onto the single question automatically', () => {
    const request = translator.pendingRequest('315adf4a-1770-46d0-8b66-e341049410ea')!;
    expect(composeControlResponse(request, 'ALPHA')).toEqual(
      responseFromStdinFixture('ask-user-question.stdin.jsonl'),
    );
  });

  it('after the answer the SAME turn proceeds to its result', () => {
    expect(completed(all)).toMatchObject({ status: 'completed', final_text: 'ALPHA' });
  });
});

describe('approval card through one blocked turn (fixture replay)', () => {
  const request = requestFromFixture('permission-deny.jsonl');

  it('a non-ask can_use_tool normalizes to an approval card with tool/detail', () => {
    const card = cardFromControlRequest(request);
    expect(card).toEqual({
      interaction_id: request.request_id,
      kind: 'approval',
      prompt: 'Allow Bash?',
      options: [{ label: 'allow once' }, { label: 'allow always' }, { label: 'deny' }],
      tool: 'Bash',
      detail: 'touch probe-permission.txt',
    });
  });

  it('deny composes the recorded stdin response (modulo the audit message)', () => {
    const composed = composeControlResponse(request, 'deny') as {
      response: { response: { message: string } };
    };
    const recorded = responseFromStdinFixture('permission-deny.stdin.jsonl') as {
      response: { response: { message: string } };
    };
    composed.response.response.message = recorded.response.response.message;
    expect(composed).toEqual(recorded);
  });

  it('allow once passes the original input through', () => {
    expect(composeControlResponse(request, 'allow once')).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.request_id,
        response: { behavior: 'allow', updatedInput: request.request.input },
      },
    });
  });

  it('allow always additionally carries the addRules permission update', () => {
    const composed = composeControlResponse(request, 'allow always') as {
      response: { response: { behavior: string; updatedPermissions: { type: string }[] } };
    };
    expect(composed.response.response.behavior).toBe('allow');
    expect(composed.response.response.updatedPermissions).toEqual([
      expect.objectContaining({ type: 'addRules' }),
    ]);
  });

  it('the denied turn still completes (deny does not kill the run)', () => {
    const { all } = replay(fixture('permission-deny.jsonl'));
    expect(completed(all)).toMatchObject({ status: 'completed', final_text: 'DENIED' });
  });
});

describe('crash boundaries (fixture replay)', () => {
  it('killed-during-ask: card raised, no result, EOF synthesizes interrupted', () => {
    const { events, all } = replay(fixture('kill-during-ask.jsonl'));
    expect(events.at(-1)!.type).toBe('ask.raised');
    expect(completed(all).status).toBe('interrupted');
  });

  it('the re-raised ask correlates semantically, never by native id', () => {
    const before = requestFromFixture('kill-during-ask.jsonl');
    const after = requestFromFixture('kill-during-ask-resume.jsonl');
    expect(after.request_id).not.toBe(before.request_id);
    // The model REGENERATES the tool call on resume: prompt and option labels
    // are stable, but option descriptions drift (fixtures: "Select…" vs
    // "Choose…") — so re-correlation must compare prompt + labels ONLY.
    expect(cardFromControlRequest(after).prompt).toBe(cardFromControlRequest(before).prompt);
    expect(cardFromControlRequest(after).options!.map((o) => o.label)).toEqual(
      cardFromControlRequest(before).options!.map((o) => o.label),
    );
    expect(cardFromControlRequest(after).options![0]!.description).not.toBe(
      cardFromControlRequest(before).options![0]!.description,
    );
  });

  it('replaying the stored answer against the re-raise completes the turn', () => {
    const { all } = replay(fixture('answered-then-kill-resume.jsonl'));
    expect(completed(all)).toMatchObject({ status: 'completed', final_text: 'EPSILON' });
  });
});

describe('extensions via hooks (authoritative source)', () => {
  const [start, stop] = fixture('hooks-log.jsonl').map((l) => JSON.parse(l));

  it('SubagentStart maps to extension.started with native ids', () => {
    const event = wireEventFromHook(start);
    expect(event).toEqual({
      type: 'extension.started',
      parent: start.session_id,
      ext_member: start.agent_id,
      agent_type: 'general-purpose',
      transcript_path: start.transcript_path,
    });
    expect(WireEventSchema.safeParse(event).success).toBe(true);
  });

  it('SubagentStop maps to extension.ended with the summary', () => {
    const event = wireEventFromHook(stop);
    expect(event).toEqual({
      type: 'extension.ended',
      ext_member: stop.agent_id,
      summary: 'PONG',
      transcript_path: stop.agent_transcript_path,
    });
    expect(WireEventSchema.safeParse(event).success).toBe(true);
  });

  it('unknown hook payloads are dropped, not crashed on', () => {
    expect(wireEventFromHook({ hook_event_name: 'SessionStart' })).toBeUndefined();
    expect(wireEventFromHook({})).toBeUndefined();
  });

  it('the parent stream Task spawn is enrichment only (a tool_call run item)', () => {
    const { all } = replay(fixture('hooks-subagent.jsonl'));
    const toolCalls = all.filter(
      (e) => e.type === 'run.item' && e.item_type === 'tool_call',
    ) as Extract<WireEvent, { type: 'run.item' }>[];
    expect(toolCalls.some((e) => (e.payload as { tool?: string }).tool === 'Agent')).toBe(true);
    expect(all.some((e) => e.type === 'extension.started')).toBe(false); // never from the stream
  });
});

describe('robustness', () => {
  it('malformed and unknown lines are tolerated', () => {
    const { all } = replay([
      'garbage {{{',
      '{"type":"rate_limit_event","rate_limit_info":{}}',
      '{"type":"system","subtype":"init","session_id":"ec6d311d-1205-4d48-961e-56bb0e995398"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"OK","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.01}',
    ]);
    expect(completed(all)).toEqual({
      type: 'run.completed',
      status: 'completed',
      final_text: 'OK',
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.01 },
    });
  });

  it('a failed result maps to status failed', () => {
    const { all } = replay([
      '{"type":"result","subtype":"error","is_error":true,"result":"boom","usage":{"input_tokens":1,"output_tokens":0}}',
    ]);
    expect(completed(all).status).toBe('failed');
  });
});

describe('S1 content normalization (synthetic inline records)', () => {
  it('maps thinking blocks instead of dropping them', () => {
    const { events } = replay([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'Check the constraints.' }] },
      }),
    ]);
    expect(events).toEqual([{
      type: 'run.item',
      item_type: 'reasoning_summary',
      payload: { text: 'Check the constraints.' },
    }]);
  });

  it('pairs Edit results and synthesizes a unified file-change diff', () => {
    const expected = [
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,1 +1,1 @@',
      '-old()',
      '+new()',
      '',
    ].join('\n');
    expect(diffFromToolUse('Edit', {
      file_path: 'src/app.ts', old_string: 'old()', new_string: 'new()',
    })).toEqual({ path: 'src/app.ts', change: 'modified', unified: expected });
    const { events } = replay([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{
          type: 'tool_use', id: 'edit-1', name: 'Edit',
          input: { file_path: 'src/app.ts', old_string: 'old()', new_string: 'new()' },
        }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'Updated.' }] },
      }),
    ]);
    // ONE row per file operation: the diff-carrying tool_result is canonical, and no
    // trailing file_change duplicates it (the double row Richard reported live).
    expect(events.at(-1)).toMatchObject({
      type: 'run.item', item_type: 'tool_result',
      payload: { call_id: 'edit-1', status: 'ok', diff: { path: 'src/app.ts', unified: expected } },
    });
    expect(events.filter((e) => e.type === 'run.item' && e.item_type === 'file_change')).toEqual([]);
    // The call itself carries the real subject, not the bare tool name.
    expect(events.find((e) => e.type === 'run.item' && e.item_type === 'tool_call')).toMatchObject({
      payload: { title: 'src/app.ts' },
    });
  });

  it('titles every tool call with its subject, never the bare tool name', () => {
    const call = (name: string, input: Record<string, unknown>) => {
      const { events } = replay([JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: `t-${name}`, name, input }] },
      })]);
      const event = events.find((e) => e.type === 'run.item' && e.item_type === 'tool_call');
      return (event as { payload: { title: string } }).payload.title;
    };
    expect(call('Bash', { command: 'pnpm test --filter web' })).toBe('pnpm test --filter web');
    expect(call('Read', { file_path: '/repo/src/state.ts' })).toBe('/repo/src/state.ts');
    expect(call('Write', { file_path: 'notes.txt', content: 'hello' })).toBe('notes.txt');
    expect(call('Grep', { pattern: 'toolTitle', path: 'src' })).toBe('toolTitle in src');
    expect(call('Glob', { pattern: '**/*.spec.ts' })).toBe('**/*.spec.ts');
    expect(call('WebFetch', { url: 'https://example.com/x' })).toBe('https://example.com/x');
    expect(call('Task', { description: 'audit the cascade' })).toBe('audit the cascade');
    // Unknown tools with no recognisable subject fall back to the name.
    expect(call('MysteryTool', { whatever: 1 })).toBe('MysteryTool');
    // Long subjects are bounded.
    expect(call('Bash', { command: 'x'.repeat(500) }).length).toBeLessThanOrEqual(200);
  });

  it('extracts bounded base64 images from tool results', () => {
    const data = Buffer.from('image bytes').toString('base64');
    const { events } = replay([JSON.stringify({
      type: 'user',
      message: { content: [{
        type: 'tool_result', tool_use_id: 'read-1', content: [{
          type: 'image', source: { type: 'base64', media_type: 'image/png', data },
        }],
      }] },
    })]);
    expect(events[0]).toMatchObject({
      type: 'run.item', item_type: 'tool_result',
      payload: { call_id: 'read-1', status: 'ok', image: { media_type: 'image/png', data_b64: data } },
    });
  });

  it('truncates oversized output but preserves the original raw block', () => {
    const original = 'x'.repeat(256 * 1024 + 100);
    const { events } = replay([JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: original }] },
    })]);
    const payload = events[0]!.payload as { output_text: string; raw: { content: string } };
    expect(payload.output_text).toContain('[output truncated at 256 KiB]');
    expect(Buffer.byteLength(payload.output_text)).toBeLessThanOrEqual(256 * 1024);
    expect(payload.raw.content).toBe(original);
  });

  it('replaces images over 2 MiB with a marker', () => {
    const data = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64');
    const { events } = replay([JSON.stringify({
      type: 'user',
      message: { content: [{
        type: 'tool_result', tool_use_id: 'read-2', content: [{
          type: 'image', source: { type: 'base64', media_type: 'image/png', data },
        }],
      }] },
    })]);
    expect(events[0]!.payload).toMatchObject({
      call_id: 'read-2',
      output_text: '[image image/png, 2097153 bytes, too large to inline]',
    });
    expect(events[0]!.payload).not.toHaveProperty('image');
  });
});

describe('rate limit events (agent-usage-limits-reported-not-guessed)', () => {
  // Verbatim from the pinned raw fixtures — the CLI streams its limit windows.
  const FIXTURE_LINE =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1783684800,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false},"uuid":"db45626b-bc76-4332-9eb9-6f77682f9642","session_id":"ec6d311d-1205-4d48-961e-56bb0e995398"}';

  it('maps rate_limit_event onto one run.limits event', () => {
    const translator = createTurnTranslator();
    expect(translator.push(FIXTURE_LINE)).toEqual([
      {
        type: 'run.limits',
        limits: [
          {
            window: 'five_hour',
            status: 'allowed',
            resets_at: new Date(1783684800 * 1000).toISOString(),
          },
        ],
      },
    ]);
  });

  it('forwards utilization as used_percent when the CLI reports it', () => {
    const translator = createTurnTranslator();
    const events = translator.push(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', rateLimitType: 'weekly', utilization: 87.5 },
    }));
    expect(events).toEqual([
      {
        type: 'run.limits',
        limits: [{ window: 'weekly', status: 'allowed_warning', used_percent: 87.5 }],
      },
    ]);
  });

  it('reports nothing for shapes it does not recognize — never a guess', () => {
    const translator = createTurnTranslator();
    expect(translator.push('{"type":"rate_limit_event"}')).toEqual([]);
    expect(translator.push('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}')).toEqual([]);
  });
});
