import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_USAGE_URL,
  probeClaudeLimits,
  type LimitsProbeFetcher,
} from './limits-probe.js';

const dirs: string[] = [];

function credentials(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-claude-limits-'));
  dirs.push(dir);
  const path = join(dir, '.credentials.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Claude usage limits probe', () => {
  it('uses the CLI OAuth credential and maps provider windows without inventing status', async () => {
    const calls: Parameters<LimitsProbeFetcher>[] = [];
    const fetcher: LimitsProbeFetcher = async (...args) => {
      calls.push(args);
      return {
        ok: true,
        json: async () => ({
          five_hour: { utilization: 23.5, resets_at: '2026-07-17T12:00:00.000Z' },
          seven_day: { utilization: 81, resets_at: null },
        }),
      };
    };

    await expect(probeClaudeLimits({
      credentialsPath: credentials({ claudeAiOauth: { accessToken: 'claude-secret' } }),
      fetcher,
    })).resolves.toEqual([
      { window: 'five_hour', used_percent: 23.5, resets_at: '2026-07-17T12:00:00.000Z' },
      { window: 'seven_day', used_percent: 81 },
    ]);
    expect(calls).toEqual([[
      CLAUDE_USAGE_URL,
      {
        method: 'GET',
        headers: {
          Authorization: 'Bearer claude-secret',
          'anthropic-beta': 'oauth-2025-04-20',
        },
      },
    ]]);
  });

  it('ignores null windows and silently skips missing credentials', async () => {
    const fetcher = vi.fn<LimitsProbeFetcher>(async () => ({
      ok: true,
      json: async () => ({ five_hour: null, seven_day: null }),
    }));
    await expect(probeClaudeLimits({
      credentialsPath: credentials({ claudeAiOauth: { accessToken: 'token' } }),
      fetcher,
    })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();

    fetcher.mockClear();
    await expect(probeClaudeLimits({
      credentialsPath: credentials({ claudeAiOauth: {} }),
      fetcher,
    })).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
