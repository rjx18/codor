import type { Member, Room } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POLICY,
  POLICIES,
  type AdapterLike,
  availableAgentHandle,
  buildSpawnSpec,
  collidesWithOwner,
  defaultSpawnCwd,
  effectiveHarness,
  reconcileConfig,
  supportedThinking,
  thinkingLevelsFor,
} from './agent-spec.js';

/**
 * The Tier-1 acceptance table. Each case is a defect that shipped, not a
 * hypothetical: the dialogs omitted a policy, made the operator retype the
 * project path on every spawn, submitted thinking levels the harness rejects,
 * and closed silently on failure.
 */

const agent = (over: Partial<Member> = {}): Member => ({
  id: over.id ?? 'm1',
  kind: 'agent',
  handle: 'alpha',
  display_name: 'alpha',
  ...over,
}) as Member;

const room = (over: Record<string, unknown> = {}): Room => ({
  id: 'r', name: 'r', config: { ...over },
}) as unknown as Room;

const claude: AdapterLike = {
  id: 'claude-code',
  capabilities: { thinking: true, thinking_levels: ['low', 'medium', 'high', 'xhigh'] },
  models: ['sonnet', 'opus'],
};
const plain: AdapterLike = { id: 'codex', capabilities: { thinking: false } };
const undeclared: AdapterLike = { id: 'gemini', capabilities: { thinking: true } };

const config = (over: Partial<Parameters<typeof buildSpawnSpec>[0]['config']> = {}) => ({
  harness: 'claude-code', model: '', thinking: '', policy: '' as const, ...over,
});

describe('policy is never omitted (Tier-1 #1)', () => {
  it('defaults to read-only when the operator picks nothing', () => {
    const spec = buildSpawnSpec({
      config: config(), handle: 'scout', cwd: '/p', adapters: [claude], members: [],
    });
    // Omitting policy lets the harness choose its own authority. Legacy marks this
    // exact regression as F11; web-next reintroduced it.
    expect(spec.policy).toBe(DEFAULT_POLICY);
    expect(spec.policy).toBe('read-only');
  });

  it('keeps an explicit choice', () => {
    const spec = buildSpawnSpec({
      config: config({ policy: 'full-access' }), handle: 'scout', cwd: '/p',
      adapters: [claude], members: [],
    });
    expect(spec.policy).toBe('full-access');
  });

  it('sources the policy list from the protocol, not a UI literal', () => {
    expect([...POLICIES]).toEqual(['read-only', 'workspace-write', 'full-access']);
  });
});

describe('cwd is inherited, not retyped (Tier-1 #2)', () => {
  it('prefers the room directory', () => {
    expect(defaultSpawnCwd(room({ cwd: '/srv/app' }), [agent({ cwd: '/other' })])).toBe('/srv/app');
  });

  it('falls back to the starting agent', () => {
    const members = [agent({ id: 'b', handle: 'beta', cwd: '/b' }), agent({ id: 'a', handle: 'alpha', cwd: '/a' })];
    expect(defaultSpawnCwd(room({ starting_agent_handle: 'beta' }), members)).toBe('/b');
  });

  it('falls back to the first live local agent by id', () => {
    const members = [agent({ id: 'b', cwd: '/b' }), agent({ id: 'a', cwd: '/a' })];
    expect(defaultSpawnCwd(room(), members)).toBe('/a');
  });

  it.each<[string, Partial<Member>]>([
    ['dead', { state: 'dead' }],
    ['unreachable', { state: 'unreachable' }],
    ['mirrored', { custody: 'mirrored' }],
    ['removed', { removed_ts: '2026-01-01T00:00:00.000Z' }],
  ])('never inherits from a %s agent', (_label, over) => {
    // Inheriting a dead agent's directory silently spawns into a stale worktree.
    const members = [agent({ id: 'a', cwd: '/stale', ...over }), agent({ id: 'b', cwd: '/live' })];
    expect(defaultSpawnCwd(room(), members)).toBe('/live');
  });

  it('ignores a relative room cwd rather than sending it', () => {
    expect(defaultSpawnCwd(room({ cwd: 'relative/path' }), [])).toBe('');
  });
});

describe('harness change reconciles the rest (Tier-1 #3)', () => {
  it('clears a thinking level the new harness does not accept', () => {
    const next = reconcileConfig(config({ thinking: 'xhigh' }), 'codex', [claude, plain]);
    expect(next.thinking).toBe('');
  });

  it('keeps a level the new harness does accept', () => {
    const start = { harness: 'gemini', model: '', thinking: 'low', policy: '' as const };
    expect(reconcileConfig(start, 'claude-code', [claude, undeclared]).thinking).toBe('low');
  });

  it('clears the model, whose ids are harness-specific', () => {
    expect(reconcileConfig(config({ model: 'opus' }), 'codex', [claude, plain]).model).toBe('');
  });

  it('is a no-op when the same harness is re-selected, so a typed model survives', () => {
    const same = config({ model: 'my-custom-model' });
    expect(reconcileConfig(same, 'claude-code', [claude]).model).toBe('my-custom-model');
  });
});

