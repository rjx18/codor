import type { Member, Message, RoomConfig } from '@wireroom/protocol';
import { describe, expect, it } from 'vitest';

import {
  composeDeliveryPayloads,
  composePayload,
  evaluateBrakes,
  isRoutable,
  parseBody,
  resolveRecipients,
  type RoutingContext,
} from './router.js';

// ── fixtures ────────────────────────────────────────────────────────────

const id = (suffix: string): string => `01ARZ3NDEKTSV4RRFFQ69G5${suffix}`.slice(0, 26);

const member = (partial: Partial<Member> & Pick<Member, 'id' | 'kind' | 'handle'>): Member => ({
  display_name: partial.handle,
  conventions_sent: false,
  misaddressed: false,
  ...partial,
});

const richard = member({ id: id('AAA'), kind: 'human', handle: 'richard', role: 'owner' });
const codex = member({ id: id('BBB'), kind: 'agent', handle: 'codex', state: 'idle' });
const claude = member({ id: id('CCC'), kind: 'agent', handle: 'claude', state: 'idle' });
const deadAgent = member({ id: id('DDD'), kind: 'agent', handle: 'old-timer', state: 'dead' });
const pausedAgent = member({ id: id('EEE'), kind: 'agent', handle: 'napper', state: 'paused' });
const extension = member({ id: id('FFF'), kind: 'extension', handle: 'claude-ext-7adw', parent: claude.id });
const system = member({ id: id('GGG'), kind: 'system', handle: 'switchboard' });
const bridge = member({ id: id('HHH'), kind: 'bridge', handle: 'slack-bridge' });

const ROSTER = [richard, codex, claude, deadAgent, pausedAgent, extension, system, bridge];

let nextId = 100;
const msg = (partial: Partial<Message> & Pick<Message, 'author' | 'kind' | 'body'>): Message => ({
  id: nextId++,
  room: 'eng',
  mentions: [],
  refs: [],
  ledger_refs: [],
  ts: '2026-07-10T07:00:00.000Z',
  seq: 1,
  ...partial,
});

const ctx = (over: Partial<RoutingContext> & { author: Member | undefined }): RoutingContext => ({
  members: ROSTER,
  ...over,
});

const spanHandles = (body: string, parsed: ReturnType<typeof parseBody>): string[] =>
  parsed.mentions.map((s) => {
    const byId = new Map(ROSTER.map((m) => [m.id, m.handle]));
    expect(body.slice(s.start, s.end)).toBe(`@${byId.get(s.member_id)}`);
    return byId.get(s.member_id)!;
  });

// ── grammar table (PROTOCOL §3 parsing rules) ───────────────────────────

