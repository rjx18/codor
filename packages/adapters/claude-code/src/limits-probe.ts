import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentLimit } from '@codor/protocol';

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export interface LimitsProbeResponse {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
}

export type LimitsProbeFetcher = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<LimitsProbeResponse>;

export interface ClaudeLimitsProbeOptions {
  credentialsPath?: string;
  fetcher?: LimitsProbeFetcher;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

async function accessToken(path: string): Promise<string | undefined> {
  try {
    const credentials = record(JSON.parse(await readFile(path, 'utf8')));
    const oauth = record(credentials?.claudeAiOauth);
    const value = oauth?.accessToken ?? credentials?.access_token;
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

function resetTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

function mapWindow(window: 'five_hour' | 'seven_day', value: unknown): AgentLimit | undefined {
  const source = record(value);
  if (!source) return undefined;
  const used = typeof source.utilization === 'number'
    && Number.isFinite(source.utilization)
    && source.utilization >= 0
    && source.utilization <= 100
    ? source.utilization
    : undefined;
  const resetsAt = resetTimestamp(source.resets_at);
  if (used === undefined && resetsAt === undefined) return undefined;
  return {
    window,
    ...(used !== undefined && { used_percent: used }),
    ...(resetsAt !== undefined && { resets_at: resetsAt }),
  };
}

/** Reads Claude Code's own OAuth credential and asks only Anthropic for usage. */
export async function probeClaudeLimits(
  options: ClaudeLimitsProbeOptions = {},
): Promise<AgentLimit[] | undefined> {
  const credentialsPath = options.credentialsPath
    ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json');
  const token = await accessToken(credentialsPath);
  if (token === undefined) return undefined;
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const response = await fetcher(CLAUDE_USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (!response.ok) throw new Error(`Claude usage probe failed (${String(response.status ?? 'unknown')})`);
  const payload = record(await response.json());
  const limits = [
    mapWindow('five_hour', payload?.five_hour),
    mapWindow('seven_day', payload?.seven_day),
  ].filter((limit): limit is AgentLimit => limit !== undefined);
  return limits.length > 0 ? limits : undefined;
}
