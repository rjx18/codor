import type { WireEvent } from '@codor/protocol';

/**
 * Pure translator: Claude Agent SDK message objects → WireEvents. String input
 * remains accepted so the historical scrubbed JSONL captures can be replayed
 * without creating an SDK query (see NOTES.md).
 */

interface ClaudeContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | ClaudeContentBlock[];
  source?: { type?: string; media_type?: string; data?: string };
}

interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeEvent {
  type: string;
  subtype?: string;
  status?: unknown;
  session_id?: string;
  model?: string;
  message?: {
    model?: string;
    content?: (ClaudeContentBlock | string)[];
    usage?: ClaudeUsage;
  };
  result?: string;
  is_error?: boolean;
  errors?: unknown;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  modelUsage?: Record<string, { contextWindow?: number }>;
  compact_metadata?: unknown;
  compactMetadata?: unknown;
  compactionMetadata?: unknown;
  rate_limit_info?: {
    status?: string;
    resetsAt?: number; // unix seconds
    rateLimitType?: string; // five_hour / weekly / ...
    utilization?: number; // percent, present in newer CLIs
  };
}

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// harn:assume normalized-agent-usage-and-context-telemetry ref=claude-usage-telemetry
// Seeded from paseo's curated Claude catalog. A result's engine-reported
// modelUsage.contextWindow replaces this seed when it is available.
const CLAUDE_CONTEXT_WINDOWS = new Map<string, number>([
  ['claude-fable-5', 1_000_000],
  ['claude-opus-4-8[1m]', 1_000_000],
  ['claude-opus-4-8', 200_000],
  ['claude-sonnet-5', 1_000_000],
  ['claude-opus-4-7[1m]', 1_000_000],
  ['claude-opus-4-7', 200_000],
  ['claude-opus-4-6[1m]', 1_000_000],
  ['claude-opus-4-6', 200_000],
  ['claude-sonnet-4-6[1m]', 1_000_000],
  ['claude-sonnet-4-6', 200_000],
  ['claude-haiku-4-5', 200_000],
]);

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function contextWindowUsed(usage: ClaudeUsage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  const values = [
    tokenCount(usage.input_tokens),
    tokenCount(usage.cache_read_input_tokens),
    tokenCount(usage.cache_creation_input_tokens),
  ];
  if (values.every((value) => value === undefined)) return undefined;
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

// harn:assume context-ceiling-follows-main-model ref=claude-main-model-window
function reportedContextWindow(
  modelUsage: ClaudeEvent['modelUsage'],
  sessionModel: string | undefined,
): number | undefined {
  const entries = Object.entries(modelUsage ?? {});
  if (sessionModel !== undefined) {
    const own = entries.find(([model]) => model === sessionModel);
    if (own !== undefined) {
      const window = tokenCount(own[1]?.contextWindow);
      return window !== undefined && window > 0 ? window : undefined;
    }
  }
  // Without a session-model match the only safe entry is an unambiguous one:
  // a lone reporting model. Aux/subagent models must never widen the ceiling.
  if (entries.length === 1) {
    const window = tokenCount(entries[0]?.[1]?.contextWindow);
    return window !== undefined && window > 0 ? window : undefined;
  }
  return undefined;
}
// harn:end context-ceiling-follows-main-model
// harn:end normalized-agent-usage-and-context-telemetry

// harn:assume claude-compaction-follows-native-system-events ref=claude-compaction-translation
function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readCompactionMetadata(event: ClaudeEvent): {
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
} | undefined {
  const candidates = [event.compact_metadata, event.compactMetadata, event.compactionMetadata];
  for (const candidate of candidates) {
    const metadata = objectRecord(candidate);
    if (metadata === undefined) continue;
    const trigger = typeof metadata.trigger === 'string' ? metadata.trigger : undefined;
    const preTokens = tokenCount(metadata.preTokens ?? metadata.pre_tokens);
    const postTokens = tokenCount(metadata.postTokens ?? metadata.post_tokens);
    return { trigger, preTokens, postTokens };
  }
  return undefined;
}
// harn:end claude-compaction-follows-native-system-events

function claudeResultFailure(event: ClaudeEvent): string | undefined {
  const errors = Array.isArray(event.errors)
    ? event.errors.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    : [];
  const result = typeof event.result === 'string' ? event.result : '';
  const nativeFailure = event.is_error === true ||
    (event.subtype !== undefined && event.subtype !== 'success');
  // Exact API-error shape only (trimmed, optional trailing period): a
  // legitimate reply that merely mentions the phrase must never reclassify.
  const legacyOverflow = [...errors, result].find(
    (text) => /^prompt is too long\.?$/i.test(text.trim()),
  );
  if (!nativeFailure && legacyOverflow === undefined) return undefined;
  if (errors.length > 0) return errors.join('\n');
  if (result.trim() !== '') return result;
  return event.subtype !== undefined && event.subtype !== 'success'
    ? `Claude run failed (${event.subtype})`
    : 'Claude run failed';
}

function boundedOutput(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MAX_OUTPUT_BYTES) return value;
  const marker = '\n[output truncated at 256 KiB]';
  const markerBytes = Buffer.byteLength(marker);
  let prefix = Buffer.from(value).subarray(0, MAX_OUTPUT_BYTES - markerBytes).toString('utf8');
  while (Buffer.byteLength(prefix) + markerBytes > MAX_OUTPUT_BYTES) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}`;
}

function lines(value: string): string[] {
  const parts = value.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

function hunk(oldText: string, newText: string): string {
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  const oldStart = oldLines.length === 0 ? 0 : 1;
  const newStart = newLines.length === 0 ? 0 : 1;
  return [
    `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
}