describe('parseBody grammar', () => {
  const cases: {
    name: string;
    body: string;
    mentions?: string[]; // expected handles, in occurrence order
    refs?: number[];
    ledger?: string[];
    unresolved?: string[];
  }[] = [
    { name: 'plain text yields nothing', body: 'just words here' },
    { name: 'single mention', body: '@codex go', mentions: ['codex'] },
    { name: 'mention mid-sentence', body: 'over to @codex now', mentions: ['codex'] },
    { name: 'mention at end', body: 'ping @codex', mentions: ['codex'] },
    { name: 'two mentions keep order', body: '@claude then @codex', mentions: ['claude', 'codex'] },
    { name: 'duplicate mention yields two spans', body: '@codex and @codex', mentions: ['codex', 'codex'] },
    { name: 'comma boundary', body: '@codex, start', mentions: ['codex'] },
    { name: 'period boundary', body: 'ask @codex.', mentions: ['codex'] },
    { name: 'question boundary', body: 'ready @codex?', mentions: ['codex'] },
    { name: 'colon boundary', body: '@codex: begin', mentions: ['codex'] },
    { name: 'paren boundary', body: '(@codex) owns it', mentions: ['codex'] },
    { name: 'quote boundary', body: '"@codex" said so', mentions: ['codex'] },
    { name: 'newline boundary', body: 'line one\n@codex line two', mentions: ['codex'] },
    { name: 'hyphenated handle resolves', body: '@old-timer wake up', mentions: ['old-timer'] },
    { name: 'inline code escapes mention', body: 'type `@codex` literally' },
    { name: 'fenced block escapes mention', body: '```\n@codex\n```\nnothing' },
    { name: 'fenced block with language escapes', body: '```ts\nconst a = "@codex";\n```' },
    { name: 'unclosed fence escapes rest', body: 'pre\n```\n@codex still code' },
    { name: 'mention after fence resolves', body: '```\ncode\n```\n@codex go', mentions: ['codex'] },
    { name: 'email-like is not a mention', body: 'mail richard@codex.dev' },
    { name: 'double @@ is not a mention', body: 'weird @@codex token' },
    { name: 'uppercase is not handle-shaped', body: 'Hey @Codex' },
    { name: '@all is reserved plain text', body: '@all listen up' },
    { name: '@switchboard is reserved plain text', body: 'thanks @switchboard' },
    { name: 'unknown handle is unresolved', body: '@codexx do it', unresolved: ['codexx'] },
    { name: 'typo collected once', body: '@clade then @clade again', unresolved: ['clade'] },
    { name: 'extension mention is plain text', body: 'saw @claude-ext-7adw working' },
    { name: 'bridge mention is plain text', body: 'via @slack-bridge earlier' },
    { name: 'dead member IS addressable', body: '@old-timer revive soon', mentions: ['old-timer'] },
    { name: 'paused member IS addressable', body: '@napper for later', mentions: ['napper'] },
    { name: 'single ref', body: 'see #12', refs: [12] },
    { name: 'multiple refs keep order', body: '#3 then #1', refs: [3, 1] },
    { name: 'duplicate refs collapse', body: '#7 and #7 again', refs: [7] },
    { name: 'ref in inline code skipped', body: 'literal `#12` here' },
    { name: 'ref needs digits', body: 'issue #abc' },
    { name: '#0 is not a message id', body: 'nothing at #0' },
    { name: 'ref glued to word is skipped', body: 'room#12 naming' },
    { name: 'single ledger ref', body: 'per [[risk-limits]]', ledger: ['risk-limits'] },
    { name: 'multiple ledger refs', body: '[[a]] meets [[b]]', ledger: ['a', 'b'] },
    { name: 'duplicate ledger refs collapse', body: '[[a]] and [[a]]', ledger: ['a'] },
    { name: 'ledger ref in code skipped', body: 'type `[[a]]` verbatim' },
    { name: 'empty ledger ref ignored', body: 'stray [[]] brackets' },
    {
      name: 'mixed grammar all at once',
      body: '@claude check #4 against [[marker-semantics]] with @codexx',
      mentions: ['claude'],
      refs: [4],
      ledger: ['marker-semantics'],
      unresolved: ['codexx'],
    },
  ];

  it.each(cases)('$name', ({ body, mentions = [], refs = [], ledger = [], unresolved = [] }) => {
    const parsed = parseBody(body, ROSTER);
    expect(spanHandles(body, parsed)).toEqual(mentions);
    expect(parsed.refs).toEqual(refs);
    expect(parsed.ledger_refs).toEqual(ledger);
    expect(parsed.unresolved).toEqual(unresolved);
  });
});

// ── eligibility gate ────────────────────────────────────────────────────

