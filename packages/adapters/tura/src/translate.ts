import type { WireEvent } from '@codor/protocol';

interface TuraEvent {
  type?: string;
  sessionID?: string;
  text?: string;
  finalText?: string;
  status?: string;
  error?: unknown;
  raw?: {
    payload?: {
      properties?: {
        commandID?: unknown;
        status?: unknown;
        command?: unknown;
        input?: unknown;
        output?: unknown;
      };
    };
  };
}

const TERMINAL_COMMAND_STATUSES = new Set(['completed', 'succeeded', 'failed', 'error', 'cancelled']);

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { message?: unknown; error?: unknown };
  if (typeof candidate.message === 'string') return candidate.message;
  return typeof candidate.error === 'string' ? candidate.error : undefined;
}

export interface TurnTranslator {
  push(line: string): WireEvent[];
  end(outcome: { status: 'completed' | 'failed' | 'interrupted'; error?: string }): WireEvent[];
  sessionId(): string | undefined;
}

/** Translate Tura's documented `run --output ndjson` stream into Codor events. */
export function createTurnTranslator(): TurnTranslator {
  let sessionId: string | undefined;
  let finalText = '';
  let streamError: string | undefined;
  let terminal = false;
  const toolCalls = new Set<string>();

  const finish = (
    status: 'completed' | 'failed' | 'interrupted',
    error?: string,
  ): WireEvent[] => {
    if (terminal) return [];
    terminal = true;
    const resolved = finalText || streamError || error;
    return [{
      type: 'run.completed',
      status,
      ...(resolved && { final_text: resolved }),
      ...(status !== 'completed' && resolved && { error: resolved }),
    }];
  };

  return {
    sessionId: () => sessionId,

    push(line: string): WireEvent[] {
      if (line.trim() === '') return [];
      let event: TuraEvent;
      try {
        event = JSON.parse(line) as TuraEvent;
      } catch {
        return [];
      }
      if (typeof event.sessionID === 'string' && event.sessionID !== '') sessionId ??= event.sessionID;

      switch (event.type) {
        case 'message.part.delta':
          if (typeof event.text !== 'string' || event.text === '') return [];
          finalText += event.text;
          return [{ type: 'run.item', item_type: 'text_delta', payload: { text: event.text } }];
        case 'command.updated': {
          const properties = event.raw?.payload?.properties;
          const callId = typeof properties?.commandID === 'string' && properties.commandID !== ''
            ? properties.commandID
            : 'tura-command-run';
          const status = typeof properties?.status === 'string' ? properties.status : undefined;
          const tool = typeof properties?.command === 'string' ? properties.command : 'command_run';
          const events: WireEvent[] = [];
          if (!toolCalls.has(callId)) {
            toolCalls.add(callId);
            events.push({
              type: 'run.item',
              item_type: 'tool_call',
              payload: {
                call_id: callId,
                tool,
                title: tool === 'command_run' ? 'Command run' : tool,
                ...(properties?.input !== undefined && { input: properties.input }),
              },
            });
          }
          if (status !== undefined && TERMINAL_COMMAND_STATUSES.has(status)) {
            events.push({
              type: 'run.item',
              item_type: 'tool_result',
              payload: {
                call_id: callId,
                status: status === 'completed' || status === 'succeeded' ? 'ok' : 'error',
                ...(typeof properties?.output === 'string' && { output_text: properties.output }),
                raw: event.raw,
              },
            });
          }
          return events;
        }
        case 'cli.completed':
          if (typeof event.finalText === 'string' && event.finalText !== '') finalText = event.finalText;
          return finish(event.status === 'completed' ? 'completed' : 'failed');
        case 'cli.failed':
          streamError = errorText(event.error) ?? 'Tura reported a failed run';
          return finish('failed');
        default:
          return [];
      }
    },

    end(outcome): WireEvent[] {
      return finish(outcome.status, outcome.error);
    },
  };
}
