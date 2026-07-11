import type { AskCard, WireEvent } from '@wireroom/protocol';

/**
 * Pure translator: `claude -p` stream-json stdout lines → WireEvents.
 * Wire shapes pinned by the raw fixtures under ../fixtures/ (see NOTES.md).
 */

export interface ControlRequest {
  request_id: string;
  request: {
    subtype: string;
    tool_name?: string;
    input?: Record<string, unknown> & {
      questions?: {
        question: string;
        header?: string;
        options?: { label: string; description?: string }[];
        multiSelect?: boolean;
      }[];
      command?: string;
      description?: string;
    };
    description?: string;
    permission_suggestions?: unknown[];
    tool_use_id?: string;
  };
}

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

interface ClaudeEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  request_id?: string;
  request?: ControlRequest['request'];
  message?: {
    content?: (ClaudeContentBlock | string)[];
  };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

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

export const APPROVAL_OPTIONS = [
  { label: 'allow once' },
  { label: 'allow always' },
  { label: 'deny' },
] as const;

// harn:assume ask-normalization-blocks-run ref=control-request-normalization
/**
 * can_use_tool → exactly one card. AskUserQuestion becomes an `ask` card
 * (prompt/options/multi straight from the tool input); every other tool is a
 * runtime `approval` card (tool + detail + the fixed allow/always/deny
 * options). The card's interaction_id IS the native request_id — but it is
 * only valid within this process lifetime (a re-raise after crash mints
 * fresh ids, so re-correlation is semantic). After emitting the card the CLI
 * goes silent: the turn is BLOCKED until a control_response lands on stdin.
 */
export function cardFromControlRequest(event: ControlRequest): AskCard {
  const request = event.request;
  if (request.tool_name === 'AskUserQuestion') {
    const question = request.input?.questions?.[0];
    return {
      interaction_id: event.request_id,
      kind: 'ask',
      prompt: question?.question ?? '',
      options: question?.options?.map((o) => ({ label: o.label, description: o.description })),
      multi: question?.multiSelect ?? false,
    };
  }
  return {
    interaction_id: event.request_id,
    kind: 'approval',
    prompt: `Allow ${request.tool_name ?? 'tool'}?`,
    options: APPROVAL_OPTIONS.map((o) => ({ ...o })),
    tool: request.tool_name,
    detail:
      request.input?.command ??
      request.description ??
      (request.input ? JSON.stringify(request.input) : undefined),
  };
}
// harn:end ask-normalization-blocks-run

export interface ClaudeTurnTranslator {
  push(line: string): WireEvent[];
  end(): WireEvent[];
  sessionId(): string | undefined;
  /** The full native request for a still-pending interaction id. */
  pendingRequest(interactionId: string): ControlRequest | undefined;
}

export function createTurnTranslator(): ClaudeTurnTranslator {
  let sessionId: string | undefined;
  let terminal = false;
  const pending = new Map<string, ControlRequest>();
  const tools = new Map<string, { name: string; input: unknown }>();

  return {
    sessionId: () => sessionId,
    pendingRequest: (id) => pending.get(id),

    push(line: string): WireEvent[] {
      if (line.trim() === '') return [];
      let event: ClaudeEvent;
      try {
        event = JSON.parse(line) as ClaudeEvent;
      } catch {
        return []; // malformed line — skip
      }
      // harn:assume first-party-run-items-normalized ref=claude-normalized-run-items
      switch (event.type) {
        case 'system':
          // init is NOT guaranteed first (user hooks precede it); every other
          // system subtype (hook_started, thinking_tokens, task_*) is noise.
          if (event.subtype === 'init') sessionId = event.session_id;
          return [];
        case 'assistant': {
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
                  title: tool,
                  input: block.input,
                },
              });
            }
          }
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
            if (diff !== undefined) {
              events.push({
                type: 'run.item',
                item_type: 'file_change',
                payload: {
                  path: diff.path,
                  change: diff.change,
                  diff: { path: diff.path, unified: diff.unified },
                },
              });
            }
          }
          return events;
        }
        case 'control_request': {
          if (event.request?.subtype !== 'can_use_tool' || event.request_id === undefined) {
            return [];
          }
          const request: ControlRequest = { request_id: event.request_id, request: event.request };
          pending.set(event.request_id, request);
          const card = cardFromControlRequest(request);
          return [
            card.kind === 'ask'
              ? { type: 'ask.raised', card }
              : { type: 'approval.raised', card },
          ];
        }
        case 'result': {
          terminal = true;
          return [
            {
              type: 'run.completed',
              status: event.is_error === true ? 'failed' : 'completed',
              final_text: event.result,
              usage: {
                input_tokens: event.usage?.input_tokens ?? 0,
                output_tokens: event.usage?.output_tokens ?? 0,
                ...(event.total_cost_usd !== undefined && { cost_usd: event.total_cost_usd }),
              },
            },
          ];
        }
        default:
          return []; // rate_limit_event etc. tolerated
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
