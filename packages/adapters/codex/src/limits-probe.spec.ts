import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODEX_USAGE_URL,
  probeCodexLimits,
  type LimitsProbeFetcher,
} from './limits-probe.js';

const dirs: string[] = [];

function credentials(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-codex-limits-'));
  dirs.push(dir);
  const path = join(dir, 'auth.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Codex usage limits probe', () => {
  it('uses the CLI token and account headers and maps the 5h/weekly windows', async () => {
    const calls: Parameters<LimitsProbeFetcher>[] = [];
    const fetcher: LimitsProbeFetcher = async (...args) => {
      calls.push(args);
      return {
        ok: true,
        json: async () => ({
          // The LIVE envelope (verified against the real endpoint 2026-07-17):
          // windows nest under rate_limit, singular.
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 12,
              limit_window_seconds: 18_000,
              reset_after_seconds: 1_246,
              reset_at: 1_784_294_400,
            },
            secondary_window: {
              used_percent: 44.5,
              limit_window_seconds: 604_800,
              reset_after_seconds: 496_946,
              reset_at: null,
            },
          },
        }),
      };
    };

    await expect(probeCodexLimits({
      credentialsPath: credentials({
        tokens: { access_token: 'codex-secret', account_id: 'account-123' },
      }),
      fetcher,
    })).resolves.toEqual([
      { window: 'five_hour', used_percent: 12, resets_at: '2026-07-17T13:20:00.000Z' },
      { window: 'seven_day', used_percent: 44.5 },
    ]);
    expect(calls).toEqual([[
      CODEX_USAGE_URL,
      {
        method: 'GET',
        headers: {
          Authorization: 'Bearer codex-secret',
          'ChatGPT-Account-Id': 'account-123',
        },
      },
    ]]);
  });

  it('keeps unknown lengths as minute windows and ignores null/missing credentials', async () => {
    const fetcher = vi.fn<LimitsProbeFetcher>(async () => ({
      ok: true,
      json: async () => ({
        rate_limits: {
          primary_window: null,
          secondary_window: {
            used_percent: 7,
            limit_window_seconds: 5_400,
            reset_at: null,
          },
        },
      }),
    }));
    await expect(probeCodexLimits({
      credentialsPath: credentials({ tokens: { access_token: 'token', account_id: 'account' } }),
      fetcher,
    })).resolves.toEqual([{ window: '90_minute', used_percent: 7 }]);

    fetcher.mockClear();
    await expect(probeCodexLimits({
      credentialsPath: credentials({ tokens: { access_token: 'token' } }),
      fetcher,
    })).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
