import type { Member, Room } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POLICY,
  POLICIES,
  type AdapterLike,
  availableAgentHandle,
  buildSpawnSpec,
  channelOwner,
  collidesWithOwner,
  defaultSpawnCwd,
  HANDLE_PATTERN,
  errorConcernsSpawn,
  isAgentFieldError,
  errorMentionsHandle,
  resolveSpawn,
  SPAWN_PRESETS,
  applyPreset,
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

describe('a pending spawn resolves only on its own evidence (Tier-1 #5)', () => {
  const pending = (over: Partial<Parameters<typeof resolveSpawn>[0]> = {}) =>
    resolveSpawn({ handle: 'scout', members: [], freshErrors: [], ...over });

  it('stays pending while nothing relevant has happened', () => {
    expect(pending().state).toBe('pending');
  });

  it('completes when the submitted handle arrives', () => {
    expect(pending({ members: [agent({ handle: 'scout' })] }).state).toBe('arrived');
  });

  it('does NOT complete when an unrelated member arrives', () => {
    // The defect this guards: "membership changed" reported success for whichever
    // agent happened to join, which is a false success — worse than the silent
    // failure it replaced.
    expect(pending({ members: [agent({ handle: 'someone-else' })] }).state).toBe('pending');
  });

  it('does not mistake a similarly-named member for ours', () => {
    expect(pending({ members: [agent({ handle: 'scout-2' })] }).state).toBe('pending');
  });

  it('ignores a member that has been removed', () => {
    const gone = agent({ handle: 'scout', removed_ts: '2026-01-01T00:00:00.000Z' });
    expect(pending({ members: [gone] }).state).toBe('pending');
  });

  it('fails on an error naming our handle', () => {
    const out = pending({ freshErrors: ["handle 'scout' is reserved"] });
    expect(out).toEqual({ state: 'failed', message: "handle 'scout' is reserved" });
  });

  it('does NOT fail on an error naming a different member', () => {
    // The room error stream is shared; another agent's failure must not be
    // reported as this spawn's cause, nor abandon a request still in flight.
    expect(pending({ freshErrors: ['agent @other failed to spawn'] }).state).toBe('pending');
  });

  it('claims a spawn-shaped error that names nobody', () => {
    // The protocol rejects a reserved handle with the bare string
    // "handle is reserved" — it never names the handle. Matching only on the
    // handle would drop the most common failure an operator can cause.
    expect(pending({ freshErrors: ['handle is reserved'] }))
      .toEqual({ state: 'failed', message: 'handle is reserved' });
  });

  it('ignores an unrelated error that is not spawn-shaped', () => {
    expect(pending({ freshErrors: ['delivery to the bridge was held'] }).state).toBe('pending');
  });

  it('takes the most recent of several errors that are ours', () => {
    const out = pending({ freshErrors: ['scout first', 'unrelated thing', 'scout second'] });
    expect(out).toEqual({ state: 'failed', message: 'scout second' });
  });

  it('prefers arrival over a stale error', () => {
    expect(pending({
      members: [agent({ handle: 'scout' })], freshErrors: ['scout was slow'],
    }).state).toBe('arrived');
  });
});

describe('error correlation is handle-exact', () => {
  it.each([
    ["handle 'scout' is reserved", true],
    ['@scout failed to start', true],
    ['scout: spawn refused', true],
    ['scout-2 failed', false],
    ['prescout failed', false],
    ['nothing to do with it', false],
  ])('%s -> %s', (message, expected) => {
    expect(errorMentionsHandle(message, 'scout')).toBe(expected);
  });

  it('never matches on an empty handle', () => {
    expect(errorMentionsHandle('anything at all', '')).toBe(false);
  });

  it.each([
    ['handle is reserved', true],
    ['spawn refused: bad cwd', true],
    ['agent @someone-else failed to spawn', false],
    ['@scout failed to spawn', true],
    ['the ledger could not be written', false],
  ])('concerns-our-spawn: %s -> %s', (message, expected) => {
    expect(errorConcernsSpawn(message, 'scout')).toBe(expected);
  });
});

describe('server failures are routed to the field that caused them', () => {
  it.each([
    ["handle 'all' is reserved", true],
    ['starting agent could not be created', true],
    ['invalid handle format', true],
    ['channel name already exists', false],
    ['the ledger could not be written', false],
  ])('%s -> agent field: %s', (message, expected) => {
    // A field-specific error in a bottom banner reads as unrelated to the field,
    // which is how people retry the same value twice.
    expect(isAgentFieldError(message)).toBe(expected);
  });
});

describe('the handle pattern actually validates (Tier-1 regression)', () => {
  it('compiles under the v flag, which is how HTML compiles `pattern`', () => {
    // The unescaped form threw here, and the HTML spec says an invalid pattern is
    // IGNORED — so the field silently accepted anything. `NOPE!!` passed while
    // looking guarded. This is the root-cause assertion; the e2e checks the symptom.
    expect(() => new RegExp(`^(?:${HANDLE_PATTERN})$`, 'v')).not.toThrow();
  });

  it.each(['scout', 'a1', 'my-agent', 'x'.repeat(31)])('accepts %s', (handle) => {
    expect(new RegExp(`^(?:${HANDLE_PATTERN})$`, 'v').test(handle)).toBe(true);
  });

  it.each(['NOPE!!', 'Scout', '-lead', 'has space', 'x'.repeat(32), 'a'])('rejects %s', (handle) => {
    expect(new RegExp(`^(?:${HANDLE_PATTERN})$`, 'v').test(handle)).toBe(false);
  });
});

describe('the channel owner is found by role, not by position', () => {
  it('picks the owner even when another human is listed first', () => {
    const members = [
      agent({ id: 'h1', kind: 'human', handle: 'guest', role: 'member' } as Partial<Member>),
      agent({ id: 'h2', kind: 'human', handle: 'richard', role: 'owner' } as Partial<Member>),
    ];
    expect(channelOwner(members)?.handle).toBe('richard');
  });

  it('is undefined when no owner is present rather than guessing', () => {
    expect(channelOwner([agent({ kind: 'human', role: 'member' } as Partial<Member>)])).toBeUndefined();
  });
});

describe('role presets', () => {
  it('keeps legacy values rather than drifting', () => {
    const byId = Object.fromEntries(SPAWN_PRESETS.map((p) => [p.id, p]));
    expect(byId.writer?.thinking).toBe('low');
    expect(byId.reviewer?.policy).toBe('read-only');
    expect(byId.planner?.policy).toBe('read-only');
    expect(byId.coder?.policy).toBe('workspace-write');
    // Nothing here may quietly hand out full access.
    expect(SPAWN_PRESETS.every((p) => p.policy !== 'full-access')).toBe(true);
  });

  it('drops a level the harness does not accept instead of arming it', () => {
    const reviewer = SPAWN_PRESETS.find((p) => p.id === 'reviewer')!;
    const applied = applyPreset({
      preset: reviewer,
      config: { harness: 'codex', model: '', thinking: '', policy: '' },
      adapters: [plain], members: [],
    });
    expect(applied.config.thinking).toBe('');
    expect(applied.config.policy).toBe('read-only');
  });

  it('makes the preset handle unique against live members', () => {
    const reviewer = SPAWN_PRESETS.find((p) => p.id === 'reviewer')!;
    const applied = applyPreset({
      preset: reviewer,
      config: { harness: 'claude-code', model: '', thinking: '', policy: '' },
      adapters: [claude], members: [agent({ handle: 'reviewer' })],
    });
    expect(applied.handle).toBe('reviewer-2');
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