describe('routing eligibility gate', () => {
  it('routes human chat', () => {
    const m = msg({ author: richard.id, kind: 'chat', body: '@codex go' });
    expect(isRoutable(m, { author: richard })).toBe(true);
  });

  it('routes bridge-authored chat (external humans speak through it)', () => {
    const m = msg({
      author: bridge.id,
      kind: 'chat',
      body: '@codex go',
      origin: { platform: 'slack', external_id: 'x1', sender_name: 'sarah' },
    });
    expect(isRoutable(m, { author: bridge })).toBe(true);
  });

  it('routes a FINALIZED run message', () => {
    const m = msg({
      author: codex.id,
      kind: 'run',
      body: 'done @richard',
      run: { status: 'completed', started_ts: '2026-07-10T07:00:00.000Z', tool_calls: 1, events_ref: 'runs/1.jsonl' },
    });
    expect(isRoutable(m, { author: codex })).toBe(true);
  });

  it('never routes a still-running placeholder', () => {
    const m = msg({
      author: codex.id,
      kind: 'run',
      body: '',
      run: { status: 'running', started_ts: '2026-07-10T07:00:00.000Z', tool_calls: 0, events_ref: 'runs/2.jsonl' },
    });
    expect(isRoutable(m, { author: codex })).toBe(false);
  });

  // every system source, exhaustively: none may ever produce a delivery
  const systemSources: [string, () => Message, Member][] = [
    ['rename notice', () => msg({ author: system.id, kind: 'system', body: '@codex is now @coder' }), system],
    ['ledger notice', () => msg({ author: system.id, kind: 'system', body: '@claude updated [[x]]' }), system],
    ['hold notice', () => msg({ author: system.id, kind: 'system', body: 'paused after 8 hops' }), system],
    ['system-member chat', () => msg({ author: system.id, kind: 'chat', body: '@codex hello' }), system],
    ['ask card', () => msg({ author: claude.id, kind: 'ask', body: 'Which codeword? @richard', ask: { interaction_id: 'i', kind: 'ask', prompt: 'Which codeword?' } }), claude],
    ['approval card', () => msg({ author: claude.id, kind: 'approval', body: 'Allow Bash? @richard', ask: { interaction_id: 'i', kind: 'approval', prompt: 'Allow?' } }), claude],
    ['extension-authored message', () => msg({ author: extension.id, kind: 'chat', body: '@codex hi' }), extension],
  ];

  it.each(systemSources)('%s never routes', (_name, make, author) => {
    const m = make();
    expect(isRoutable(m, { author })).toBe(false);
    const result = resolveRecipients(m, ctx({ author }));
    expect(result.routable).toBe(false);
    expect(result.agents).toEqual([]);
    expect(result.humans).toEqual([]);
  });

  it('audit reply on a card never routes (but a normal threaded chat does)', () => {
    const card = msg({ author: claude.id, kind: 'ask', body: 'Which?', ask: { interaction_id: 'i', kind: 'ask', prompt: 'Which?' } });
    const audit = msg({ author: richard.id, kind: 'chat', body: 'ALPHA', reply_to: card.id });
    expect(isRoutable(audit, { author: richard, repliedTo: card })).toBe(false);

    const normal = msg({ author: richard.id, kind: 'chat', body: '@codex also this', reply_to: 42 });
    const plainParent = msg({ author: claude.id, kind: 'chat', body: 'earlier' });
    expect(isRoutable(normal, { author: richard, repliedTo: plainParent })).toBe(true);
  });
});

// ── recipient resolution ────────────────────────────────────────────────

