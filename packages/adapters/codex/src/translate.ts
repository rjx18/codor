import type { WireEvent } from '@wireroom/protocol';

/**
 * Pure translator: `codex exec --json` stdout lines → normalized WireEvents.
 * The event vocabulary is pinned by the raw fixtures under ../fixtures/
 * (see NOTES.md) — success, resume, refused-write, interrupt, kill, failure.
 */

interface CodexItem {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  message?: string;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string };
  message?: string;
  item?: CodexItem;
}

export interface TurnTranslator {
  /** Feed one stdout line; returns the WireEvents it produced (often none). */
  push(line: string): WireEvent[];
  /** Signal stream EOF; synthesizes the terminal event if none was seen. */
  end(fallback?: { status: 'failed' | 'interrupted'; final_text?: string }): WireEvent[];
  /** thread_id from thread.started — the session_ref/resume token. */
  threadId(): string | undefined;
}

/**
 * One translator per turn. Codex quirks handled here (all fixture-pinned):
 * - a turn can carry SEVERAL agent_message items; the LAST one is final_text;
 * - command_execution items surface only when the model uses the plain shell
 *   tool — unified-exec runs are invisible, so tool visibility is best-effort;
 * - SIGINT/kill truncate the stream with no terminal event: EOF without
 *   turn.completed/turn.failed synthesizes status 'interrupted';
 * - unparseable lines are skipped (never fatal).
 */
export function createTurnTranslator(): TurnTranslator {
  let threadId: string | undefined;
  let lastAgentText: string | undefined;
  let streamError: string | undefined;
  let terminal = false;

  const finalText = (): string | undefined => lastAgentText ?? streamError;

  return {
    threadId: () => threadId,

    push(line: string): WireEvent[] {
      if (line.trim() === '') return [];
      let event: CodexEvent;
      try {
        event = JSON.parse(line) as CodexEvent;
      } catch {
        return []; // malformed line — skip, never fatal
      }
      switch (event.type) {
        case 'thread.started':
          threadId = event.thread_id;
          return [];
        case 'turn.started':
          return [];
        case 'item.started':
        case 'item.completed': {
          const item = event.item;
          if (!item) return [];
          if (item.type === 'agent_message') {
            if (event.type !== 'item.completed') return [];
            lastAgentText = item.text ?? '';
            return [
              { type: 'run.item', item_type: 'text_delta', payload: item.text ?? '' },
            ];
          }
          if (item.type === 'command_execution') {
            return [
              event.type === 'item.started'
                ? {
                    type: 'run.item',
                    item_type: 'tool_call',
                    payload: { command: item.command, status: item.status },
                  }
                : {
                    type: 'run.item',
                    item_type: 'tool_result',
                    payload: {
                      command: item.command,
                      exit_code: item.exit_code,
                      aggregated_output: item.aggregated_output,
                      status: item.status,
                    },
                  },
            ];
          }
          if (item.type === 'error') {
            return [
              {
                type: 'run.item',
                item_type: 'tool_result',
                payload: { kind: 'error', message: item.message },
              },
            ];
          }
          return []; // unknown item types tolerated
        }
        // harn:assume codex-usage-tokens-only ref=usage-token-mapping
        // turn.completed usage is TOKENS ONLY — codex reports no dollar cost
        // and none may ever be fabricated (meters count $ only from
        // cost-reporting harnesses).
        case 'turn.completed': {
          terminal = true;
          return [
            {
              type: 'run.completed',
              status: 'completed',
              final_text: finalText(),
              usage: {
                input_tokens: event.usage?.input_tokens ?? 0,
                output_tokens: event.usage?.output_tokens ?? 0,
              },
            },
          ];
        }
        // harn:end codex-usage-tokens-only
        case 'turn.failed': {
          terminal = true;
          return [
            {
              type: 'run.completed',
              status: 'failed',
              final_text: event.error?.message ?? finalText(),
            },
          ];
        }
        case 'error':
          streamError = event.message;
          return [];
        default:
          return []; // unknown event types tolerated
      }
    },

    end(fallback = { status: 'interrupted' as const }): WireEvent[] {
      if (terminal) return [];
      terminal = true;
      return [
        {
          type: 'run.completed',
          status: fallback.status,
          final_text: fallback.final_text ?? finalText(),
        },
      ];
    },
  };
}
