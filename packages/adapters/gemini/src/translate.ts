import type { WireEvent } from '@wireroom/protocol';

interface GeminiStats {
  input_tokens?: number;
  output_tokens?: number;
}

interface GeminiEvent {
  type?: string;
  session_id?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  tool_name?: string;
  tool_id?: string;
  parameters?: Record<string, unknown>;
  status?: string;
  output?: string;
  error?: { type?: string; message?: string };
  severity?: string;
  message?: string;
  stats?: GeminiStats;
}

export interface TurnTranslator {
  push(line: string): WireEvent[];
  end(fallback?: { status: 'failed' | 'interrupted'; final_text?: string }): WireEvent[];
  sessionId(): string | undefined;
}

// harn:assume gemini-capability-truth ref=gemini-documented-event-translation
/** Translate the first-party stream-json event vocabulary into WireEvents. */
export function createTurnTranslator(): TurnTranslator {
  let sessionId: string | undefined;
  let finalText = '';
  let streamError: string | undefined;
  let terminal = false;

  return {
    sessionId: () => sessionId,

    push(line: string): WireEvent[] {
      if (line.trim() === '') return [];
      let event: GeminiEvent;
      try {
        event = JSON.parse(line) as GeminiEvent;
      } catch {
        return [];
      }

      switch (event.type) {
        case 'init':
          sessionId = event.session_id;
          return [];
        case 'message':
          if (event.role !== 'assistant') return [];
          finalText += event.content ?? '';
          return [{ type: 'run.item', item_type: 'text_delta', payload: event.content ?? '' }];
        case 'tool_use':
          return [
            {
              type: 'run.item',
              item_type: 'tool_call',
              payload: {
                tool_name: event.tool_name,
                tool_id: event.tool_id,
                parameters: event.parameters ?? {},
              },
            },
          ];
        case 'tool_result':
          return [
            {
              type: 'run.item',
              item_type: 'tool_result',
              payload: {
                tool_id: event.tool_id,
                status: event.status,
                output: event.output,
                error: event.error,
              },
            },
          ];
        case 'error':
          if (event.severity === 'error') streamError = event.message;
          return [
            {
              type: 'run.item',
              item_type: 'tool_result',
              payload: { kind: 'error', severity: event.severity, message: event.message },
            },
          ];
        case 'result': {
          terminal = true;
          const usage = event.stats === undefined
            ? undefined
            : {
                input_tokens: event.stats.input_tokens ?? 0,
                output_tokens: event.stats.output_tokens ?? 0,
              };
          return [
            {
              type: 'run.completed',
              status: event.status === 'success' ? 'completed' : 'failed',
              ...(finalText !== '' || streamError !== undefined || event.error?.message !== undefined
                ? { final_text: finalText || event.error?.message || streamError }
                : {}),
              ...(usage !== undefined && { usage }),
            },
          ];
        }
        default:
          return [];
      }
    },

    end(fallback = { status: 'interrupted' as const }): WireEvent[] {
      if (terminal) return [];
      terminal = true;
      return [
        {
          type: 'run.completed',
          status: fallback.status,
          ...(fallback.final_text !== undefined || finalText !== '' || streamError !== undefined
            ? { final_text: fallback.final_text ?? (finalText || streamError) }
            : {}),
        },
      ];
    },
  };
}
// harn:end gemini-capability-truth
