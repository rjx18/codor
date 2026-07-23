import type { WireEvent } from '@codor/protocol';

type JsonRecord = Record<string, unknown>;

interface GrokEvent extends JsonRecord {
  type?: string;
  session_id?: string;
  sessionId?: string;
  subtype?: string;
  delta?: string;
  text?: string;
  output_text?: string;
  result?: string;
  data?: unknown;
  status?: string;
  stopReason?: string;
  usage?: JsonRecord;
  response?: JsonRecord;
}

export interface TurnTranslator {
  push(line: string): WireEvent[];
  end(fallback?: { status: 'failed' | 'interrupted'; final_text?: string }): WireEvent[];
  sessionId(): string | undefined;
}

const MAX_OUTPUT = 256 * 1024;

function boundedOutput(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) <= MAX_OUTPUT) return text;
  const marker = '\n[output truncated at 256 KiB]';
  const markerBytes = Buffer.byteLength(marker);
  let prefix = Buffer.from(text).subarray(0, MAX_OUTPUT - markerBytes).toString('utf8');
  while (Buffer.byteLength(prefix) + markerBytes > MAX_OUTPUT) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}`;
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? value as JsonRecord : undefined;
}

function stringField(value: unknown, ...keys: string[]): string | undefined {
  const source = record(value);
  if (source === undefined) return undefined;
  for (const key of keys) {
    if (typeof source[key] === 'string' && source[key] !== '') return source[key] as string;
  }
  return undefined;
}

function numberField(value: unknown, ...keys: string[]): number | undefined {
  const source = record(value);
  if (source === undefined) return undefined;
  for (const key of keys) {
    if (typeof source[key] === 'number' && Number.isFinite(source[key])) return source[key] as number;
  }
  return undefined;
}

function usageFrom(event: GrokEvent): { input_tokens: number; output_tokens: number } | undefined {
  const usage = event.usage ?? event.response?.usage;
  if (usage === undefined) return undefined;
  const input = numberField(usage, 'input_tokens', 'inputTokens', 'prompt_tokens') ?? 0;
  const output = numberField(usage, 'output_tokens', 'outputTokens', 'completion_tokens') ?? 0;
  return input === 0 && output === 0 &&
    numberField(usage, 'total_tokens', 'totalTokens') === undefined
    ? undefined
    : { input_tokens: input, output_tokens: output };
}

function textFrom(event: GrokEvent): string | undefined {
  return stringField(event, 'delta', 'text', 'output_text', 'result', 'content') ??
    (typeof event.data === 'string' ? event.data : undefined) ??
    stringField(event.response, 'output_text', 'text', 'content');
}

function eventType(event: GrokEvent): string {
  return event.type ?? event.subtype ?? '';
}

function isTerminal(type: string, event: GrokEvent): boolean {
  return type === 'result' || type === 'done' || type === 'complete' ||
    type === 'end' ||
    type === 'response.completed' || type === 'response.failed' ||
    type === 'turn.completed' || type === 'session.completed' ||
    ['success', 'completed', 'failed', 'error'].includes(event.status ?? '');
}

// harn:assume grok-capability-truth ref=grok-event-translation
/** Translate Grok's streaming-json/Responses-style events into WireEvents. */
export function createTurnTranslator(initialSessionId?: string): TurnTranslator {
  let sessionId = initialSessionId;
  let finalText = '';
  let streamError: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let hasUsage = false;
  let terminal = false;

  return {
    sessionId: () => sessionId,

    push(line: string): WireEvent[] {
      if (line.trim() === '') return [];
      let event: GrokEvent;
      try {
        event = JSON.parse(line) as GrokEvent;
      } catch {
        return [];
      }

      const discovered = stringField(event, 'session_id', 'sessionId');
      if (discovered !== undefined) sessionId = discovered;
      const type = eventType(event);
      const usage = usageFrom(event);
      if (usage !== undefined) {
        inputTokens = usage.input_tokens;
        outputTokens = usage.output_tokens;
        hasUsage = true;
      }

      if (type === 'response.reasoning_summary_text.delta' || type === 'reasoning_delta' ||
        type === 'reasoning' || type === 'thought') {
        const text = textFrom(event) ?? '';
        return text === '' ? [] : [{ type: 'run.item', item_type: 'reasoning_summary', payload: { text } }];
      }

      if (type === 'tool_call' || type === 'tool_use' || type === 'tool.started' ||
        type === 'tool.execution_start') {
        const tool = stringField(event, 'tool_name', 'toolName', 'name') ?? 'tool';
        const callId = stringField(event, 'call_id', 'callId', 'tool_call_id', 'toolCallId') ?? `grok-${tool}`;
        return [{
          type: 'run.item',
          item_type: 'tool_call',
          payload: {
            call_id: callId,
            tool,
            title: tool,
            input: event.arguments ?? event.input ?? event.parameters ?? {},
          },
        }];
      }

      if (type === 'tool_result' || type === 'tool.completed' || type === 'tool.execution_complete') {
        const callId = stringField(event, 'call_id', 'callId', 'tool_call_id', 'toolCallId') ?? 'grok-tool';
        const failed = event.status === 'error' || event.status === 'failed' || event.success === false;
        return [{
          type: 'run.item',
          item_type: 'tool_result',
          payload: {
            call_id: callId,
            status: failed ? 'error' : 'ok',
            output_text: boundedOutput(event.output ?? event.result ?? event.error),
            raw: event,
          },
        }];
      }

      if (type === 'error' || type === 'response.error' || event.status === 'error' || event.status === 'failed') {
        streamError = stringField(event, 'message', 'error', 'detail') ?? boundedOutput(event.error);
        return streamError === undefined ? [] : [{
          type: 'run.item',
          item_type: 'tool_result',
          payload: { call_id: 'grok-error', status: 'error', output_text: streamError, raw: event },
        }];
      }

      if (type === 'response.output_text.delta' || type === 'text_delta' || type === 'assistant.message_delta' ||
        type === 'message' || type === 'assistant' || type === 'text') {
        const text = textFrom(event) ?? '';
        if (text === '') return [];
        finalText += text;
        return [{ type: 'run.item', item_type: 'text_delta', payload: { text } }];
      }

      if (isTerminal(type, event)) {
        terminal = true;
        const text = finalText !== '' ? finalText : textFrom(event);
        const status = event.status === 'failed' || event.status === 'error' || type === 'response.failed' ||
          event.stopReason === 'Error' || event.stopReason === 'error'
          ? 'failed'
          : 'completed';
        return [{
          type: 'run.completed',
          status,
          ...(text !== undefined && text !== '' && { final_text: text }),
          ...(hasUsage && { usage: { input_tokens: inputTokens, output_tokens: outputTokens } }),
        }];
      }
      return [];
    },

    end(fallback = { status: 'interrupted' as const }): WireEvent[] {
      if (terminal) return [];
      terminal = true;
      const resolvedText = fallback.final_text ?? (finalText || streamError);
      return [{
        type: 'run.completed',
        status: fallback.status,
        ...(resolvedText !== undefined && resolvedText !== '' && { final_text: resolvedText }),
        ...(hasUsage && { usage: { input_tokens: inputTokens, output_tokens: outputTokens } }),
      }];
    },
  };
}
// harn:end grok-capability-truth
