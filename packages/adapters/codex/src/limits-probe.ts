import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentLimit } from '@codor/protocol';

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export interface LimitsProbeResponse {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
}

export type LimitsProbeFetcher = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<LimitsProbeResponse>;

export interface CodexLimitsProbeOptions {
  credentialsPath?: string;
  fetcher?: LimitsProbeFetcher;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

async function credentials(
  path: string,
): Promise<{ accessToken: string; accountId: string } | undefined> {
  try {
    const auth = record(JSON.parse(await readFile(path, 'utf8')));
    const tokens = record(auth?.tokens);
    const accessToken = tokens?.access_token ?? auth?.access_token;
    const accountId = tokens?.account_id ?? auth?.account_id;
    return typeof accessToken === 'string' && accessToken !== ''
      && typeof accountId === 'string' && accountId !== ''
      ? { accessToken, accountId }
      : undefined;
  } catch {
    return undefined;
  }
}

function resetTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return new Date(value * 1000).toISOString();
  }
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

function windowName(seconds: number): string {
  if (seconds === 5 * 60 * 60) return 'five_hour';
  if (seconds === 7 * 24 * 60 * 60) return 'seven_day';
  return `${String(Math.round(seconds / 60))}_minute`;
}

function mapWindow(value: unknown): AgentLimit | undefined {
  const source = record(value);
  if (!source) return undefined;
  const seconds = source.limit_window_seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const used = typeof source.used_percent === 'number'
    && Number.isFinite(source.used_percent)
    && source.used_percent >= 0
    && source.used_percent <= 100
    ? source.used_percent
    : undefined;
  const resetsAt = resetTimestamp(source.reset_at);
  if (used === undefined && resetsAt === undefined) return undefined;
  return {
    window: windowName(seconds),
    ...(used !== undefined && { used_percent: used }),
    ...(resetsAt !== undefined && { resets_at: resetsAt }),
  };
}

/** Reads Codex's own auth file and asks only ChatGPT's usage endpoint. */
export async function probeCodexLimits(
  options: CodexLimitsProbeOptions = {},
): Promise<AgentLimit[] | undefined> {
  const credentialsPath = options.credentialsPath
    ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  const credential = await credentials(credentialsPath);
  if (credential === undefined) return undefined;
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const response = await fetcher(CODEX_USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      'ChatGPT-Account-Id': credential.accountId,
    },
  });
  if (!response.ok) throw new Error(`Codex usage probe failed (${String(response.status ?? 'unknown')})`);
  const payload = record(await response.json());
  // The live endpoint nests windows under rate_limit (singular, verified
  // 2026-07-17); older shapes used rate_limits — accept both.
  const rateLimits = record(payload?.rate_limit) ?? record(payload?.rate_limits);
  const limits = [
    mapWindow(rateLimits?.primary_window),
    mapWindow(rateLimits?.secondary_window),
  ].filter((limit): limit is AgentLimit => limit !== undefined);
  return limits.length > 0 ? limits : undefined;
}
