import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface DetectedSession {
  harness: 'claude-code' | 'codex';
  session_ref: string;
  cwd: string;
  transcript_path: string;
}

interface Candidate extends DetectedSession {
  mtimeMs: number;
}

const CODEX_FILE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const CLAUDE_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

function filesBelow(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  return files;
}

export function findCodexSessionFile(
  sessionRef: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const root = join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'), 'sessions');
  return filesBelow(root).find((path) => CODEX_FILE.exec(basename(path))?.[1] === sessionRef);
}

export function detectSession(options: {
  harness?: string;
  session?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): DetectedSession {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicitHarness =
    options.harness === 'claude' ? 'claude-code' : options.harness;
  const envClaude = env.CLAUDE_SESSION_ID;
  const envCodex = env.CODEX_THREAD_ID ?? env.CODEX_SESSION_ID;
  if (options.session) {
    const harness = explicitHarness ?? (envClaude === options.session ? 'claude-code' : 'codex');
    if (harness !== 'claude-code' && harness !== 'codex') {
      throw new Error(`unsupported harness '${harness}'`);
    }
    return {
      harness,
      session_ref: options.session,
      cwd,
      transcript_path:
        harness === 'codex' ? (findCodexSessionFile(options.session, env) ?? '') : '',
    };
  }
  if (!explicitHarness && envClaude) {
    return { harness: 'claude-code', session_ref: envClaude, cwd, transcript_path: '' };
  }
  if (!explicitHarness && envCodex) {
    return {
      harness: 'codex',
      session_ref: envCodex,
      cwd,
      transcript_path: findCodexSessionFile(envCodex, env) ?? '',
    };
  }

  const home = env.HOME ?? homedir();
  const candidates: Candidate[] = [];
  if (explicitHarness === undefined || explicitHarness === 'claude-code') {
    const root = join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects');
    for (const path of filesBelow(root)) {
      const match = CLAUDE_FILE.exec(basename(path));
      if (!match) continue;
      candidates.push({
        harness: 'claude-code',
        session_ref: match[1]!,
        cwd,
        transcript_path: path,
        mtimeMs: statSync(path).mtimeMs,
      });
    }
  }
  if (explicitHarness === undefined || explicitHarness === 'codex') {
    const root = join(env.CODEX_HOME ?? join(home, '.codex'), 'sessions');
    for (const path of filesBelow(root)) {
      const match = CODEX_FILE.exec(basename(path));
      if (!match) continue;
      candidates.push({
        harness: 'codex',
        session_ref: match[1]!,
        cwd,
        transcript_path: path,
        mtimeMs: statSync(path).mtimeMs,
      });
    }
  }
  const latest = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!latest) {
    throw new Error('could not autodetect a live Claude Code or Codex session; pass --harness and --session');
  }
  const { mtimeMs: _mtimeMs, ...detected } = latest;
  return detected;
}
