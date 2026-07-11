import type { WireEvent } from '@codor/protocol';

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

const MAX_OUTPUT = 256 * 1024;

function boundedOutput(value: string | undefined): string | undefined {
  if (value === undefined || Buffer.byteLength(value) <= MAX_OUTPUT) return value;
  const marker = '\n[output truncated at 256 KiB]';
  const markerBytes = Buffer.byteLength(marker);
  let prefix = Buffer.from(value).subarray(0, MAX_OUTPUT - markerBytes).toString('utf8');
  while (Buffer.byteLength(prefix) + markerBytes > MAX_OUTPUT) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}`;
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

      // harn:assume first-party-run-items-normalized ref=gemini-normalized-run-items
      switch (event.type) {
        case 'init':
          sessionId = event.session_id;
          return [];
        case 'message':
          if (event.role !== 'assistant') return [];
          finalText += event.content ?? '';
          return [{ type: 'run.item', item_type: 'text_delta', payload: { text: event.content ?? '' } }];
        case 'tool_use':
          return [
            {
              type: 'run.item',
              item_type: 'tool_call',
              payload: {
                call_id: event.tool_id ?? 'gemini-tool',
                tool: event.tool_name ?? 'tool',
                title: event.tool_name ?? 'Tool call',
                input: event.parameters ?? {},
              },
            },
          ];
        case 'tool_result':
          return [
            {
              type: 'run.item',
              item_type: 'tool_result',
              payload: {
                call_id: event.tool_id ?? 'gemini-tool',
                status: event.status === 'success' ? 'ok' : 'error',
                output_text: boundedOutput(event.output ?? event.error?.message),
                raw: event,
              },
            },
          ];
        case 'error':
          if (event.severity === 'error') streamError = event.message;
          return [
            {
              type: 'run.item',
              item_type: 'tool_result',
              payload: {
                call_id: 'gemini-error',
                status: 'error',
                output_text: boundedOutput(event.message),
                raw: event,
              },
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
      // harn:end first-party-run-items-normalized
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
