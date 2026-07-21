import { readFileSync } from 'node:fs';

import { parseRunItemPayload, type WireEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import { createTurnTranslator } from './translate.js';

describe('Tura NDJSON translation', () => {
  it('maps a native run, its tool lifecycle, and exactly one terminal event', () => {
    const translator = createTurnTranslator();
    const events = readFileSync(new URL('../fixtures/native-run.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .flatMap((line) => translator.push(line));
    events.push(...translator.end({ status: 'completed' }));

    expect(translator.sessionId()).toBe('ses_tura');
    expect(events).toEqual([
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'PONG' } },
      {
        type: 'run.item', item_type: 'tool_call',
        payload: {
          call_id: 'cmd_1', tool: 'command_run', title: 'Command run',
          input: { command_line: 'pwd' },
        },
      },
      {
        type: 'run.item', item_type: 'tool_result',
        payload: {
          call_id: 'cmd_1', status: 'ok', output_text: '/work',
          raw: { payload: { properties: { commandID: 'cmd_1', status: 'completed', command: 'command_run', output: '/work' } } },
        },
      },
      { type: 'run.completed', status: 'completed', final_text: 'PONG' },
    ]);
    for (const event of events) {
      if (event.type === 'run.item') {
        expect(parseRunItemPayload(event.item_type, event.payload).success).toBe(true);
      }
    }
  });

  it('fails cleanly for a native failure and ignores malformed or future records', () => {
    const translator = createTurnTranslator();
    expect(translator.push('not-json')).toEqual([]);
    expect(translator.push('{"type":"future"}')).toEqual([]);
    expect(translator.push('{"type":"cli.failed","sessionID":"ses_bad","error":"auth required"}'))
      .toEqual([{ type: 'run.completed', status: 'failed', final_text: 'auth required', error: 'auth required' }]);
    expect(translator.end({ status: 'failed' })).toEqual([]);
  });

  it('does not mistake a completed CLI process for a completed native turn', () => {
    const translator = createTurnTranslator();
    expect(translator.push('{"type":"cli.completed","sessionID":"ses_bad","status":"failed","finalText":"gateway error"}'))
      .toEqual([{ type: 'run.completed', status: 'failed', final_text: 'gateway error', error: 'gateway error' }]);
  });

  it('maps the current source runtime command payload without duplicate results', () => {
    const translator = createTurnTranslator();
    const ready = translator.push(JSON.stringify({
      type: 'command.updated', sessionID: 'ses_current', status: 'ready', raw: { payload: { properties: {
        commandID: 'cmd_current', status: 'ready', command: { command_type: 'zsh', command_line: '{"command":"pwd"}' },
      } } },
    }));
    const completed = translator.push(JSON.stringify({
      type: 'command.updated', sessionID: 'ses_current', status: 'completed', raw: { payload: { properties: {
        commandID: 'cmd_current', status: 'completed', command: { command_type: 'zsh', command_line: '{"command":"pwd"}' },
        result: { success: true, output: { stdout: '/work\\n', stderr: '' } },
      } } },
    }));
    const duplicate = translator.push(JSON.stringify({
      type: 'command.updated', sessionID: 'ses_current', status: 'completed', raw: { payload: { properties: {
        commandID: 'cmd_current', status: 'completed', command: { command_type: 'zsh', command_line: '{"command":"pwd"}' }, result: null,
      } } },
    }));

    expect(ready).toEqual([{ type: 'run.item', item_type: 'tool_call', payload: {
      call_id: 'cmd_current', tool: 'zsh', title: 'zsh', input: { command: 'pwd' },
    } }]);
    expect(completed).toEqual([{ type: 'run.item', item_type: 'tool_result', payload: {
      call_id: 'cmd_current', status: 'ok', output_text: '/work\\n',
      raw: expect.any(Object),
    } }]);
    expect(duplicate).toEqual([]);
  });
});
