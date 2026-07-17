import { openSync, readSync, fstatSync, closeSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentUsage, SessionRef } from '@codor/protocol';

// harn:assume context-peek-reads-session-artifacts ref=codex-context-peek
/**
 * Estimate a codex thread's current context WITHOUT running a turn. Locates
 * the rollout file for the thread id under CODEX_HOME/sessions/YYYY/MM/DD/
 * and reads the tail for the last token_count event:
 * info.last_token_usage.total_tokens is the context as of the thread's last
 * activity and info.model_context_window is the engine-reported ceiling —
 * both survive activity codor never saw. Returns undefined when artifacts
 * are missing or unreadable — never guesses.
 */

const TAIL_BYTES = 256 * 1024;

function sessionsRoot(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
}

function rolloutFile(session_ref: SessionRef): string | undefined {
  const root = sessionsRoot();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.endsWith(`${session_ref}.jsonl`)) return path;
    }
  }
  return undefined;
}

function readTail(path: string): string[] | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function peekCodexContextUsage(session_ref: SessionRef): AgentUsage | undefined {
  const path = rolloutFile(session_ref);
  if (path === undefined) return undefined;
  const lines = readTail(path);
  if (lines === undefined) return undefined;
  let used: number | undefined;
  let max: number | undefined;
  for (const line of lines) {
    if (!line.includes('"token_count"')) continue;
    let entry: { payload?: { type?: string; info?: {
      last_token_usage?: { total_tokens?: unknown };
      model_context_window?: unknown;
    } } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.payload?.type !== 'token_count') continue;
    const info = entry.payload.info;
    used = positiveInt(info?.last_token_usage?.total_tokens) ?? used;
    max = positiveInt(info?.model_context_window) ?? max;
  }
  if (used === undefined || max === undefined) return undefined;
  return { contextWindowMaxTokens: max, contextWindowUsedTokens: used, estimated: true };
}
// harn:end context-peek-reads-session-artifacts