export function diffFromToolUse(
  tool: string,
  input: unknown,
): { path: string; change: 'created' | 'modified'; unified: string } | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  const path = typeof value.file_path === 'string' ? value.file_path : undefined;
  if (path === undefined) return undefined;
  let body: string | undefined;
  let change: 'created' | 'modified' = 'modified';
  if (tool === 'Edit' && typeof value.old_string === 'string' && typeof value.new_string === 'string') {
    body = hunk(value.old_string, value.new_string);
  } else if (tool === 'Write' && typeof value.content === 'string') {
    change = 'created';
    body = hunk('', value.content);
  } else if (tool === 'MultiEdit' && Array.isArray(value.edits)) {
    const hunks = value.edits.flatMap((edit) => {
      if (!edit || typeof edit !== 'object') return [];
      const pair = edit as Record<string, unknown>;
      return typeof pair.old_string === 'string' && typeof pair.new_string === 'string'
        ? [hunk(pair.old_string, pair.new_string)]
        : [];
    });
    if (hunks.length > 0) body = hunks.join('\n');
  }
  if (body === undefined) return undefined;
  return {
    path,
    change,
    unified: `--- ${change === 'created' ? '/dev/null' : `a/${path}`}\n+++ b/${path}\n${body}\n`,
  };
}

const TITLE_MAX = 200;

/** A tool call's title is what the operator reads on the evidence row, so it carries the
 *  tool's actual subject — the command, the file, the pattern, the URL — never the bare
 *  tool name (which rendered as "Explored Read" and command-less shell rows). */
export function toolTitle(tool: string, input: unknown): string {
  const value = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {};
  const str = (key: string): string | undefined =>
    typeof value[key] === 'string' && (value[key] as string).trim() !== '' ? (value[key] as string) : undefined;
  const title = (() => {
    switch (tool) {
      case 'Bash':
      case 'BashOutput':
        return str('command');
      case 'Read':
      case 'NotebookRead':
        return str('file_path') ?? str('notebook_path');
      case 'Edit':
      case 'Write':
      case 'MultiEdit':
      case 'NotebookEdit':
        return str('file_path') ?? str('notebook_path');
      case 'Glob':
      case 'Grep': {
        const pattern = str('pattern');
        const path = str('path');
        return pattern !== undefined && path !== undefined ? `${pattern} in ${path}` : pattern ?? path;
      }
      case 'WebFetch':
        return str('url');
      case 'WebSearch':
        return str('query');
      case 'Task':
        return str('description');
      case 'AskUserQuestion':
        return str('question');
      case 'TodoWrite':
        return 'update task list';
      default:
        return str('command') ?? str('file_path') ?? str('description') ?? str('query');
    }
  })();
  const chosen = title ?? tool;
  return chosen.length > TITLE_MAX ? `${chosen.slice(0, TITLE_MAX - 1)}…` : chosen;
}

