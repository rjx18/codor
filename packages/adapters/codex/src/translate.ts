import type { AgentUsage, WireEvent } from '@codor/protocol';

const MAX_OUTPUT = 256 * 1024;

type JsonRecord = Record<string, unknown>;

export interface CodexTranslatorContext {
  latestUsage?: AgentUsage;
}

export interface TurnTranslator {
  push(method: string, params: unknown): WireEvent[];
  end(fallback?: { status: 'failed' | 'interrupted'; error?: string }): WireEvent[];
  turnId(): string | undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function boundedOutput(value: string | undefined): string | undefined {
  if (value === undefined || Buffer.byteLength(value) <= MAX_OUTPUT) return value;
  const marker = '\n[output truncated at 256 KiB]';
  const markerBytes = Buffer.byteLength(marker);
  let prefix = Buffer.from(value).subarray(0, MAX_OUTPUT - markerBytes).toString('utf8');
  while (Buffer.byteLength(prefix) + markerBytes > MAX_OUTPUT) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}`;
}

function itemFrom(params: unknown): JsonRecord | undefined {
  if (!isRecord(params) || !isRecord(params.item)) return undefined;
  return params.item;
}

function fileChangeKind(kind: unknown): 'created' | 'modified' | 'deleted' {
  const type = isRecord(kind) ? kind.type : undefined;
  if (type === 'add') return 'created';
  if (type === 'delete') return 'deleted';
  return 'modified';
}

function resultText(item: JsonRecord): string | undefined {
  if (typeof item.aggregatedOutput === 'string') return item.aggregatedOutput;
  if (typeof item.error === 'string') return item.error;
  if (isRecord(item.error) && typeof item.error.message === 'string') return item.error.message;
  if (item.result !== undefined) return JSON.stringify(item.result);
  if (Array.isArray(item.contentItems)) return JSON.stringify(item.contentItems);
  return undefined;
}

function usageEvent(usage: AgentUsage | undefined): WireEvent[] {
  return usage === undefined || Object.keys(usage).length === 0
    ? []
    : [{ type: 'usage_updated', usage }];
}

// harn:assume codex-app-server-usage-is-context-aware-and-uncosted ref=codex-app-server-usage-mapping
// harn:assume normalized-agent-usage-telemetry-with-estimates ref=codex-usage-telemetry
/** Exact Codex 0.144.5 camelCase tokenUsage mapping; no historical aliases. */
export function agentUsageFromTokenUsage(tokenUsage: unknown): AgentUsage | undefined {
  if (!isRecord(tokenUsage) || !isRecord(tokenUsage.last)) return undefined;
  const last = tokenUsage.last;
  const inputTokens = nonnegativeInteger(last.inputTokens);
  const cachedInputTokens = nonnegativeInteger(last.cachedInputTokens);
  const outputTokens = nonnegativeInteger(last.outputTokens);
  const contextWindowMaxTokens = positiveInteger(tokenUsage.modelContextWindow);
  const contextWindowUsedTokens = nonnegativeInteger(last.totalTokens);
  const usage: AgentUsage = {
    ...(inputTokens !== undefined && { inputTokens }),
    ...(cachedInputTokens !== undefined && { cachedInputTokens }),
    ...(outputTokens !== undefined && { outputTokens }),
    ...(contextWindowMaxTokens !== undefined && contextWindowUsedTokens !== undefined && {
      contextWindowMaxTokens,
      contextWindowUsedTokens,
    }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}
// harn:end normalized-agent-usage-telemetry-with-estimates
// harn:end codex-app-server-usage-is-context-aware-and-uncosted

/** One app-server turn translator. Shared context carries only latest usage. */
export function createTurnTranslator(
  context: CodexTranslatorContext = {},
): TurnTranslator {
  let currentTurnId: string | undefined;
  let lastAgentText: string | undefined;
  let terminal = false;
  let unpairedNotificationCompletions = 0;
  let unpairedItemCompletions = 0;

  const completed = (
    status: 'completed' | 'failed' | 'interrupted',
    error?: string,
  ): WireEvent[] => {
    if (terminal) return [];
    terminal = true;
    const usage = context.latestUsage;
    return [{
      type: 'run.completed',
      status,
      ...(status === 'completed' && lastAgentText !== undefined && { final_text: lastAgentText }),
      ...(status === 'failed' && error !== undefined && error !== '' && { error }),
      ...(usage !== undefined && {
        usage: {
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
        },
        agent_usage: usage,
      }),
    }];
  };

  return {
    turnId: () => currentTurnId,

    push(method, params) {
      if (terminal) return [];
      // harn:assume first-party-run-items-normalized ref=codex-normalized-run-items
      if (method === 'turn/started') {
        if (isRecord(params) && isRecord(params.turn)) {
          currentTurnId = stringValue(params.turn.id);
        }
        return [];
      }

      if (method === 'thread/tokenUsage/updated') {
        if (!isRecord(params)) return [];
        const usage = agentUsageFromTokenUsage(params.tokenUsage);
        if (usage === undefined) return [];
        context.latestUsage = usage;
        return usageEvent(usage);
      }

      // harn:assume codex-app-server-compaction-follows-native-events ref=codex-app-server-compaction-translation
      if (method === 'thread/compacted') {
        if (unpairedItemCompletions > 0) {
          unpairedItemCompletions -= 1;
          return [];
        }
        unpairedNotificationCompletions += 1;
        return [{
          type: 'timeline',
          item: { type: 'compaction', status: 'completed', trigger: 'auto' },
        }];
      }

      if (method === 'item/started' || method === 'item/completed') {
        const item = itemFrom(params);
        if (item === undefined) return [];
        const itemType = stringValue(item.type);
        const itemId = stringValue(item.id) ?? 'codex-item';

        if (itemType === 'contextCompaction') {
          if (method === 'item/started') {
            return [{
              type: 'timeline',
              item: { type: 'compaction', status: 'loading', trigger: 'auto' },
            }];
          }
          if (unpairedNotificationCompletions > 0) {
            unpairedNotificationCompletions -= 1;
            return [];
          }
          unpairedItemCompletions += 1;
          return [{
            type: 'timeline',
            item: { type: 'compaction', status: 'completed', trigger: 'auto' },
          }];
        }
        // harn:end codex-app-server-compaction-follows-native-events

        if (itemType === 'agentMessage') {
          if (method !== 'item/completed') return [];
          lastAgentText = stringValue(item.text) ?? '';
          return [{ type: 'run.item', item_type: 'text_delta', payload: { text: lastAgentText } }];
        }

        if (itemType === 'reasoning') {
          if (method !== 'item/completed') return [];
          const summary = Array.isArray(item.summary)
            ? item.summary.filter((value): value is string => typeof value === 'string').join('\n')
            : '';
          return summary === ''
            ? []
            : [{ type: 'run.item', item_type: 'reasoning_summary', payload: { text: summary } }];
        }

        if (itemType === 'commandExecution') {
          if (method === 'item/started') {
            const command = stringValue(item.command);
            return [{
              type: 'run.item',
              item_type: 'tool_call',
              payload: {
                call_id: itemId,
                tool: 'Bash',
                title: command ?? 'Shell command',
                input: { command },
              },
            }];
          }
          const exitCode = nonnegativeInteger(item.exitCode);
          return [{
            type: 'run.item',
            item_type: 'tool_result',
            payload: {
              call_id: itemId,
              status: exitCode === 0 && item.status === 'completed' ? 'ok' : 'error',
              output_text: boundedOutput(resultText(item)),
              ...(nonnegativeInteger(item.durationMs) !== undefined && {
                duration_ms: nonnegativeInteger(item.durationMs),
              }),
              raw: item,
            },
          }];
        }

        if (itemType === 'fileChange') {
          if (method !== 'item/completed' || !Array.isArray(item.changes)) return [];
          return item.changes.flatMap((value): WireEvent[] => {
            if (!isRecord(value) || typeof value.path !== 'string') return [];
            return [{
              type: 'run.item',
              item_type: 'file_change',
              payload: {
                path: value.path,
                change: fileChangeKind(value.kind),
                ...(typeof value.diff === 'string' && {
                  diff: { path: value.path, unified: value.diff },
                }),
              },
            }];
          });
        }

        if (itemType === 'mcpToolCall' || itemType === 'dynamicToolCall') {
          const tool = stringValue(item.tool) ?? itemType;
          if (method === 'item/started') {
            return [{
              type: 'run.item',
              item_type: 'tool_call',
              payload: {
                call_id: itemId,
                tool,
                title: stringValue(item.server) === undefined
                  ? tool
                  : `${String(item.server)} / ${tool}`,
                input: item.arguments,
              },
            }];
          }
          const success = item.success === true || item.status === 'completed';
          return [{
            type: 'run.item',
            item_type: 'tool_result',
            payload: {
              call_id: itemId,
              status: success && item.error === undefined ? 'ok' : 'error',
              output_text: boundedOutput(resultText(item)),
              raw: item,
            },
          }];
        }
        return [];
      }

      if (method === 'turn/completed') {
        if (!isRecord(params) || !isRecord(params.turn)) {
          return completed('failed', 'Codex app-server emitted an invalid turn/completed');
        }
        const status = params.turn.status;
        if (status === 'interrupted') return completed('interrupted');
        if (status === 'failed') {
          const error = isRecord(params.turn.error)
            ? stringValue(params.turn.error.message)
            : undefined;
          return completed('failed', error ?? 'Codex turn failed');
        }
        if (status === 'completed') return completed('completed');
        return completed('failed', `Codex app-server emitted terminal status ${String(status)}`);
      }
      return [];
      // harn:end first-party-run-items-normalized
    },

    end(fallback = { status: 'interrupted' as const }) {
      return completed(fallback.status, fallback.error);
    },
  };
}
