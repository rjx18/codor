import type { WireEvent } from '@wireroom/protocol';

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

      switch (event.type) {
        case 'assistant.message_delta': {
          if (stringField(data, 'parentToolCallId') !== undefined) return [];
          const messageId = stringField(data, 'messageId');
          const delta = stringField(data, 'deltaContent') ?? '';
          if (messageId === undefined) return [];
          const text = `${streamedMessages.get(messageId) ?? ''}${delta}`;
          streamedMessages.set(messageId, text);
          finalText = text;
          return [{ type: 'run.item', item_type: 'text_delta', payload: delta }];
        }
        case 'assistant.message': {
          if (stringField(data, 'parentToolCallId') !== undefined) return [];
          const messageId = stringField(data, 'messageId');
          const content = stringField(data, 'content') ?? '';
          finalText = content;
          if (messageId !== undefined && streamedMessages.has(messageId)) return [];
          return content === ''
            ? []
            : [{ type: 'run.item', item_type: 'text_delta', payload: content }];
        }
        case 'assistant.reasoning':
          if (stringField(data, 'parentToolCallId') !== undefined) return [];
          return [
            {
              type: 'run.item',
              item_type: 'reasoning_summary',
              payload: stringField(data, 'content') ?? '',
            },
          ];
        case 'tool.execution_start':
          return [
            {
              type: 'run.item',
              item_type: 'tool_call',
              payload: {
                tool_call_id: stringField(data, 'toolCallId'),
                tool_name: stringField(data, 'toolName'),
                arguments: data.arguments ?? {},
              },
            },
          ];
        case 'tool.execution_complete':
          return [
            {
              type: 'run.item',
              item_type: 'tool_result',
              payload: {
                tool_call_id: stringField(data, 'toolCallId'),
                success: data.success,
                result: data.result,
                error: data.error,
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
                kind: 'error',
                error_type: stringField(data, 'errorType'),
                message: streamError,
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
