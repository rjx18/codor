import type { WireEvent } from '@codor/protocol';

interface TuraEvent {
  type?: string;
  sessionID?: string;
  messageID?: string;
  text?: string;
  finalText?: string;
  status?: string;
  error?: unknown;
  raw?: {
    payload?: {
      properties?: {
        info?: { role?: unknown };
        commandID?: unknown;
        status?: unknown;
        command?: unknown;
        input?: unknown;
        output?: unknown;
        result?: {
          success?: unknown;
          output?: { stdout?: unknown; stderr?: unknown };
        };
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

function commandDetails(value: unknown): { tool: string; input?: unknown } {
  if (!value || typeof value !== 'object') {
    return { tool: typeof value === 'string' ? value : 'command_run' };
  }
  const command = value as { command_type?: unknown; command_line?: unknown };
  let input: unknown = command.command_line;
  if (typeof input === 'string') {
    try { input = JSON.parse(input) as unknown; } catch { /* retain the raw command line */ }
  }
  return {
    tool: typeof command.command_type === 'string' ? command.command_type : 'command_run',
    ...(input !== undefined && { input }),
  };
}

function outputText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const output = value as { stdout?: unknown; stderr?: unknown };
  const text = [output.stdout, output.stderr].filter((part): part is string => typeof part === 'string' && part !== '').join('');
  return text || undefined;
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
  let streamedText = '';
  let streamError: string | undefined;
  let terminal = false;
  const toolCalls = new Set<string>();

  const finish = (
    status: 'completed' | 'failed' | 'interrupted',
    error?: string,
  ): WireEvent[] => {
    if (terminal) return [];
    terminal = true;
    const resolved = finalText || streamedText || streamError || error;
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
          // The source gateway can publish a partial delta after it has already
          // committed the final assistant message (for example `ONG` then
          // `PONG`). Keep it as a fallback, but publish the authoritative
          // final/message update only once at completion.
          streamedText += event.text;
          return [];
        case 'message.updated':
          // A resumed command-run turn reports its final answer through a
          // repeatable message update before reporting the session as idle.
          if (event.raw?.payload?.properties?.info?.role === 'assistant' && typeof event.text === 'string') {
            finalText = event.text;
          }
          return [];
        case 'command.updated': {
          const properties = event.raw?.payload?.properties;
          const callId = typeof properties?.commandID === 'string' && properties.commandID !== ''
            ? properties.commandID
            : 'tura-command-run';
          const status = typeof properties?.status === 'string' ? properties.status : undefined;
          const command = commandDetails(properties?.command);
          const events: WireEvent[] = [];
          if (!toolCalls.has(callId)) {
            toolCalls.add(callId);
            events.push({
              type: 'run.item',
              item_type: 'tool_call',
              payload: {
                call_id: callId,
                tool: command.tool,
                title: command.tool === 'command_run' ? 'Command run' : command.tool,
                ...(properties?.input !== undefined && { input: properties.input }),
                ...(properties?.input === undefined && command.input !== undefined && { input: command.input }),
              },
            });
          }
          const result = properties?.result;
          if (status !== undefined && TERMINAL_COMMAND_STATUSES.has(status) && (properties?.output !== undefined || result != null)) {
            events.push({
              type: 'run.item',
              item_type: 'tool_result',
              payload: {
                call_id: callId,
                status: result?.success === false || (status !== 'completed' && status !== 'succeeded') ? 'error' : 'ok',
                ...(outputText(properties?.output ?? result?.output) && { output_text: outputText(properties?.output ?? result?.output) }),
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
        case 'session.status':
          // `run --zsh --session` remains subscribed when the native session
          // reaches idle instead of emitting cli.completed.
          return event.status === 'idle' ? finish('completed') : [];
        default:
          return [];
      }
    },

    end(outcome): WireEvent[] {
      return finish(outcome.status, outcome.error);
    },
  };
}
