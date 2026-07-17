import { openSync, readSync, fstatSync, closeSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentUsage, SessionRef } from '@codor/protocol';

// harn:assume context-peek-reads-session-artifacts ref=claude-context-peek
/**
 * Estimate a session's current context from its on-disk transcript WITHOUT
 * running a turn. Reads the tail of ~/.claude/projects/<slug>/<ref>.jsonl:
 * the last assistant usage record (input + cache_read + cache_creation) is
 * the context as of the session's last activity — including activity codor
 * never saw (interactive turns, manual /compact). If a compact summary
 * appears AFTER that record, the true context is roughly the summary itself,
 * so the estimate switches to the summary's size. Returns undefined when the
 * artifact is missing or unreadable — never guesses.
 */

const TAIL_BYTES = 512 * 1024;

interface TailScan {
  usedTokens?: number;
  model?: string;
  compactedAfter: boolean;
  compactApproxTokens: number;
}

function projectsRoot(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
}

function sessionFile(session_ref: SessionRef): string | undefined {
  let projects: string[];
  try {
    projects = readdirSync(projectsRoot());
  } catch {
    return undefined;
  }
  for (const project of projects) {
    const candidate = join(projectsRoot(), project, `${session_ref}.jsonl`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function readTailLines(path: string, bytes: number): string[] | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    // A mid-file start almost certainly bisects a line — drop the partial.
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function scanLines(lines: string[]): TailScan {
  const scan: TailScan = { compactedAfter: false, compactApproxTokens: 0 };
  for (const line of lines) {
    if (line.trim() === '') continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = entry.message as { usage?: Record<string, unknown>; model?: unknown } | undefined;
    if (typeof message?.model === 'string') scan.model = message.model;
    if (entry.type === 'assistant' && message?.usage !== undefined) {
      const usage = message.usage;
      const total = (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) +
        (typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0) +
        (typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0);
      if (total > 0) {
        scan.usedTokens = total;
        scan.compactedAfter = false;
        scan.compactApproxTokens = 0;
      }
    }
    if (entry.isCompactSummary === true) {
      scan.compactedAfter = true;
      scan.compactApproxTokens = Math.ceil(JSON.stringify(entry.message ?? '').length / 4);
    }
  }
  return scan;
}

export function peekClaudeContextUsage(
  session_ref: SessionRef,
  windowForModel: (model: string) => number | undefined,
): AgentUsage | undefined {
  const path = sessionFile(session_ref);
  if (path === undefined) return undefined;
  const lines = readTailLines(path, TAIL_BYTES);
  if (lines === undefined) return undefined;
  const scan = scanLines(lines);
  const usedTokens = scan.compactedAfter
    ? scan.compactApproxTokens
    : scan.usedTokens;
  if (usedTokens === undefined || usedTokens <= 0) return undefined;
  const contextWindowMaxTokens = scan.model === undefined
    ? undefined
    : windowForModel(scan.model);
  if (contextWindowMaxTokens === undefined) return undefined;
  return {
    contextWindowMaxTokens,
    contextWindowUsedTokens: usedTokens,
    estimated: true,
  };
}
// harn:end context-peek-reads-session-artifacts