describe('thinking is only sent where it is supported (Tier-1 #4, #9)', () => {
  it('omits thinking entirely for a harness that does not support it', () => {
    const spec = buildSpawnSpec({
      config: { harness: 'codex', model: '', thinking: 'high', policy: '' },
      handle: 'scout', cwd: '/p', adapters: [plain], members: [],
    });
    expect(spec.thinking).toBeUndefined();
  });

  it('omits a level the adapter does not declare', () => {
    const spec = buildSpawnSpec({
      config: config({ thinking: 'ultracode' }), handle: 'scout', cwd: '/p',
      adapters: [claude], members: [],
    });
    expect(spec.thinking).toBeUndefined();
  });

  it('sends a declared level', () => {
    const spec = buildSpawnSpec({
      config: config({ thinking: 'xhigh' }), handle: 'scout', cwd: '/p',
      adapters: [claude], members: [],
    });
    expect(spec.thinking).toBe('xhigh');
  });

  it('offers the adapter list, the protocol default, or nothing — never a UI literal', () => {
    // The dialog inlined seven levels while the protocol default is three.
    expect(thinkingLevelsFor(claude)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(thinkingLevelsFor(undeclared)).toEqual(['low', 'medium', 'high']);
    expect(thinkingLevelsFor(plain)).toEqual([]);
    expect(thinkingLevelsFor(undefined)).toEqual([]);
  });
});

describe('one rule decides an acceptable thinking level (Tier-1 #4)', () => {
  it('returns the level only when the adapter declares it', () => {
    expect(supportedThinking(claude, 'xhigh')).toBe('xhigh');
    expect(supportedThinking(claude, 'ultracode')).toBeUndefined();
    expect(supportedThinking(plain, 'low')).toBeUndefined();
    expect(supportedThinking(undeclared, 'high')).toBe('high');
    expect(supportedThinking(claude, '')).toBeUndefined();
  });
});

describe('handles are made unique (Tier-1 #6, #7)', () => {
  it('suffixes on collision', () => {
    expect(availableAgentHandle('scout', [agent({ handle: 'scout' })])).toBe('scout-2');
  });

  it('walks past consecutive collisions', () => {
    const taken = [agent({ id: '1', handle: 'scout' }), agent({ id: '2', handle: 'scout-2' })];
    expect(availableAgentHandle('scout', taken)).toBe('scout-3');
  });

  it('truncates the base before the suffix, so a 31-char handle still fits', () => {
    const base = 'a'.repeat(31);
    const taken = [agent({ id: '1', handle: base }), agent({ id: '2', handle: `${'a'.repeat(29)}-2` })];
    const out = availableAgentHandle(base, taken);
    expect(out.length).toBeLessThanOrEqual(31);
    expect(out).toBe(`${'a'.repeat(29)}-3`);
  });

  it('ignores removed members when deciding what is taken', () => {
    const gone = agent({ handle: 'scout', removed_ts: '2026-01-01T00:00:00.000Z' });
    expect(availableAgentHandle('scout', [gone])).toBe('scout');
  });

  it('detects a collision with the channel owner', () => {
    expect(collidesWithOwner('richard', { handle: 'richard' })).toBe(true);
    expect(collidesWithOwner('scout', { handle: 'richard' })).toBe(false);
    expect(collidesWithOwner('scout', undefined)).toBe(false);
  });

  it('applies uniqueness to the built payload', () => {
    const spec = buildSpawnSpec({
      config: config(), handle: 'scout', cwd: '/p', adapters: [claude],
      members: [agent({ handle: 'scout' })],
    });
    expect(spec.handle).toBe('scout-2');
  });
});

describe('harness selection heals as adapters arrive (Tier-1 #8)', () => {
  it('is empty while discovery is pending', () => {
    expect(effectiveHarness('', [])).toBe('');
  });

  it('adopts the first adapter once the list lands', () => {
    expect(effectiveHarness('', [claude, plain])).toBe('claude-code');
  });

  it('keeps a real selection', () => {
    expect(effectiveHarness('codex', [claude, plain])).toBe('codex');
  });

  it('heals a selection naming an adapter that has gone away', () => {
    expect(effectiveHarness('retired', [claude])).toBe('claude-code');
  });
});

describe('payload hygiene', () => {
  it('trims handle, cwd and purpose, and drops an empty purpose', () => {
    const spec = buildSpawnSpec({
      config: config(), handle: '  scout  ', cwd: '  /p  ', purpose: '   ',
      adapters: [claude], members: [],
    });
    expect(spec).toMatchObject({ handle: 'scout', cwd: '/p' });
    expect(spec.purpose).toBeUndefined();
  });

  it('omits an empty model rather than sending a blank string', () => {
    const spec = buildSpawnSpec({
      config: config(), handle: 'scout', cwd: '/p', adapters: [claude], members: [],
    });
    expect(spec.model).toBeUndefined();
  });
});
