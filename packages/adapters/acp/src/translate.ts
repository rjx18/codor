import type {
  ContentBlock,
  Plan,
  PromptResponse,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
  UsageUpdate,
} from '@agentclientprotocol/sdk';
import type { AcpUsageBaseline, AgentUsage, WireEvent } from '@codor/protocol';

interface ToolState {
  title: string;
  kind: string;
  input?: unknown;
  emitted: boolean;
  terminal: boolean;
}

const textFromContent = (content: ContentBlock): string | undefined =>
  content.type === 'text' ? content.text : undefined;

function boundedJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value).slice(0, 16_384);
  } catch {
    return String(value).slice(0, 16_384);
  }
}

function unifiedDiff(path: string, oldText: string | null | undefined, newText: string): string {
  const before = oldText ?? '';
  const oldLines = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const newLines = newText === '' ? [] : newText.replace(/\n$/, '').split('\n');
  const oldStart = oldLines.length === 0 ? 0 : 1;
  const newStart = newLines.length === 0 ? 0 : 1;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function resultContent(content: readonly ToolCallContent[] | null | undefined, toolKind: string): {
  output?: string;
  diffs: { path: string; unified: string; change: 'created' | 'modified' | 'deleted' }[];
} {
  const output: string[] = [];
  const diffs: { path: string; unified: string; change: 'created' | 'modified' | 'deleted' }[] = [];
  for (const item of content ?? []) {
    if (item.type === 'content') {
      const text = textFromContent(item.content);
      if (text !== undefined) output.push(text);
    } else if (item.type === 'terminal') {
      output.push(`Terminal ${item.terminalId}`);
    } else {
      diffs.push({
        path: item.path,
        unified: unifiedDiff(item.path, item.oldText, item.newText),
        change: item.oldText == null ? 'created' : toolKind === 'delete' ? 'deleted' : 'modified',
      });
    }
  }
  return { ...(output.length > 0 && { output: output.join('\n') }), diffs };
}

function planText(plan: Plan): string {
  return plan.entries
    .map((entry) => `[${entry.status}] ${entry.content}`)
    .join('\n');
}

function usageDelta(current: number | null | undefined, previous: number | undefined, reset: boolean): number {
  if (current == null) return 0;
  if (reset || previous === undefined) return current;
  return Math.max(0, current - previous);
}

function turnUsage(response: PromptResponse, previous: AcpUsageBaseline | undefined): {
  usage?: AgentUsage;
  baseline?: AcpUsageBaseline;
} {
  const usage = response.usage;
  if (usage == null) return {};
  const reset = previous !== undefined && usage.totalTokens <= previous.totalTokens;
  const cachedInputTokens =
    usageDelta(usage.cachedReadTokens, previous?.cachedReadTokens, reset) +
    usageDelta(usage.cachedWriteTokens, previous?.cachedWriteTokens, reset);
  return {
    usage: {
      inputTokens: usageDelta(usage.inputTokens, previous?.inputTokens, reset),
      ...(cachedInputTokens > 0 && { cachedInputTokens }),
      outputTokens: usageDelta(usage.outputTokens, previous?.outputTokens, reset),
    },
    baseline: {
      totalTokens: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cachedReadTokens != null
        ? { cachedReadTokens: usage.cachedReadTokens }
        : previous?.cachedReadTokens !== undefined && { cachedReadTokens: previous.cachedReadTokens }),
      ...(usage.cachedWriteTokens != null
        ? { cachedWriteTokens: usage.cachedWriteTokens }
        : previous?.cachedWriteTokens !== undefined && { cachedWriteTokens: previous.cachedWriteTokens }),
    },
  };
}

function contextUsage(update: UsageUpdate): AgentUsage {
  return {
    contextWindowUsedTokens: update.used,
    contextWindowMaxTokens: update.size,
  };
}

export interface AcpTurnTranslator {
  push(update: SessionUpdate): WireEvent[];
  complete(response: PromptResponse, baseline?: AcpUsageBaseline): {
    events: WireEvent[];
    baseline?: AcpUsageBaseline;
  };
}