describe('resolveRecipients', () => {
  it('fans out to the union of valid mentions, duplicates collapsed', () => {
    const m = msg({ author: richard.id, kind: 'chat', body: '@codex xxx then @claude yyy and @codex again' });
    const result = resolveRecipients(m, ctx({ author: richard }));
    expect(result.agents.map((a) => a.handle)).toEqual(['codex', 'claude']);
    expect(result.humans).toEqual([]);
  });

  it('splits humans from agents — humans get inbox records, never turns', () => {
    const m = msg({ author: claude.id, kind: 'chat', body: '@richard done, @codex verify' });
    const result = resolveRecipients(m, ctx({ author: claude }));
    expect(result.agents.map((a) => a.handle)).toEqual(['codex']);
    expect(result.humans.map((h) => h.handle)).toEqual(['richard']);
  });

  it('ignores self-mentions (no self-retrigger)', () => {
    const m = msg({ author: codex.id, kind: 'chat', body: '@codex note to self, @claude take over' });
    const result = resolveRecipients(m, ctx({ author: codex }));
    expect(result.agents.map((a) => a.handle)).toEqual(['claude']);
  });

  it('a bridge is never a recipient (mention is plain text, no default lands on it)', () => {
    const m = msg({ author: richard.id, kind: 'chat', body: '@slack-bridge relay this' });
    const result = resolveRecipients(m, ctx({ author: richard }));
    expect(result.agents).toEqual([]);
    expect(result.humans).toEqual([]);
    expect(result.commentary).toBe(true);
  });

  describe('default recipient', () => {
    it('mentionless human message goes to the latest FINALIZED agent author', () => {
      const m = msg({ author: richard.id, kind: 'chat', body: 'looks good, continue' });
      const result = resolveRecipients(m, ctx({ author: richard, latestFinalizedAgentAuthor: claude.id }));
      expect(result.agents.map((a) => a.handle)).toEqual(['claude']);
      expect(result.commentary).toBe(false);
    });

    it('a still-running agent never counts — daemon supplies only finalized authors', () => {
      // codex is mid-run; the latest FINALIZED author is claude even though
      // codex posted (a running placeholder) more recently.
      const m = msg({ author: richard.id, kind: 'chat', body: 'and now?' });
      const result = resolveRecipients(m, ctx({ author: richard, latestFinalizedAgentAuthor: claude.id }));
      expect(result.agents.map((a) => a.handle)).toEqual(['claude']);
    });

    it('no agent ever finished → room commentary, delivered to nobody', () => {
      const m = msg({ author: richard.id, kind: 'chat', body: 'morning all' });
      const result = resolveRecipients(m, ctx({ author: richard }));
      expect(result.commentary).toBe(true);
      expect(result.agents).toEqual([]);
      expect(result.humans).toEqual([]);
    });

    it('mentionless finalized agent run flows back to its trigger author', () => {
      const m = msg({
        author: codex.id,
        kind: 'run',
        body: 'done, all tests pass',
        run: { status: 'completed', started_ts: '2026-07-10T07:00:00.000Z', tool_calls: 2, events_ref: 'runs/9.jsonl' },
      });
      const result = resolveRecipients(m, ctx({ author: codex, triggerAuthor: richard.id }));
      expect(result.humans.map((h) => h.handle)).toEqual(['richard']);
      expect(result.agents).toEqual([]);
    });

    it('batched turn defaults to the LAST delivery author (daemon passes it)', () => {
      const m = msg({
        author: codex.id,
        kind: 'run',
        body: 'both handled',
        run: { status: 'completed', started_ts: '2026-07-10T07:00:00.000Z', tool_calls: 0, events_ref: 'runs/10.jsonl' },
      });
      const result = resolveRecipients(m, ctx({ author: codex, triggerAuthor: claude.id }));
      expect(result.agents.map((a) => a.handle)).toEqual(['claude']);
    });

    it('agent defaulting to itself is commentary, not a self-loop', () => {
      const m = msg({
        author: codex.id,
        kind: 'run',
        body: 'self note',
        run: { status: 'completed', started_ts: '2026-07-10T07:00:00.000Z', tool_calls: 0, events_ref: 'runs/11.jsonl' },
      });
      const result = resolveRecipients(m, ctx({ author: codex, triggerAuthor: codex.id }));
      expect(result.commentary).toBe(true);
      expect(result.agents).toEqual([]);
    });
  });

  describe('misaddressing', () => {
    it('unresolved tokens in a finalized agent message set the flag', () => {
      const m = msg({
        author: codex.id,
        kind: 'run',
        body: '@clade please review',
        run: { status: 'completed', started_ts: '2026-07-10T07:00:00.000Z', tool_calls: 0, events_ref: 'runs/12.jsonl' },
      });
      const result = resolveRecipients(m, ctx({ author: codex, triggerAuthor: richard.id }));
      expect(result.misaddressed).toBe(true);
      expect(result.parsed.unresolved).toEqual(['clade']);
    });

    it('unresolved tokens in a HUMAN message do not set the flag', () => {
      const m = msg({ author: richard.id, kind: 'chat', body: '@clade typo', });
      const result = resolveRecipients(m, ctx({ author: richard }));
      expect(result.misaddressed).toBe(false);
    });

    it('clean agent messages do not set the flag', () => {
      const m = msg({
        author: codex.id,
        kind: 'run',
        body: '@claude over to you',
        run: { status: 'completed', started_ts: '2026-07-10T07:00:00.000Z', tool_calls: 0, events_ref: 'runs/13.jsonl' },
      });
      expect(resolveRecipients(m, ctx({ author: codex })).misaddressed).toBe(false);
    });
  });
});

// ── payload goldens ─────────────────────────────────────────────────────

