import { RoomConfigSchema, type Member, type Message, type RoomConfig } from '@codor/protocol';
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
const childCodex = member({ id: id('IJK'), kind: 'agent', handle: 'codex', state: 'idle' });
const childRichard = member({ id: id('LMN'), kind: 'human', handle: 'richard', role: 'owner' });

const qualifiedCatalog = {
  room: 'eng',
  targets: [
    {
      worktree_id: id('TAR'),
      conversation_id: 'wt-review',
      alias: 'review',
      primary: false,
      lifecycle: 'active' as const,
      members: [
        { member_id: childCodex.id, handle: childCodex.handle, kind: 'agent' as const },
        { member_id: childRichard.id, handle: childRichard.handle, kind: 'human' as const },
      ],
    },
  ],
  tombstones: [{
    worktree_id: id('OLD'), conversation_id: 'wt-old', alias: 'old-review', lifecycle: 'removed' as const,
  }],
};

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
  roomConfig: RoomConfigSchema.parse({}),
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

// harn:assume qualified-member-target-identity-is-durable ref=qualified-body-grammar-regression
describe('qualified body grammar', () => {
  it('resolves main grammar before local mentions and preserves stable offsets', () => {
    const body = '`~review:@codex` ~review:@codex then @codex';
    const parsed = parseBody(body, ROSTER, { qualifiedTargets: qualifiedCatalog });
    expect(parsed.qualified).toHaveLength(1);
    expect(parsed.mentions).toHaveLength(2);
    expect(parsed.qualified?.[0]).toMatchObject({
      member_id: childCodex.id,
      target: { worktree_id: qualifiedCatalog.targets[0]!.worktree_id, conversation_id: 'wt-review' },
    });
    expect(body.slice(parsed.qualified![0]!.start, parsed.qualified![0]!.end)).toBe('~review:@codex');
    expect(parsed.mentions[1]).not.toHaveProperty('target');
    expect(parsed.unresolved).toEqual([]);
  });

  it('reports unknown, removed, malformed, and unavailable selectors without local fallback', () => {
    const unknown = parseBody('~missing:@codex', ROSTER, { qualifiedTargets: qualifiedCatalog });
    expect(unknown.qualified).toEqual([]);
    expect(unknown.qualified_issues?.[0]).toMatchObject({ reason: 'unknown-worktree' });

    const removed = parseBody('~old-review:@codex', ROSTER, { qualifiedTargets: qualifiedCatalog });
    expect(removed.qualified_issues?.[0]).toMatchObject({ reason: 'removed-worktree' });

    const malformed = parseBody('~Review:@codex', ROSTER, { qualifiedTargets: qualifiedCatalog });
    expect(malformed.qualified_issues?.[0]).toMatchObject({ reason: 'malformed' });
    expect(malformed.mentions).toEqual([]);

    const unavailable = parseBody('~review:@codex', ROSTER);
    expect(unavailable.qualified_issues?.[0]).toMatchObject({ reason: 'catalog-unavailable' });
    expect(unavailable.mentions).toEqual([]);
  });

  it('keeps UTF-16 spans and the inner handle isolated after non-BMP prefixes', () => {
    const body = `${'😀'.repeat(4)} ~review:@codex and @codex`;
    const parsed = parseBody(body, ROSTER, { qualifiedTargets: qualifiedCatalog });
    expect(parsed.qualified).toHaveLength(1);
    expect(parsed.mentions).toHaveLength(2);
    expect(body.slice(parsed.qualified![0]!.start, parsed.qualified![0]!.end))
      .toBe('~review:@codex');
    expect(parsed.mentions[1]).not.toHaveProperty('target');
    expect(body.slice(parsed.mentions[1]!.start, parsed.mentions[1]!.end)).toBe('@codex');
  });

  it('owns malformed suffixes and spaced selectors instead of leaking local mentions', () => {
    for (const body of ['~review: @codex', '~review:@codex.extra']) {
      const parsed = parseBody(body, ROSTER, { qualifiedTargets: qualifiedCatalog });
      expect(parsed.qualified).toEqual([]);
      expect(parsed.mentions).toEqual([]);
      expect(parsed.qualified_issues).toEqual([
        expect.objectContaining({ reason: 'malformed', handle: expect.stringContaining('codex') }),
      ]);
    }
  });

  it('leaves ordinary tilde prose outside qualified-token ownership', () => {
    for (const body of ['wait ~5 minutes', 'copy ~/tmp into the fixture', 'that is ~approximately right']) {
      const parsed = parseBody(body, ROSTER, { qualifiedTargets: qualifiedCatalog });
      expect(parsed.qualified).toBeUndefined();
      expect(parsed.qualified_issues).toBeUndefined();
      expect(parsed.mentions).toEqual([]);
    }
  });

  it('owns malformed boundaries and spacing through the complete inner handle', () => {
    for (const body of ['x~review:@codex', '~review :@codex', '~ review:@codex', '~review: @codex']) {
      const parsed = parseBody(body, ROSTER, { qualifiedTargets: qualifiedCatalog });
      expect(parsed.qualified).toEqual([]);
      expect(parsed.mentions).toEqual([]);
      expect(parsed.qualified_issues).toEqual([
        expect.objectContaining({ reason: 'malformed', selector: 'review', handle: 'codex' }),
      ]);
    }
  });

  it('owns empty selectors, repeated colons, and line breaks without leaking the inner handle', () => {
    const handled: [string, { selector: string; handle: string }][] = [
      ['~:@codex', { selector: '', handle: 'codex' }],
      ['~ :@codex', { selector: '', handle: 'codex' }],
      ['~review::@codex', { selector: 'review', handle: 'codex' }],
      ['~review: :@codex', { selector: 'review', handle: 'codex' }],
      ['~review:\n@codex', { selector: 'review', handle: 'codex' }],
      ['~\nreview:@codex', { selector: 'review', handle: 'codex' }],
      ['~review:\r\n@codex', { selector: 'review', handle: 'codex' }],
      ['~review:\t@codex', { selector: 'review', handle: 'codex' }],
    ];
    for (const [body, parts] of handled) {
      const parsed = parseBody(body, ROSTER, { qualifiedTargets: qualifiedCatalog });
      expect(parsed.qualified, body).toEqual([]);
      expect(parsed.mentions, body).toEqual([]);
      expect(parsed.qualified_issues, body).toEqual([
        expect.objectContaining({ reason: 'malformed', ...parts, token: body }),
      ]);
    }
  });

  it('owns a dangling selector with an empty handle instead of posting it', () => {
    for (const body of ['~review:', '~review:@']) {
      const parsed = parseBody(body, ROSTER, { qualifiedTargets: qualifiedCatalog });
      expect(parsed.qualified, body).toEqual([]);
      expect(parsed.mentions, body).toEqual([]);
      expect(parsed.qualified_issues, body).toEqual([
        expect.objectContaining({ reason: 'malformed', selector: 'review', handle: '', token: body }),
      ]);
    }
  });

  it('owns colon-only attempts with empty selector and handle as one malformed issue', () => {
    for (const body of ['~:', '~ :', '~::', '~ ::', '~: still not a mention']) {
      const parsed = parseBody(body, ROSTER, { qualifiedTargets: qualifiedCatalog });
      expect(parsed.qualified, body).toEqual([]);
      expect(parsed.mentions, body).toEqual([]);
      expect(parsed.qualified_issues, body).toEqual([
        expect.objectContaining({ reason: 'malformed', selector: '', handle: '' }),
      ]);
      expect(body.startsWith(parsed.qualified_issues![0]!.token), body).toBe(true);
    }
  });

  it('leaves colon-bearing ordinary prose outside qualified-token ownership', () => {
    for (const body of ['meet at ~5:30 sharp', '~note:check the ledger', '~http://x@y', '~user:pass@host']) {
      const parsed = parseBody(body, ROSTER, { qualifiedTargets: qualifiedCatalog });
      expect(parsed.qualified, body).toBeUndefined();
      expect(parsed.qualified_issues, body).toBeUndefined();
    }
  });

  it('distinguishes ambiguous targets and removed members', () => {
    const ambiguous = parseBody('~review:@codex', ROSTER, {
      qualifiedTargets: {
        ...qualifiedCatalog,
        targets: [...qualifiedCatalog.targets, { ...qualifiedCatalog.targets[0]! }],
      },
    });
    expect(ambiguous.qualified_issues?.[0]).toMatchObject({ reason: 'ambiguous-worktree' });

    const removedMember = parseBody('~review:@old-codex', ROSTER, {
      qualifiedTargets: {
        ...qualifiedCatalog,
        targets: [{
          ...qualifiedCatalog.targets[0]!,
          removed_members: [{ member_id: id('REM'), handle: 'old-codex', kind: 'agent' as const }],
        }],
      },
    });
    expect(removedMember.qualified_issues?.[0]).toMatchObject({ reason: 'removed-member' });
    expect(removedMember.mentions).toEqual([]);
  });
});
// harn:end qualified-member-target-identity-is-durable

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

  it.each(['completed', 'interrupted'] as const)(
    'never routes an empty %s run',
    (status) => {
      // Regression: live acceptance looped two agents through endless empty
      // acknowledgment turns because empty bodies still hit the default rule.
      const empty = msg({
        author: codex.id,
        kind: 'run',
        body: '',
        run: {
          status,
          started_ts: '2026-07-10T07:00:00.000Z',
          tool_calls: 0,
          events_ref: 'runs/8.jsonl',
        },
      });
      expect(isRoutable(empty, { author: codex })).toBe(false);
      const result = resolveRecipients(empty, ctx({ author: codex, triggerAuthor: claude.id }));
      expect(result.routable).toBe(false);
      expect(result.agents).toEqual([]);
    },
  );

  it('treats whitespace-only finalized output as empty', () => {
    const blank = msg({
      author: codex.id,
      kind: 'run',
      body: '   \n ',
      run: {
        status: 'completed',
        started_ts: '2026-07-10T07:00:00.000Z',
        tool_calls: 0,
        events_ref: 'runs/9.jsonl',
      },
    });
    expect(isRoutable(blank, { author: codex })).toBe(false);
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

  it('never routes or parses a durably marked acknowledgement', () => {
    const acknowledgement = msg({
      author: codex.id,
      kind: 'run',
      body: '<ACK_OK> @claude #42 [[secret]]',
      ack: true,
      run: { status: 'completed', started_ts: '2026-07-10T07:00:00.000Z', tool_calls: 0, events_ref: 'runs/2.jsonl' },
    });
    const result = resolveRecipients(
      acknowledgement,
      ctx({ author: codex, triggerAuthor: claude.id }),
    );
    expect(result.routable).toBe(false);
    expect(result.parsed).toEqual({ mentions: [], refs: [], ledger_refs: [], unresolved: [] });
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

  // harn:assume default-recipient-fallback-chain ref=effective-default-regression
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

    it('keeps an active foreign reply author scoped instead of using a local default', () => {
      const target = qualifiedCatalog.targets[0]!;
      const replyTarget = {
        worktree_id: target.worktree_id,
        conversation_id: target.conversation_id,
        member_id: childCodex.id,
        alias: target.alias,
        handle: childCodex.handle,
      };
      const result = resolveRecipients(msg({
        author: richard.id, kind: 'chat', body: 'continue this thread',
      }), ctx({
        author: richard,
        roomConfig: RoomConfigSchema.parse({ starting_agent_handle: 'claude' }),
        qualifiedTargets: qualifiedCatalog,
        replyAuthor: { member: childCodex, target: replyTarget },
        replyTarget,
      }));
      expect(result.agents).toEqual([childCodex]);
      expect(result.agentTargets?.[0]?.target).toEqual(replyTarget);
    });

    it('refuses a stale foreign reply scope without choosing an unrelated local agent', () => {
      const target = qualifiedCatalog.targets[0]!;
      const replyTarget = {
        worktree_id: target.worktree_id,
        conversation_id: target.conversation_id,
        member_id: childCodex.id,
        alias: 'gone',
        handle: childCodex.handle,
      };
      const result = resolveRecipients(msg({
        author: richard.id, kind: 'chat', body: 'do not drift locally',
      }), ctx({
        author: richard,
        qualifiedTargets: qualifiedCatalog,
        replyTarget,
      }));
      expect(result.qualified_refusal).toContain('stale scoped reply');
      expect(result.agents).toEqual([]);
      expect(result.commentary).toBe(true);
    });

    it('fresh human messages prefer the configured live starting agent', () => {
      const m = msg({ author: richard.id, kind: 'chat', body: 'hi' });
      const result = resolveRecipients(m, ctx({
        author: richard,
        roomConfig: RoomConfigSchema.parse({ starting_agent_handle: 'codex' }),
      }));
      expect(result.agents.map((agent) => agent.handle)).toEqual(['codex']);
      expect(result.commentary).toBe(false);
    });

    it('falls back to the sole live agent when the configured starter is dead', () => {
      const m = msg({ author: richard.id, kind: 'chat', body: 'continue' });
      const result = resolveRecipients(m, ctx({
        author: richard,
        members: [richard, deadAgent, claude, system],
        roomConfig: RoomConfigSchema.parse({ starting_agent_handle: deadAgent.handle }),
      }));
      expect(result.agents.map((agent) => agent.handle)).toEqual(['claude']);
      expect(result.commentary).toBe(false);
    });

    it('uses the sole live agent when no starting handle was configured', () => {
      const m = msg({ author: richard.id, kind: 'chat', body: 'continue' });
      const result = resolveRecipients(m, ctx({
        author: richard,
        members: [richard, codex, system],
      }));
      expect(result.agents.map((agent) => agent.handle)).toEqual(['codex']);
      expect(result.commentary).toBe(false);
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
  // harn:end default-recipient-fallback-chain

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

  // harn:assume qualified-member-target-identity-is-durable ref=qualified-routing-regression
  it('resolves equal handles to the persisted target member and keeps local routing separate', () => {
    const m = msg({ author: richard.id, kind: 'chat', body: '~review:@codex compare with @codex' });
    const result = resolveRecipients(m, ctx({
      author: richard,
      qualifiedTargets: qualifiedCatalog,
      qualifiedMembers: new Map([[childCodex.id, childCodex]]),
    }));
    expect(result.agents.map((agent) => agent.id)).toEqual([childCodex.id, codex.id]);
    expect(result.agentTargets?.map((target) => target.target?.conversation_id)).toEqual(['wt-review', undefined]);
    expect(result.agentTargets?.[0]?.target?.handle).toBe('codex');
    expect(result.commentary).toBe(false);
  });

  it('strictly refuses an invalid qualified mention instead of falling back to a local agent', () => {
    const m = msg({ author: richard.id, kind: 'chat', body: '~removed:@codex please continue' });
    const result = resolveRecipients(m, ctx({
      author: richard,
      qualifiedTargets: qualifiedCatalog,
      qualifiedMembers: new Map([[childCodex.id, childCodex]]),
    }));
    expect(result.qualified_refusal).toContain('removed');
    expect(result.agents).toEqual([]);
    expect(result.humans).toEqual([]);
    expect(result.commentary).toBe(true);
  });
  // harn:end qualified-member-target-identity-is-durable

  // harn:assume invalid-qualified-targets-never-fallback ref=qualified-routing-refusal-regression
  it('does not partially fan out a mixed qualified post', () => {
    const m = msg({ author: richard.id, kind: 'chat', body: '~review:@codex and ~missing:@codex' });
    const result = resolveRecipients(m, ctx({
      author: richard,
      qualifiedTargets: qualifiedCatalog,
      qualifiedMembers: new Map([[childCodex.id, childCodex]]),
    }));
    expect(result.qualified_refusal).toBeDefined();
    expect(result.agents).toEqual([]);
    expect(result.agentTargets).toEqual([]);
  });

  it('refuses a colon-only attempt instead of falling back to the configured default', () => {
    for (const body of ['~:', '~ :', '~::', '~ ::']) {
      const m = msg({ author: richard.id, kind: 'chat', body });
      const result = resolveRecipients(m, ctx({
        author: richard,
        roomConfig: RoomConfigSchema.parse({ starting_agent_handle: 'codex' }),
        qualifiedTargets: qualifiedCatalog,
      }));
      expect(result.qualified_refusal, body).toContain('qualified target refused');
      expect(result.agents, body).toEqual([]);
      expect(result.agentTargets, body).toEqual([]);
    }
  });

  it('refuses a qualified mention when its stable member is absent from the runtime map', () => {
    const m = msg({ author: richard.id, kind: 'chat', body: '~review:@codex keep scope' });
    const result = resolveRecipients(m, ctx({
      author: richard,
      qualifiedTargets: qualifiedCatalog,
      qualifiedMembers: new Map(),
    }));
    expect(result.qualified_refusal).toContain('target member unavailable');
    expect(result.agents).toEqual([]);
    expect(result.humans).toEqual([]);
    expect(result.commentary).toBe(true);
  });

  it('carries a valid scoped trigger onward and refuses a stale one without local fallback', () => {
    const target = qualifiedCatalog.targets[0]!;
    const scopedTrigger = { member: childCodex, target: {
      worktree_id: target.worktree_id,
      conversation_id: target.conversation_id,
      member_id: childCodex.id,
      alias: target.alias,
      handle: childCodex.handle,
    } };
    const onward = resolveRecipients(msg({
      author: claude.id,
      kind: 'run',
      body: 'final answer',
      run: { status: 'completed', started_ts: '2026-07-10T07:00:00.000Z', tool_calls: 0, events_ref: 'runs/14.jsonl' },
    }), ctx({
      author: claude,
      triggerAuthor: scopedTrigger,
      qualifiedTargets: qualifiedCatalog,
      qualifiedMembers: new Map([[childCodex.id, childCodex]]),
    }));
    expect(onward.agents.map((agent) => agent.id)).toEqual([childCodex.id]);
    expect(onward.agentTargets?.[0]?.target?.conversation_id).toBe('wt-review');

    const stale = resolveRecipients(msg({
      author: claude.id, kind: 'run', body: 'do not fall back',
      run: { status: 'completed', started_ts: '2026-07-10T07:00:00.000Z', tool_calls: 0, events_ref: 'runs/15.jsonl' },
    }), ctx({
      author: claude,
      triggerAuthor: { ...scopedTrigger, target: { ...scopedTrigger.target, alias: 'gone' } },
      qualifiedTargets: qualifiedCatalog,
      qualifiedMembers: new Map([[childCodex.id, childCodex]]),
    }));
    expect(stale.qualified_refusal).toContain('stale scoped trigger');
    expect(stale.agents).toEqual([]);
    expect(stale.commentary).toBe(true);
  });
  // harn:end invalid-qualified-targets-never-fallback
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
    ledgerRefs: [{ name: 'risk-limits', body: '---\nname: risk-limits\n---\nKeep exposure below 2%.\n' }],
    conventions: { untaggedGoesTo: 'richard', ledger: true },
  };

  it('matches the PROTOCOL §3 example shape exactly', () => {
    expect(composePayload(payloadCtx, 'codex')).toBe(
      '[codor channel=traderjoe-eng msg=#93107 from=@richard (human)\n' +
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
        '--- ledger [[risk-limits]] ---\n' +
        '---\nname: risk-limits\n---\nKeep exposure below 2%.\n\n' +
        '--- end ledger note ---\n' +
        '\n' +
        '[conventions: your normal final reply posts to the channel automatically. An @mention ' +
        "invokes that member and auto-sends your message; write the member's plain name without @ " +
        'when merely discussing them. An untagged reply goes to @richard. Reference messages as ' +
        '#N. Cite ledger notes as [[name]]. When delegating channel work, keep it with channel ' +
        'members rather than internal subagents: assign one member by tagging them once. After ' +
        'handoff, do not poll, monitor, remind, or re-tag them; the worker returns by tagging you ' +
        'once only on completion or a genuine blocker. Use codor post only for necessary interim ' +
        'output while continuing, or output sent outside the normal response path; use codor post ' +
        '--wait only for one genuinely blocking direct answer. Use codor search --runs before ' +
        'asking about unseen referenced context. Use <ACK_OK> as your entire reply only when a ' +
        'message needs no action and no answer; never append it after doing work or as a sign-off.]\n',
    );
  });

  it('renders a roster with optional purposes independently of conventions', () => {
    expect(composePayload({
      ...payloadCtx,
      refs: [],
      ledgerRefs: [],
      conventions: undefined,
      roster: [
        { handle: 'richard', kind: 'human' },
        { handle: 'codex', kind: 'agent', purpose: 'Implements changes' },
      ],
    }, 'codex')).toContain(
      '\n[roster:\n@richard (human)\n@codex (agent, Implements changes)\n]\n',
    );
  });

  it('lean form: no refs, no conventions once sent', () => {
    const lean = {
      ...payloadCtx,
      message: msg({ id: 93110, author: richard.id, kind: 'chat', body: 'ship it' }),
      toHandles: ['codex'],
      refs: [],
      ledgerRefs: [],
      conventions: undefined,
    };
    expect(composePayload(lean, 'codex')).toBe(
      '[codor channel=traderjoe-eng msg=#93110 from=@richard (human)\n' +
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

  // harn:assume awaiting-reply-marker-is-delivery-context ref=awaiting-reply-header-regression
  it('marks blocking chat only in the immutable delivery header', () => {
    const payload = composePayload({
      ...payloadCtx,
      authorHandle: 'codex',
      authorKind: 'agent',
      awaitingReply: true,
      refs: [],
      ledgerRefs: [],
      conventions: undefined,
    }, 'claude');
    expect(payload).toContain('from=@codex (chat, awaiting reply)');
    expect(payload).not.toContain('from=@codex (agent)');
  });
  // harn:end awaiting-reply-marker-is-delivery-context

  // harn:assume collaboration-briefing-enforces-single-channel-handoff ref=collaboration-handoff-regression
  // harn:assume agent-briefings-enforce-single-invocation ref=explicit-invocation-regression
  it('teaches one channel-member handoff without polling for every adapter', () => {
    const baseline = composePayload(payloadCtx, 'codex');
    const live = composePayload({
      ...payloadCtx,
      conventions: { ...payloadCtx.conventions, liveInbox: true },
    }, 'codex');

    expect(live).toBe(baseline);
    for (const phrase of [
      'normal final reply posts',
      '@mention invokes',
      'plain name without @',
      'channel members rather than internal subagents',
      'assign one member by tagging them once',
      'do not poll, monitor, remind, or re-tag',
      'worker returns by tagging you once only on completion or a genuine blocker',
      'codor post only for necessary interim output while continuing, or output sent outside the normal response path',
      'codor post --wait only for one genuinely blocking direct answer',
      'codor search --runs',
      'Use <ACK_OK> as your entire reply only when a message needs no action and no answer',
      'never append it after doing work or as a sign-off',
    ]) {
      expect(live, phrase).toContain(phrase);
    }
    for (const phrase of ['codor status', 'codor inbox --new', 'on timeout', 'renew while']) {
      expect(live, phrase).not.toContain(phrase);
    }
  });
  // harn:end agent-briefings-enforce-single-invocation
  // harn:end collaboration-briefing-enforces-single-channel-handoff
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
