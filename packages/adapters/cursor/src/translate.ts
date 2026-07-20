import type { WireEvent } from '@codor/protocol';

/** One line of `cursor-agent --output-format stream-json` output. */
interface CursorEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  timestamp_ms?: number;
  is_error?: boolean;
  result?: string;
  text?: string;
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  call_id?: string;
  tool_call?: Record<string, { args?: unknown; result?: unknown }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
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

function assistantText(event: CursorEvent): string {
  return (event.message?.content ?? [])
    .filter((part) => part.type === 'text' || part.type === undefined)
    .map((part) => part.text ?? '')
    .join('');
}

/** `{ shellToolCall: {...} }` -> ['shell', innerObject]. */
function toolEntry(event: CursorEvent): { name: string; inner: { args?: unknown; result?: unknown } } {
  const map = event.tool_call ?? {};
  const key = Object.keys(map)[0];
  if (key === undefined) return { name: 'tool', inner: {} };
  return { name: key.replace(/ToolCall$/, '') || 'tool', inner: map[key] ?? {} };
}

/** A short, human-facing detail line for a tool call, best-effort per tool shape. */
function toolDetail(name: string, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const a = args as Record<string, unknown>;
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  return pick(a['command']) ?? pick(a['path']) ?? pick(a['description']) ?? pick(a['query']);
}

/**
 * Translate the `cursor-agent` stream-json event vocabulary into WireEvents.
 * Event shapes are documented in NOTES.md (captured from the live CLI).
 */
export function createTurnTranslator(): TurnTranslator {
  let sessionId: string | undefined;
  let finalText = '';
  let terminal = false;

  return {
    sessionId: () => sessionId,

    push(line: string): WireEvent[] {
      if (line.trim() === '') return [];
      let event: CursorEvent;
      try {
        event = JSON.parse(line) as CursorEvent;
      } catch {
        return [];
      }

      switch (event.type) {
        case 'system':
          if (event.subtype === 'init' && typeof event.session_id === 'string') {
            sessionId = event.session_id;
          }
          return [];

        case 'thinking':
          if (event.subtype !== 'delta' || !event.text) return [];
          return [{ type: 'run.item', item_type: 'reasoning_summary', payload: { text: event.text } }];

        case 'assistant': {
          // Streaming deltas carry timestamp_ms; the final cumulative echo does not.
          // Emit only the deltas so text is not counted twice.
          if (event.timestamp_ms === undefined) return [];
          const text = assistantText(event);
          if (text === '') return [];
          finalText += text;
          return [{ type: 'run.item', item_type: 'text_delta', payload: { text } }];
        }

        case 'tool_call': {
          const { name, inner } = toolEntry(event);
          const callId = event.call_id ?? `cursor-${name}`;
          if (event.subtype === 'started') {
            const detail = toolDetail(name, inner.args);
            return [
              {
                type: 'run.item',
                item_type: 'tool_call',
                payload: {
                  call_id: callId,
                  tool: name,
                  title: detail ?? name,
                  ...(detail !== undefined && { detail }),
                  input: inner.args ?? {},
                },
              },
            ];
          }
          if (event.subtype === 'completed') {
            const result = inner.result as Record<string, unknown> | undefined;
            const ok = result === undefined || 'success' in result;
            return [
              {
                type: 'run.item',
                item_type: 'tool_result',
                payload: {
                  call_id: callId,
                  status: ok ? 'ok' : 'error',
                  output_text: boundedOutput(result === undefined ? undefined : JSON.stringify(result)),
                  raw: event,
                },
              },
            ];
          }
          return [];
        }

        case 'result': {
          terminal = true;
          const completed = event.subtype === 'success' && event.is_error !== true;
          // Prefer the text assembled from streamed `text_delta`s so `final_text`
          // matches codor's journaled prose byte-for-byte. cursor's `result` is a
          // whitespace-normalized echo (e.g. it can gain a leading newline); when it
          // diverges from the streamed text, codor's residual de-dupe fails to match
          // and re-appends the whole reply, doubling it. Fall back to `result` only
          // when nothing was streamed.
          const resultText = typeof event.result === 'string' ? event.result : '';
          const text = finalText !== '' ? finalText : resultText;
          const usage = event.usage === undefined
            ? undefined
            : {
                input_tokens: event.usage.inputTokens ?? 0,
                output_tokens: event.usage.outputTokens ?? 0,
              };
          return [
            {
              type: 'run.completed',
              status: completed ? 'completed' : 'failed',
              ...(text !== '' && { final_text: text }),
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
          ...(fallback.final_text !== undefined || finalText !== ''
            ? { final_text: fallback.final_text ?? finalText }
            : {}),
        },
      ];
    },
  };
}