export interface ClaudeTurnTranslator {
  push(message: string | object): WireEvent[];
  end(): WireEvent[];
  sessionId(): string | undefined;
}

export interface ClaudeTranslatorContext {
  sessionId?: string;
  sessionModel?: string;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

// harn:assume claude-sdk-message-contract-preserves-normalized-runs ref=claude-sdk-message-translation
export function createTurnTranslator(
  context: ClaudeTranslatorContext = {},
): ClaudeTurnTranslator {
  let sessionId = context.sessionId;
  let terminal = false;
  let contextWindowMaxTokens = context.contextWindowMaxTokens;
  // Only current-turn observations live here. The shared context is the
  // fallback when a terminal object omits a fresh context sample.
  let contextWindowUsedTokens: number | undefined;
  let lastLiveContextKey: string | undefined;
  const tools = new Map<string, { name: string; input: unknown }>();

  let sessionModel = context.sessionModel;

  const seedContextWindow = (model: string | undefined): void => {
    if (model === undefined) return;
    sessionModel = model;
    context.sessionModel = model;
    const seeded = CLAUDE_CONTEXT_WINDOWS.get(model);
    if (seeded !== undefined) {
      contextWindowMaxTokens = seeded;
      context.contextWindowMaxTokens = seeded;
    }
  };

  return {
    sessionId: () => sessionId,

    push(message: string | object): WireEvent[] {
      let event: ClaudeEvent;
      if (typeof message === 'string') {
        if (message.trim() === '') return [];
        try {
          event = JSON.parse(message) as ClaudeEvent;
        } catch {
          return []; // malformed historical fixture line — skip
        }
      } else {
        event = message as ClaudeEvent;
      }
      if (typeof event !== 'object' || event === null || typeof event.type !== 'string') {
        return [];
      }
      if (typeof event.session_id === 'string' && event.session_id !== '') {
        sessionId = event.session_id;
        context.sessionId = event.session_id;
      }
      // harn:assume first-party-run-items-normalized ref=claude-normalized-run-items
      switch (event.type) {
        case 'system': {
          // harn:assume claude-compaction-follows-native-system-events ref=claude-compaction-translation
          if (event.subtype === 'status' && event.status === 'compacting') {
            return [{
              type: 'timeline',
              item: { type: 'compaction', status: 'loading' },
            }];
          }
          if (event.subtype === 'compact_boundary') {
            const metadata = readCompactionMetadata(event);
            // A boundary without post_tokens re-baselines nothing: keep the
            // live used count and emit no usage event, so a previously-good
            // gauge is never clobbered by an incomplete boundary.
            if (metadata?.postTokens !== undefined) {
              contextWindowUsedTokens = metadata.postTokens;
              context.contextWindowUsedTokens = metadata.postTokens;
            }
            const pair = contextWindowMaxTokens !== undefined && contextWindowUsedTokens !== undefined
              ? { contextWindowMaxTokens, contextWindowUsedTokens }
              : undefined;
            if (pair !== undefined) {
              lastLiveContextKey = `${pair.contextWindowMaxTokens}:${pair.contextWindowUsedTokens}`;
            }
            return [
              {
                type: 'timeline',
                item: {
                  type: 'compaction',
                  status: 'completed',
                  trigger: metadata?.trigger === 'manual' ? 'manual' : 'auto',
                  ...(metadata?.preTokens !== undefined && { preTokens: metadata.preTokens }),
                },
              },
              ...(pair !== undefined && metadata?.postTokens !== undefined
                ? [{ type: 'usage_updated', usage: pair } satisfies WireEvent]
                : []),
            ];
          }
          // harn:end claude-compaction-follows-native-system-events
          // init is NOT guaranteed first (user hooks precede it); every other
          // system subtype (hook_started, thinking_tokens, task_*) is noise.
          if (event.subtype === 'init') {
            seedContextWindow(event.model);
          }
          return [];
        }
        case 'assistant': {
          // harn:assume normalized-agent-usage-and-context-telemetry ref=claude-usage-telemetry
          seedContextWindow(event.message?.model);
          const events: WireEvent[] = [];
          for (const block of event.message?.content ?? []) {
            if (typeof block === 'string') continue;
            if (block.type === 'text' && block.text !== undefined && block.text !== '') {
              events.push({ type: 'run.item', item_type: 'text_delta', payload: { text: block.text } });
            } else if (block.type === 'thinking') {
              const text = block.thinking ?? block.text ?? '';
              events.push({ type: 'run.item', item_type: 'reasoning_summary', payload: { text } });
            } else if (block.type === 'tool_use') {
              // Task/Agent tool_use is ENRICHMENT only — hooks own extensions.
              const callId = block.id ?? 'claude-tool';
              const tool = block.name ?? 'tool';
              tools.set(callId, { name: tool, input: block.input });
              events.push({
                type: 'run.item',
                item_type: 'tool_call',
                payload: {
                  call_id: callId,
                  tool,
                  title: toolTitle(tool, block.input),
                  input: block.input,
                },
              });
            }
          }
          const used = contextWindowUsed(event.message?.usage);
          if (used !== undefined) {
            contextWindowUsedTokens = used;
            context.contextWindowUsedTokens = used;
          }
          if (used !== undefined && contextWindowMaxTokens !== undefined) {
            const contextKey = `${contextWindowMaxTokens}:${used}`;
            if (contextKey !== lastLiveContextKey) {
              events.push({
                type: 'usage_updated',
                usage: { contextWindowMaxTokens, contextWindowUsedTokens: used },
              });
              lastLiveContextKey = contextKey;
            }
          }
          // harn:end normalized-agent-usage-and-context-telemetry
          return events;
        }
        case 'user': {
          const events: WireEvent[] = [];
          for (const block of event.message?.content ?? []) {
            if (typeof block === 'string' || block.type !== 'tool_result') continue;
            const callId = block.tool_use_id ?? 'claude-tool';
            const content = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content ?? [];
            const text = content
              .flatMap((item) => item.type === 'text' && item.text !== undefined ? [item.text] : [])
              .join('\n');
            const imageBlock = content.find((item) => item.type === 'image' && item.source?.type === 'base64');
            const mediaType = imageBlock?.source?.media_type;
            const data = imageBlock?.source?.data;
            const imageBytes = data === undefined ? 0 : Buffer.byteLength(data, 'base64');
            const oversizedImage = data !== undefined && imageBytes > MAX_IMAGE_BYTES;
            const imageMarker = oversizedImage
              ? `[image ${mediaType ?? 'application/octet-stream'}, ${imageBytes} bytes, too large to inline]`
              : '';
            const output = [text, imageMarker].filter(Boolean).join('\n');
            const tool = tools.get(callId);
            const diff = tool === undefined ? undefined : diffFromToolUse(tool.name, tool.input);
            events.push({
              type: 'run.item',
              item_type: 'tool_result',
              payload: {
                call_id: callId,
                status: block.is_error === true ? 'error' : 'ok',
                ...(output !== '' && { output_text: boundedOutput(output) }),
                ...(diff !== undefined && { diff: { path: diff.path, unified: diff.unified } }),
                ...(data !== undefined && mediaType !== undefined && !oversizedImage && {
                  image: { media_type: mediaType, data_b64: data },
                }),
                raw: block,
              },
            });
            // The diff-carrying tool_result above is the single canonical row for a
            // file operation; a second file_change event here rendered every edit
            // twice. file_change stays reserved for harnesses whose edits are not
            // tool-paired.
          }
          return events;
        }
        case 'result': {
          terminal = true;
          // harn:assume claude-result-errors-follow-native-signals ref=claude-result-failure-translation
          const failure = claudeResultFailure(event);
          // harn:end claude-result-errors-follow-native-signals
          // harn:assume normalized-agent-usage-and-context-telemetry ref=claude-usage-telemetry
          contextWindowMaxTokens = reportedContextWindow(event.modelUsage, sessionModel) ??
            contextWindowMaxTokens;
          if (contextWindowMaxTokens !== undefined) {
            context.contextWindowMaxTokens = contextWindowMaxTokens;
          }
          contextWindowUsedTokens ??= contextWindowUsed(event.usage);
          if (contextWindowUsedTokens !== undefined) {
            context.contextWindowUsedTokens = contextWindowUsedTokens;
          }
          const snapshotContextUsedTokens = contextWindowUsedTokens
            ?? context.contextWindowUsedTokens;
          const inputTokens = tokenCount(event.usage?.input_tokens);
          const cachedInputTokens = tokenCount(event.usage?.cache_read_input_tokens);
          const outputTokens = tokenCount(event.usage?.output_tokens);
          const totalCostUsd = typeof event.total_cost_usd === 'number' &&
            Number.isFinite(event.total_cost_usd) && event.total_cost_usd >= 0
            ? event.total_cost_usd
            : undefined;
          const agentUsage = {
            ...(inputTokens !== undefined && { inputTokens }),
            ...(cachedInputTokens !== undefined && { cachedInputTokens }),
            ...(outputTokens !== undefined && { outputTokens }),
            ...(totalCostUsd !== undefined && { totalCostUsd }),
            ...(contextWindowMaxTokens !== undefined && snapshotContextUsedTokens !== undefined && {
              contextWindowMaxTokens,
              contextWindowUsedTokens: snapshotContextUsedTokens,
            }),
          };
          // harn:end normalized-agent-usage-and-context-telemetry
          return [
            {
              type: 'run.completed',
              status: failure === undefined ? 'completed' : 'failed',
              ...(failure === undefined
                ? (event.result === undefined ? {} : { final_text: event.result })
                : { error: failure }),
              usage: {
                input_tokens: event.usage?.input_tokens ?? 0,
                output_tokens: event.usage?.output_tokens ?? 0,
                ...(event.total_cost_usd !== undefined && { cost_usd: event.total_cost_usd }),
              },
              ...(Object.keys(agentUsage).length > 0 && { agent_usage: agentUsage }),
            },
          ];
        }
        // harn:assume agent-usage-limits-reported-not-guessed ref=claude-rate-limit-translation
        case 'rate_limit_event': {
          const info = event.rate_limit_info;
          if (!info || typeof info.rateLimitType !== 'string' || typeof info.status !== 'string') {
            return []; // shape we don't recognize — report nothing, never guess
          }
          return [
            {
              type: 'run.limits',
              limits: [
                {
                  window: info.rateLimitType,
                  status: info.status,
                  ...(typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) && {
                    resets_at: new Date(info.resetsAt * 1000).toISOString(),
                  }),
                  ...(typeof info.utilization === 'number' &&
                    info.utilization >= 0 && info.utilization <= 100 && {
                    used_percent: info.utilization,
                  }),
                },
              ],
            },
          ];
        }
        // harn:end agent-usage-limits-reported-not-guessed
        default:
          return []; // unknown event types tolerated
      }
      // harn:end first-party-run-items-normalized
    },

    end(): WireEvent[] {
      if (terminal) return [];
      terminal = true;
      return [{ type: 'run.completed', status: 'interrupted' }];
    },
  };
}
// harn:end claude-sdk-message-contract-preserves-normalized-runs

// ── hook payload mapping (extensions) ───────────────────────────────────

export interface HookPayload {
  hook_event_name?: string;
  agent_id?: string;
  agent_type?: string;
  session_id?: string;
  last_assistant_message?: string;
  transcript_path?: string;
  agent_transcript_path?: string;
}

/**
 * SubagentStart/SubagentStop hook JSON → extension events. Ids here are
 * HARNESS-NATIVE (agent_id / parent session id) — the daemon maps them onto
 * extension members when it observes them.
 */
export function wireEventFromHook(payload: HookPayload): WireEvent | undefined {
  if (payload.agent_id === undefined) return undefined;
  if (payload.hook_event_name === 'SubagentStart') {
    return {
      type: 'extension.started',
      parent: payload.session_id ?? '',
      ext_member: payload.agent_id,
      agent_type: payload.agent_type,
      transcript_path: payload.transcript_path,
    };
  }
  if (payload.hook_event_name === 'SubagentStop') {
    return {
      type: 'extension.ended',
      ext_member: payload.agent_id,
      summary: payload.last_assistant_message,
      transcript_path: payload.agent_transcript_path ?? payload.transcript_path,
    };
  }
  return undefined;
}
