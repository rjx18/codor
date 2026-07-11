import type { WireEvent } from '@codor/protocol';

interface CopilotEvent {
  type?: string;
  data?: Record<string, unknown>;
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const MAX_OUTPUT = 256 * 1024;

function outputText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : value === undefined ? undefined : JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) <= MAX_OUTPUT) return text;
  const marker = '\n[output truncated at 256 KiB]';
  const markerBytes = Buffer.byteLength(marker);
  let prefix = Buffer.from(text).subarray(0, MAX_OUTPUT - markerBytes).toString('utf8');
  while (Buffer.byteLength(prefix) + markerBytes > MAX_OUTPUT) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}`;
}

export interface TurnTranslator {
  push(line: string): WireEvent[];
  end(outcome: {
    status: 'completed' | 'failed' | 'interrupted';
    final_text?: string;
  }): WireEvent[];
}

// harn:assume copilot-capability-truth ref=copilot-event-translation
/** Translate first-party documented Copilot session event envelopes. */
export function createTurnTranslator(sessionId: string): TurnTranslator {
  const streamedMessages = new Map<string, string>();
  let finalText = '';
  let streamError: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let hasUsage = false;
  let terminal = false;

  return {
    push(line: string): WireEvent[] {
      if (line.trim() === '') return [];
      let event: CopilotEvent;
      try {
        event = JSON.parse(line) as CopilotEvent;
      } catch {
        return [];
      }
      const data = event.data ?? {};

      // harn:assume first-party-run-items-normalized ref=copilot-normalized-run-items
      switch (event.type) {
        case 'assistant.message_delta': {
          if (stringField(data, 'parentToolCallId') !== undefined) return [];
          const messageId = stringField(data, 'messageId');
          const delta = stringField(data, 'deltaContent') ?? '';
          if (messageId === undefined) return [];
          const text = `${streamedMessages.get(messageId) ?? ''}${delta}`;
          streamedMessages.set(messageId, text);
          finalText = text;
          return [{ type: 'run.item', item_type: 'text_delta', payload: { text: delta } }];
        }
        case 'assistant.message': {
          if (stringField(data, 'parentToolCallId') !== undefined) return [];
          const messageId = stringField(data, 'messageId');
          const content = stringField(data, 'content') ?? '';
          finalText = content;
          if (messageId !== undefined && streamedMessages.has(messageId)) return [];
          return content === ''
            ? []
            : [{ type: 'run.item', item_type: 'text_delta', payload: { text: content } }];
        }
        case 'assistant.reasoning':
          if (stringField(data, 'parentToolCallId') !== undefined) return [];
          return [
            {
              type: 'run.item',
              item_type: 'reasoning_summary',
              payload: { text: stringField(data, 'content') ?? '' },
            },
          ];
        case 'tool.execution_start':
          return [
            {
              type: 'run.item',
              item_type: 'tool_call',
              payload: {
                call_id: stringField(data, 'toolCallId') ?? 'copilot-tool',
                tool: stringField(data, 'toolName') ?? 'tool',
                title: stringField(data, 'toolName') ?? 'Tool call',
                input: data.arguments ?? {},
              },
            },
          ];
        case 'tool.execution_complete':
          return [
            {
              type: 'run.item',
              item_type: 'tool_result',
              payload: {
                call_id: stringField(data, 'toolCallId') ?? 'copilot-tool',
                status: data.success === false ? 'error' : 'ok',
                output_text: outputText(data.success === false ? data.error : data.result),
                raw: data,
              },
            },
          ];
        case 'assistant.usage':
          hasUsage = true;
          inputTokens += numberField(data, 'inputTokens') ?? 0;
          outputTokens += numberField(data, 'outputTokens') ?? 0;
          return [];
        case 'session.error':
          streamError = stringField(data, 'message') ?? stringField(data, 'errorType');
          return [
            {
              type: 'run.item',
              item_type: 'tool_result',
              payload: {
                call_id: 'copilot-error',
                status: 'error',
                output_text: outputText(streamError),
                raw: data,
              },
            },
          ];
        case 'subagent.started': {
          const toolCallId = stringField(data, 'toolCallId');
          if (toolCallId === undefined) return [];
          return [
            {
              type: 'extension.started',
              parent: sessionId,
              ext_member: toolCallId,
              ...(stringField(data, 'agentDisplayName') !== undefined && {
                description: stringField(data, 'agentDisplayName'),
              }),
              ...(stringField(data, 'agentName') !== undefined && {
                agent_type: stringField(data, 'agentName'),
              }),
            },
          ];
        }
        case 'subagent.completed':
        case 'subagent.failed': {
          const toolCallId = stringField(data, 'toolCallId');
          if (toolCallId === undefined) return [];
          return [
            {
              type: 'extension.ended',
              ext_member: toolCallId,
              ...(event.type === 'subagent.failed' && stringField(data, 'error') !== undefined && {
                summary: stringField(data, 'error'),
              }),
            },
          ];
        }
        default:
          return [];
      }
      // harn:end first-party-run-items-normalized
    },

    end(outcome): WireEvent[] {
      if (terminal) return [];
      terminal = true;
      const resolvedText = outcome.final_text ?? (finalText || streamError);
      const status = outcome.status === 'completed' && streamError !== undefined
        ? 'failed'
        : outcome.status;
      return [
        {
          type: 'run.completed',
          status,
          ...(resolvedText !== undefined && resolvedText !== '' && { final_text: resolvedText }),
          ...(hasUsage && {
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          }),
        },
      ];
    },
  };
}
// harn:end copilot-capability-truth
