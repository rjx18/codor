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

interface ClaudeEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  request_id?: string;
  request?: ControlRequest['request'];
  message?: {
    content?: ({ type: string; text?: string; name?: string; id?: string; input?: unknown } | string)[];
  };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
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
              events.push({ type: 'run.item', item_type: 'text_delta', payload: block.text });
            } else if (block.type === 'tool_use') {
              // Task/Agent tool_use is ENRICHMENT only — hooks own extensions.
              events.push({
                type: 'run.item',
                item_type: 'tool_call',
                payload: { tool: block.name, id: block.id, input: block.input },
              });
            }
          }
          return events;
        }
        case 'user':
          return [{ type: 'run.item', item_type: 'tool_result', payload: event.message ?? {} }];
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