// harn:assume acp-v1-events-and-capabilities-are-negotiated ref=acp-event-normalization
export function createAcpTurnTranslator(): AcpTurnTranslator {
  const tools = new Map<string, ToolState>();

  const toolEvents = (call: ToolCall | ToolCallUpdate, initial: boolean): WireEvent[] => {
    const previous = tools.get(call.toolCallId);
    const title = call.title ?? previous?.title ?? 'ACP tool';
    const kind = call.kind ?? previous?.kind ?? 'other';
    const input = call.rawInput ?? previous?.input;
    const state: ToolState = previous ?? { title, kind, input, emitted: false, terminal: false };
    state.title = title;
    state.kind = kind;
    state.input = input;
    tools.set(call.toolCallId, state);

    const events: WireEvent[] = [];
    if (!state.emitted) {
      events.push({
        type: 'run.item',
        item_type: 'tool_call',
        payload: {
          call_id: call.toolCallId,
          tool: kind,
          title,
          ...(input !== undefined && { input }),
        },
      });
      state.emitted = true;
    }

    const terminal = call.status === 'completed' || call.status === 'failed';
    if (!terminal || state.terminal) return events;
    state.terminal = true;
    const content = resultContent(call.content, kind);
    for (const diff of content.diffs) {
      events.push({
        type: 'run.item',
        item_type: 'file_change',
        payload: { path: diff.path, change: diff.change, diff: { path: diff.path, unified: diff.unified } },
      });
    }
    const firstDiff = content.diffs[0];
    const raw = call.rawOutput;
    events.push({
      type: 'run.item',
      item_type: 'tool_result',
      payload: {
        call_id: call.toolCallId,
        status: call.status === 'failed' ? 'error' : 'ok',
        ...(content.output !== undefined
          ? { output_text: content.output }
          : raw !== undefined
            ? { output_text: boundedJson(raw) }
            : {}),
        ...(firstDiff !== undefined && {
          diff: { path: firstDiff.path, unified: firstDiff.unified },
        }),
        ...(raw !== undefined && { raw }),
      },
    });
    return events;
  };

  return {
    push(update) {
      if (update.sessionUpdate === 'agent_message_chunk') {
        const text = textFromContent(update.content);
        return text === undefined ? [] : [{ type: 'run.item', item_type: 'text_delta', payload: { text } }];
      }
      if (update.sessionUpdate === 'agent_thought_chunk') {
        const text = textFromContent(update.content);
        return text === undefined ? [] : [{
          type: 'run.item', item_type: 'reasoning_summary', payload: { text },
        }];
      }
      if (update.sessionUpdate === 'tool_call') return toolEvents(update, true);
      if (update.sessionUpdate === 'tool_call_update') return toolEvents(update, false);
      if (update.sessionUpdate === 'plan') {
        return [{ type: 'run.item', item_type: 'reasoning_summary', payload: { text: planText(update) } }];
      }
      if (update.sessionUpdate === 'usage_update') {
        return [{ type: 'usage_updated', usage: contextUsage(update) }];
      }
      return [];
    },
    complete(response, baseline) {
      const interrupted = response.stopReason === 'cancelled';
      const failed = response.stopReason === 'refusal';
      const limited = response.stopReason === 'max_tokens' || response.stopReason === 'max_turn_requests';
      const terminalError = response.stopReason === 'max_tokens'
        ? 'ACP agent stopped after reaching the token limit'
        : response.stopReason === 'max_turn_requests'
          ? 'ACP agent stopped after reaching the turn request limit'
          : failed
            ? 'ACP agent refused the turn'
            : undefined;
      const measured = turnUsage(response, baseline);
      return {
        events: [{
          type: 'run.completed',
          status: interrupted || limited ? 'interrupted' : failed ? 'failed' : 'completed',
          ...(terminalError !== undefined && { error: terminalError }),
          ...(measured.usage !== undefined && {
          agent_usage: measured.usage,
          usage: {
            input_tokens: measured.usage.inputTokens ?? 0,
            ...(measured.usage.cachedInputTokens !== undefined && {
              cached_input_tokens: measured.usage.cachedInputTokens,
            }),
            output_tokens: measured.usage.outputTokens ?? 0,
          },
        }),
        }],
        ...(measured.baseline !== undefined && { baseline: measured.baseline }),
      };
    },
  };
}
// harn:end acp-v1-events-and-capabilities-are-negotiated
