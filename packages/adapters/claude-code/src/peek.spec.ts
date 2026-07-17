import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { peekClaudeContextUsage } from './peek.js';
import { claudeContextWindow } from './translate.js';

// harn:assume context-peek-reads-session-artifacts ref=claude-context-peek-regression
describe('peekClaudeContextUsage', () => {
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codor-peek-'));
    mkdirSync(join(configDir, 'projects', '-scratch-project'), { recursive: true });
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  const install = (fixture: string, ref: string): void => {
    cpSync(
      new URL(`../test-fixtures/${fixture}`, import.meta.url).pathname,
      join(configDir, 'projects', '-scratch-project', `${ref}.jsonl`),
    );
  };

  it('estimates the last reported context against the curated window', () => {
    install('peek-session.jsonl', 'ref-plain');
    expect(peekClaudeContextUsage('ref-plain', claudeContextWindow)).toEqual({
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 150_000,
      estimated: true,
    });
  });

  it('ignores synthetic model markers so the real model still resolves the window', () => {
    // The compacted fixture ends with a "<synthetic>" assistant entry, exactly
    // like fable's real post-incident transcript. The window must still come
    // from claude-fable-5, not fail to resolve.
    install('peek-session-compacted.jsonl', 'ref-synthetic');
    expect(peekClaudeContextUsage('ref-synthetic', claudeContextWindow)).toMatchObject({
      contextWindowMaxTokens: 1_000_000,
      estimated: true,
    });
  });

  it('switches to the compact-summary estimate when compaction follows the last usage', () => {
    install('peek-session-compacted.jsonl', 'ref-compacted');
    const peeked = peekClaudeContextUsage('ref-compacted', claudeContextWindow);
    expect(peeked).toMatchObject({ contextWindowMaxTokens: 1_000_000, estimated: true });
    // The truth is the summary (~a few hundred tokens), never the stale 986k.
    expect(peeked!.contextWindowUsedTokens).toBeLessThan(2_000);
    expect(peeked!.contextWindowUsedTokens).toBeGreaterThan(100);
  });

  it('returns undefined for an unknown session instead of guessing', () => {
    expect(peekClaudeContextUsage('no-such-ref', claudeContextWindow)).toBeUndefined();
  });
});
// harn:end context-peek-reads-session-artifacts
