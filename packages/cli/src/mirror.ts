import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { MirrorSessionEndFrame, MirrorTurnFrame } from '@wireroom/protocol';

import { findCodexSessionFile } from './detect.js';

export type MirrorFrame = MirrorTurnFrame | MirrorSessionEndFrame;

function expanded(path: string, env: NodeJS.ProcessEnv): string {
  if (path === '~') return env.HOME ?? homedir();
  if (path.startsWith('~/')) return resolve(env.HOME ?? homedir(), path.slice(2));
  return path;
}

function jsonLines(path: string): unknown[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

function claudeTurnId(transcriptPath: string): string | undefined {
  const lines = jsonLines(transcriptPath) as {
    type?: string;
    uuid?: string;
    message?: { id?: string; role?: string };
  }[];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.type === 'assistant' || line.message?.role === 'assistant') {
      return line.uuid ?? line.message?.id;
    }
  }
  return undefined;
}

function codexAssistantText(sessionPath: string): string | undefined {
  const lines = jsonLines(sessionPath) as {
    type?: string;
    payload?: {
      type?: string;
      role?: string;
      message?: string;
      content?: { type?: string; text?: string }[];
    };
  }[];
  for (let i = lines.length - 1; i >= 0; i--) {
    const payload = lines[i]!.payload;
    if (payload?.type === 'agent_message' && payload.message) return payload.message;
    if (payload?.role !== 'assistant') continue;
    const text = payload.content
      ?.filter((item) => item.type === 'output_text' && item.text)
      .map((item) => item.text)
      .join('');
    if (text) return text;
  }
  return undefined;
}

export function parseMirrorHook(
  source: 'claude' | 'codex',
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): MirrorFrame {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  if (source === 'claude') {
    const event = String(payload.hook_event_name ?? '');
    const sessionRef = String(payload.session_id ?? '');
    if (!sessionRef) throw new Error('Claude hook payload has no session_id');
    if (event === 'SessionEnd') {
      return { type: 'mirror_session_end', harness: 'claude-code', session_ref: sessionRef };
    }
    if (event !== 'Stop') throw new Error(`unsupported Claude hook event '${event}'`);
    const transcriptPath = expanded(String(payload.transcript_path ?? ''), env);
    const nativeTurnId = claudeTurnId(transcriptPath);
    if (!nativeTurnId) throw new Error('Claude Stop transcript has no native assistant turn id');
    return {
      type: 'mirror_turn',
      harness: 'claude-code',
      session_ref: sessionRef,
      native_turn_id: nativeTurnId,
      body: String(payload.last_assistant_message ?? ''),
      transcript_path: transcriptPath,
    };
  }

  if (payload.type !== 'agent-turn-complete') {
    throw new Error(`unsupported Codex notification '${String(payload.type ?? '')}'`);
  }
  const sessionRef = String(payload['thread-id'] ?? '');
  const nativeTurnId = String(payload['turn-id'] ?? '');
  if (!sessionRef || !nativeTurnId) throw new Error('Codex notification is missing thread-id or turn-id');
  const transcriptPath = findCodexSessionFile(sessionRef, env);
  return {
    type: 'mirror_turn',
    harness: 'codex',
    session_ref: sessionRef,
    native_turn_id: nativeTurnId,
    body:
      (transcriptPath ? codexAssistantText(transcriptPath) : undefined) ??
      String(payload['last-assistant-message'] ?? ''),
    ...(transcriptPath !== undefined && { transcript_path: transcriptPath }),
  };
}
