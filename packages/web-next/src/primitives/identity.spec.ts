import { describe, expect, it } from 'vitest';

import {
  compactCount,
  initials,
  memberAccent,
  memberHue,
  memberMarkId,
  memberTone,
  relativeTime,
  usd,
} from './identity.js';

describe('memberAccent', () => {
  it('humans always get the inverse user chip', () => {
    expect(memberAccent({ kind: 'human', handle: 'richard' })).toBe('user');
  });

  it('an agent keeps one stable accent for its handle', () => {
    const first = memberAccent({ kind: 'agent', handle: 'fable' });
    expect(memberAccent({ kind: 'agent', handle: 'fable' })).toBe(first);
    expect(['indigo', 'green', 'violet']).toContain(first);
  });
});

describe('participant service identity', () => {
  it('uses provider defaults while honoring a durable selected hue', () => {
    expect(memberHue({ kind: 'human', handle: 'emanuel' })).toBe(142);
    expect(memberHue({ kind: 'agent', handle: 'claude', harness: 'claude-code' })).toBe(28);
    expect(memberHue({ kind: 'agent', handle: 'codex', harness: 'codex' })).toBe(0);
    expect(memberHue({ kind: 'agent', handle: 'gemini', harness: 'gemini' })).toBe(218);
    expect(memberHue({ kind: 'agent', handle: 'codex', harness: 'codex', color_hue: 308 })).toBe(308);
  });

  it('maps agents to service marks and reserves branded tones for their defaults', () => {
    expect(memberMarkId({ kind: 'agent', harness: 'claude-code' })).toBe('claude-code');
    expect(memberMarkId({ kind: 'agent', harness: 'acp', acp_provider: 'kimi' })).toBe('acp:kimi');
    expect(memberMarkId({ kind: 'human' })).toBeUndefined();
    expect(memberTone({ kind: 'agent', handle: 'codex', harness: 'codex', color_hue: 0 })).toBe('codex');
    expect(memberTone({ kind: 'agent', handle: 'codex', harness: 'codex', color_hue: 308 })).toBe('custom');
  });
});

describe('initials', () => {
  it('takes one letter from each of the first two words', () => {
    expect(initials('code-reviewer')).toBe('cr');
    expect(initials('@code reviewer')).toBe('cr');
  });

  it('falls back to the first two characters of a single word', () => {
    expect(initials('Richard')).toBe('Ri');
    expect(initials('@fable')).toBe('fa');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-07-16T12:00:00Z');

  it('says now under 45 seconds', () => {
    expect(relativeTime('2026-07-16T11:59:30Z', now)).toBe('now');
  });

  it('steps through minutes, hours, and days', () => {
    expect(relativeTime('2026-07-16T11:45:00Z', now)).toBe('15m');
    expect(relativeTime('2026-07-16T07:00:00Z', now)).toBe('5h');
    expect(relativeTime('2026-07-15T09:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-07-13T12:00:00Z', now)).toBe('3d');
  });

  it('returns empty for unparseable timestamps', () => {
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});

describe('meters', () => {
  it('compactCount abbreviates large numbers', () => {
    expect(compactCount(950)).toBe('950');
    expect(compactCount(1_500)).toBe('1.5K');
  });

  it('usd renders two decimals', () => {
    expect(usd(1.234)).toBe('$1.23');
    expect(usd(0)).toBe('$0.00');
  });
});

describe('usd', () => {
  it('keeps sub-cent precision so tiny spend never rounds to zero', () => {
    expect(usd(0.0042)).toBe('$0.0042');
    expect(usd(0.19)).toBe('$0.19');
    expect(usd(0)).toBe('$0.00');
  });
});
