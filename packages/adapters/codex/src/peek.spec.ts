import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { peekCodexContextUsage } from './peek.js';

// harn:assume context-peek-reads-session-artifacts ref=codex-context-peek-regression
describe('peekCodexContextUsage', () => {
  let codexHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'codor-codex-peek-'));
    mkdirSync(join(codexHome, 'sessions', '2026', '07', '17'), { recursive: true });
    previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('takes the last token_count record as the estimated context pair', () => {
    cpSync(
      fileURLToPath(new URL('./test-fixtures/peek-rollout.jsonl', import.meta.url)),
      join(codexHome, 'sessions', '2026', '07', '17', 'rollout-2026-07-17T10-00-00-abc123.jsonl'),
    );
    expect(peekCodexContextUsage('abc123')).toEqual({
      contextWindowMaxTokens: 258_400,
      contextWindowUsedTokens: 197_226,
      estimated: true,
    });
  });

  it('returns undefined for an unknown thread instead of guessing', () => {
    expect(peekCodexContextUsage('missing-thread')).toBeUndefined();
  });
});
// harn:end context-peek-reads-session-artifacts