describe('delivery payload template (byte-exact goldens)', () => {
  const message = msg({
    id: 93107,
    author: richard.id,
    kind: 'chat',
    body:
      'Nice work overnight. @codex Start implementation of phase 3, see my comments\n' +
      'in #92832 before starting. @claude while codex does that, draft the M4 test plan.',
  });
  const payloadCtx = {
    room: 'traderjoe-eng',
    message,
    authorHandle: 'richard',
    authorKind: 'human' as const,
    toHandles: ['codex', 'claude'],
    refs: [
      {
        id: 92832,
        author_handle: 'claude',
        ts: '2026-07-10T02:14:09.000Z',
        body:
          'The rebalance path still used stale closes; phase 3 must gate on fresh marks\n' +
          'before submitting.',
      },
    ],
    conventions: { others: ['claude', 'richard'], untaggedGoesTo: 'richard' },
  };

  it('matches the PROTOCOL §3 example shape exactly', () => {
    expect(composePayload(payloadCtx, 'codex')).toBe(
      '[wireroom room=traderjoe-eng msg=#93107 from=@richard (human)\n' +
        ' to=@codex @claude · you=@codex]\n' +
        '\n' +
        'Nice work overnight. @codex Start implementation of phase 3, see my comments\n' +
        'in #92832 before starting. @claude while codex does that, draft the M4 test plan.\n' +
        '\n' +
        '--- referenced #92832 · @claude · 2026-07-10T02:14Z ---\n' +
        'The rebalance path still used stale closes; phase 3 must gate on fresh marks\n' +
        'before submitting.\n' +
        '--- end reference ---\n' +
        '\n' +
        '[conventions: your reply posts to the room. Tag @claude / @richard to address ' +
        'them; an untagged reply goes to @richard. Reference messages as #N.]\n',
    );
  });

  it('lean form: no refs, no conventions once sent', () => {
    const lean = {
      ...payloadCtx,
      message: msg({ id: 93110, author: richard.id, kind: 'chat', body: 'ship it' }),
      toHandles: ['codex'],
      refs: [],
      conventions: undefined,
    };
    expect(composePayload(lean, 'codex')).toBe(
      '[wireroom room=traderjoe-eng msg=#93110 from=@richard (human)\n' +
        ' to=@codex · you=@codex]\n' +
        '\n' +
        'ship it\n',
    );
  });

  it('fan-out payloads are identical except the you= field', () => {
    const payloads = composeDeliveryPayloads(payloadCtx, [codex, claude]);
    const forCodex = payloads.get(codex.id)!;
    const forClaude = payloads.get(claude.id)!;
    expect(forCodex).not.toBe(forClaude);
    expect(forCodex.replace('you=@codex', 'you=@claude')).toBe(forClaude);
    // whole message: full body present in both, never split per-mention
    expect(forCodex).toContain('draft the M4 test plan');
    expect(forClaude).toContain('Start implementation of phase 3');
  });
});

// ── brakes ──────────────────────────────────────────────────────────────

describe('brakes (opt-in, off by default)', () => {
  const defaults: RoomConfig = {
    turn_brake: null,
    spend_brake_usd: null,
    stall_minutes: 30,
    redaction_enabled: true,
  };

  it('the default config NEVER holds, however long the chain or big the spend', () => {
    expect(
      evaluateBrakes(defaults, { consecutiveAgentDeliveries: 10_000, spendTodayUsd: 9_999 }),
    ).toEqual({ hold: false });
  });

  it('turn brake holds once the agent→agent chain reaches the limit', () => {
    const config = { ...defaults, turn_brake: 8 };
    expect(evaluateBrakes(config, { consecutiveAgentDeliveries: 7, spendTodayUsd: 0 })).toEqual({ hold: false });
    expect(evaluateBrakes(config, { consecutiveAgentDeliveries: 8, spendTodayUsd: 0 })).toEqual({
      hold: true,
      reason: 'turn_brake',
    });
  });

  it('spend brake holds at the daily threshold', () => {
    const config = { ...defaults, spend_brake_usd: 25 };
    expect(evaluateBrakes(config, { consecutiveAgentDeliveries: 0, spendTodayUsd: 24.99 })).toEqual({ hold: false });
    expect(evaluateBrakes(config, { consecutiveAgentDeliveries: 0, spendTodayUsd: 25 })).toEqual({
      hold: true,
      reason: 'spend_brake',
    });
  });

  it('turn brake reports before spend brake when both breach', () => {
    const config = { ...defaults, turn_brake: 1, spend_brake_usd: 1 };
    expect(evaluateBrakes(config, { consecutiveAgentDeliveries: 5, spendTodayUsd: 5 })).toEqual({
      hold: true,
      reason: 'turn_brake',
    });
  });
});
