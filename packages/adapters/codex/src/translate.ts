import type { WireEvent } from '@codor/protocol';

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
      // harn:assume first-party-run-items-normalized ref=codex-normalized-run-items
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
              { type: 'run.item', item_type: 'text_delta', payload: { text: item.text ?? '' } },
            ];
          }
          if (item.type === 'command_execution') {
            return [
              event.type === 'item.started'
                ? {
                    type: 'run.item',
                    item_type: 'tool_call',
                    payload: {
                      call_id: item.id,
                      tool: 'Bash',
                      title: item.command ?? 'Shell command',
                      input: { command: item.command },
                    },
                  }
                : {
                    type: 'run.item',
                    item_type: 'tool_result',
                    payload: {
                      call_id: item.id,
                      status: item.exit_code === 0 && item.status !== 'failed' ? 'ok' : 'error',
                      output_text: boundedOutput(item.aggregated_output),
                      raw: item,
                    },
                  },
            ];
          }
          if (item.type === 'error') {
            return [
              {
                type: 'run.item',
                item_type: 'tool_result',
                payload: {
                  call_id: item.id || 'codex-error',
                  status: 'error',
                  output_text: boundedOutput(item.message),
                  raw: item,
                },
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
      // harn:end first-party-run-items-normalized
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
