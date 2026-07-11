import type { WireEvent } from '@wireroom/protocol';

interface OpenCodeToolState {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
}

interface OpenCodePart {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: OpenCodeToolState;
  tokens?: { input?: number; output?: number };
  cost?: number;
  reason?: string;
}

interface OpenCodeEvent {
  type?: string;
  sessionID?: string;
  part?: OpenCodePart;
  error?: unknown;
}

function diagnostic(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { message?: unknown; name?: unknown; data?: { message?: unknown } };
  if (typeof value.data?.message === 'string') return value.data.message;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.name === 'string') return value.name;
  return undefined;
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

export interface TurnTranslator {
  push(line: string): WireEvent[];
  end(outcome: {
    status: 'completed' | 'failed' | 'interrupted';
    final_text?: string;
  }): WireEvent[];
  sessionId(): string | undefined;
}

// harn:assume opencode-capability-truth ref=opencode-event-translation
/** Translate OpenCode 1.17 `run --format json` records into WireEvents. */
export function createTurnTranslator(): TurnTranslator {
  let sessionId: string | undefined;
  let finalText = '';
  let streamError: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let hasUsage = false;
  let terminal = false;

  return {
    sessionId: () => sessionId,

    push(line: string): WireEvent[] {
      if (line.trim() === '') return [];
      let event: OpenCodeEvent;
      try {
        event = JSON.parse(line) as OpenCodeEvent;
      } catch {
        return [];
      }
      if (typeof event.sessionID === 'string' && event.sessionID !== '') {
        sessionId ??= event.sessionID;
      }

      const part = event.part;
      // harn:assume first-party-run-items-normalized ref=opencode-normalized-run-items
      switch (event.type) {
        case 'step_start':
          return [];
        case 'text':
          if (part?.type !== 'text') return [];
          finalText += part.text ?? '';
          return [{ type: 'run.item', item_type: 'text_delta', payload: { text: part.text ?? '' } }];
        case 'reasoning':
          if (part?.type !== 'reasoning') return [];
          return [{ type: 'run.item', item_type: 'reasoning_summary', payload: { text: part.text ?? '' } }];
        case 'tool_use': {
          if (part?.type !== 'tool') return [];
          const callId = part.callID ?? 'opencode-tool';
          const tool = part.tool ?? 'tool';
          const call = {
            type: 'run.item' as const,
            item_type: 'tool_call' as const,
            payload: {
              tool,
              call_id: callId,
              input: part.state?.input ?? {},
              title: part.state?.title ?? tool,
            },
          };
          const result = {
            type: 'run.item' as const,
            item_type: 'tool_result' as const,
            payload: {
              call_id: callId,
              status: part.state?.status === 'completed' ? 'ok' : 'error',
              output_text: boundedOutput(part.state?.output ?? part.state?.error),
              raw: part.state,
            },
          };
          return [call, result];
        }
        case 'step_finish':
          if (part?.type !== 'step-finish') return [];
          hasUsage = true;
          inputTokens += part.tokens?.input ?? 0;
          outputTokens += part.tokens?.output ?? 0;
          costUsd += part.cost ?? 0;
          return [];
        case 'error': {
          streamError = diagnostic(event.error);
          return [
            {
              type: 'run.item',
              item_type: 'tool_result',
              payload: {
                call_id: 'opencode-error',
                status: 'error',
                output_text: boundedOutput(streamError),
                raw: event.error,
              },
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
      return [
        {
          type: 'run.completed',
          status: outcome.status,
          ...(resolvedText !== undefined && resolvedText !== '' && { final_text: resolvedText }),
          ...(hasUsage && {
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cost_usd: costUsd,
            },
          }),
        },
      ];
    },
  };
}
// harn:end opencode-capability-truth
