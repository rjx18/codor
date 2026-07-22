import { parseRunItemPayload, type WireEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import { createTurnTranslator as createClaudeTranslator } from '../../claude-code/src/translate.js';
import { createTurnTranslator as createCopilotTranslator } from '../../copilot/src/translate.js';
import { createTurnTranslator as createCursorTranslator } from '../../cursor/src/translate.js';
import { createTurnTranslator as createGeminiTranslator } from '../../gemini/src/translate.js';
import { createTurnTranslator as createOpenCodeTranslator } from '../../opencode/src/translate.js';
import { createTurnTranslator as createCodexTranslator } from './translate.js';

function expectPaired(events: WireEvent[], callId: string, tool: string, status: 'ok' | 'error'): void {
  const items = events.filter((event) => event.type === 'run.item');
  for (const event of items) {
    expect(parseRunItemPayload(event.item_type, event.payload).success).toBe(true);
  }
  expect(items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      item_type: 'tool_call',
      payload: expect.objectContaining({ call_id: callId, tool }),
    }),
    expect.objectContaining({
      item_type: 'tool_result',
      payload: expect.objectContaining({ call_id: callId, status }),
    }),
  ]));
}

// Antigravity is intentionally absent: its captured upstream contract is plain
// stdout/log text, so inventing structured tool calls would violate fidelity.
describe('first-party structured tool event contract', () => {
  it('pairs Claude native read evidence', () => {
    const translator = createClaudeTranslator();
    const events = [
      ...translator.push({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'claude-read', name: 'Read', input: { file_path: '/work/a' } }] },
      }),
      ...translator.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'claude-read', content: 'a' }] },
      }),
    ];
    expectPaired(events, 'claude-read', 'Read', 'ok');
  });

  it('pairs Codex native search evidence', () => {
    const translator = createCodexTranslator();
    const action = { type: 'search', command: 'rg needle', query: 'needle', path: '/work' };
    const events = [
      ...translator.push('item/started', {
        item: { type: 'commandExecution', id: 'codex-search', command: 'rg needle', commandActions: [action] },
      }),
      ...translator.push('item/completed', {
        item: {
          type: 'commandExecution',
          id: 'codex-search',
          command: 'rg needle',
          commandActions: [action],
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: '/work/a:needle\n',
        },
      }),
    ];
    expectPaired(events, 'codex-search', 'Grep', 'ok');
  });

  it('pairs Gemini native search evidence', () => {
    const translator = createGeminiTranslator();
    const events = [
      ...translator.push(JSON.stringify({
        type: 'tool_use', tool_id: 'gemini-search', tool_name: 'search_file_content', parameters: { pattern: 'needle' },
      })),
      ...translator.push(JSON.stringify({
        type: 'tool_result', tool_id: 'gemini-search', status: 'success', output: 'a:needle',
      })),
    ];
    expectPaired(events, 'gemini-search', 'search_file_content', 'ok');
  });

  it('pairs OpenCode native read evidence and failure status', () => {
    const translator = createOpenCodeTranslator();
    const events = translator.push(JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'read',
        callID: 'opencode-read',
        state: { status: 'error', input: { filePath: '/work/a' }, error: 'denied' },
      },
    }));
    expectPaired(events, 'opencode-read', 'read', 'error');
  });

  it('pairs Copilot native search evidence', () => {
    const translator = createCopilotTranslator('copilot-session');
    const events = [
      ...translator.push(JSON.stringify({
        type: 'tool.execution_start',
        data: { toolCallId: 'copilot-search', toolName: 'grep', arguments: { query: 'needle' } },
      })),
      ...translator.push(JSON.stringify({
        type: 'tool.execution_complete',
        data: { toolCallId: 'copilot-search', success: true, result: 'a:needle' },
      })),
    ];
    expectPaired(events, 'copilot-search', 'grep', 'ok');
  });

  it('pairs Cursor native read evidence', () => {
    const translator = createCursorTranslator();
    const events = [
      ...translator.push(JSON.stringify({
        type: 'tool_call', subtype: 'started', call_id: 'cursor-read',
        tool_call: { readToolCall: { args: { path: '/work/a' } } },
      })),
      ...translator.push(JSON.stringify({
        type: 'tool_call', subtype: 'completed', call_id: 'cursor-read',
        tool_call: { readToolCall: { result: { success: { content: 'a' } } } },
      })),
    ];
    expectPaired(events, 'cursor-read', 'read', 'ok');
  });
});
