// @vitest-environment happy-dom
import { parseBody } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import {
  composerDispatchSnapshot,
  composeVoiceBody,
  deriveVoiceRecipientHandle,
  exactLocalMention,
  exactQualifiedMention,
  hasOwnPendingComposerEcho,
  insertQualifiedMentionText,
  pendingComposerResolution,
  qualifiedCompletionCandidates,
  qualifiedMentionQuery,
  resizeComposerTextarea,
  selectPendingDestinationMessages,
} from './Composer.js';

// harn:assume composer-autogrow-measures-offscreen-before-live-height ref=offscreen-composer-measurement-regression
describe('offscreen composer measurement', () => {
  function fixture(options: {
    value?: string;
    previousHeight?: string;
    scrollHeight?: number;
    width?: number;
    lineHeight?: string;
    boxSizing?: string;
  } = {}) {
    const visibleWrites: string[] = [];
    const mirrorWrites: string[] = [];
    const mirroredProperties = new Map<string, string>();
    let visibleHeight = options.previousHeight ?? '36px';
    let mirrorHeight = 'unset';
    let mirrorWidth = '';
    const visibleStyle = {
      get height() { return visibleHeight; },
      set height(value: string) { visibleHeight = value; visibleWrites.push(value); },
    } as CSSStyleDeclaration;
    const mirrorStyle = {
      get height() { return mirrorHeight; },
      set height(value: string) { mirrorHeight = value; mirrorWrites.push(value); },
      get width() { return mirrorWidth; },
      set width(value: string) { mirrorWidth = value; },
      setProperty(name: string, value: string) { mirroredProperties.set(name, value); },
    } as CSSStyleDeclaration;
    const visible = {
      value: options.value ?? 'one\ntwo\nthree',
      style: visibleStyle,
      scrollHeight: 0,
      getBoundingClientRect: () => ({ width: options.width ?? 320 } as DOMRect),
    };
    const mirror = {
      value: '',
      style: mirrorStyle,
      scrollHeight: options.scrollHeight ?? 84,
      getBoundingClientRect: () => ({ width: options.width ?? 320 } as DOMRect),
    };
    const computedValues = new Map<string, string>([
      ['box-sizing', options.boxSizing ?? 'border-box'],
      ['font-family', 'Inter'],
      ['font-size', '16px'],
      ['line-height', options.lineHeight ?? '24px'],
      ['padding-top', '6px'],
      ['padding-bottom', '6px'],
      ['border-top-width', '1px'],
      ['border-bottom-width', '1px'],
      ['white-space', 'pre-wrap'],
      ['overflow-wrap', 'break-word'],
    ]);
    const computed = {
      lineHeight: computedValues.get('line-height')!,
      paddingTop: computedValues.get('padding-top')!,
      paddingBottom: computedValues.get('padding-bottom')!,
      borderTopWidth: computedValues.get('border-top-width')!,
      borderBottomWidth: computedValues.get('border-bottom-width')!,
      boxSizing: computedValues.get('box-sizing')!,
      getPropertyValue: (name: string) => computedValues.get(name) ?? '',
    };
    return {
      visible,
      mirror,
      computed,
      visibleWrites,
      mirrorWrites,
      mirroredProperties,
      visibleHeight: () => visibleHeight,
      mirrorHeight: () => mirrorHeight,
      mirrorWidth: () => mirrorWidth,
    };
  }

  it('copies wrapping geometry to the mirror and writes only the final live pixel height', () => {
    const sample = fixture();
    const result = resizeComposerTextarea(sample.visible, sample.mirror, sample.computed);

    expect(result).toEqual({ previousHeight: '36px', nextHeight: '86px' });
    expect(sample.visibleWrites).toEqual(['86px']);
    expect(sample.visibleWrites).not.toContain('auto');
    expect(sample.visibleWrites).not.toContain('0px');
    expect(sample.mirrorWrites).toEqual(['0px']);
    expect(sample.mirror.value).toBe(sample.visible.value);
    expect(sample.mirrorWidth()).toBe('320px');
    expect(Object.fromEntries(sample.mirroredProperties)).toMatchObject({
      'box-sizing': 'border-box',
      'font-family': 'Inter',
      'font-size': '16px',
      'line-height': '24px',
      'white-space': 'pre-wrap',
      'overflow-wrap': 'break-word',
    });
  });

  it('grows, shrinks, resets empty content, and preserves the eight-row cap', () => {
    const sample = fixture({ scrollHeight: 120 });
    resizeComposerTextarea(sample.visible, sample.mirror, sample.computed);
    expect(sample.visibleHeight()).toBe('122px');

    sample.mirror.scrollHeight = 36;
    sample.visible.value = 'short';
    resizeComposerTextarea(sample.visible, sample.mirror, sample.computed);
    expect(sample.visibleHeight()).toBe('38px');

    sample.mirror.scrollHeight = 30;
    sample.visible.value = '';
    resizeComposerTextarea(sample.visible, sample.mirror, sample.computed);
    expect(sample.visibleHeight()).toBe('38px');

    sample.mirror.scrollHeight = 600;
    sample.visible.value = 'pasted wrapped content '.repeat(80);
    resizeComposerTextarea(sample.visible, sample.mirror, sample.computed);
    expect(sample.visibleHeight()).toBe('206px');
    expect(sample.visibleWrites.every((height) => /^\d+px$/.test(height))).toBe(true);
  });

  it('converts mirror scroll height to the live content box when required', () => {
    const sample = fixture({ boxSizing: 'content-box', scrollHeight: 84 });
    resizeComposerTextarea(sample.visible, sample.mirror, sample.computed);
    expect(sample.visibleHeight()).toBe('72px');
  });
});
// harn:end composer-autogrow-measures-offscreen-before-live-height

// harn:assume exact-trailing-mentions-send-before-completion ref=exact-trailing-mention-regression
describe('exact trailing mention precedence', () => {
  const member = {
    id: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
    handle: 'sol',
    display_name: 'Sol',
    kind: 'agent' as const,
    state: 'idle' as const,
    custody: 'owned' as const,
    conventions_sent: true,
    misaddressed: false,
    roster_stale: false,
  };

  it('recognizes only a complete local handle', () => {
    expect(exactLocalMention({ query: 'sol' }, [member])).toBe(true);
    expect(exactLocalMention({ query: 'so' }, [member])).toBe(false);
  });

  it('recognizes only a complete qualified selector and handle', () => {
    const routingMember = { member_id: member.id, handle: member.handle, kind: member.kind };
    const candidate = {
      target: {
        worktree_id: '01J00000000000000000000001',
        conversation_id: 'wt-review',
        alias: 'review',
        primary: false,
        lifecycle: 'active' as const,
        members: [routingMember],
      },
      member: routingMember,
    };
    expect(exactQualifiedMention({ start: 0, aliasQuery: 'review', handleQuery: 'sol' }, [candidate]))
      .toBe(true);
    expect(exactQualifiedMention({ start: 0, aliasQuery: 'rev', handleQuery: 'sol' }, [candidate]))
      .toBe(false);
    expect(exactQualifiedMention({ start: 0, aliasQuery: 'review', handleQuery: 'so' }, [candidate]))
      .toBe(false);
  });
});
// harn:end exact-trailing-mentions-send-before-completion

// harn:assume pending-composer-echo-is-destination-and-self-bound ref=destination-self-echo-regression
describe('pending composer echo ownership', () => {
  const message = (id: number, author: string, body = 'same qualified body') => ({
    id,
    room: 'wt-review',
    author,
    kind: 'chat' as const,
    body,
    mentions: [],
    refs: [],
    ledger_refs: [],
    ts: '2026-08-11T00:00:00.000Z',
    seq: id,
  });

  it('settles only for a new exact-body echo from the destination self member', () => {
    const pending = {
      body: 'same qualified body',
      knownMessageIds: new Set([1]),
      authorId: 'owner-review',
    };
    expect(hasOwnPendingComposerEcho({ 1: message(1, 'owner-review') }, pending)).toBe(false);
    expect(hasOwnPendingComposerEcho({ 2: message(2, 'reviewer') }, pending)).toBe(false);
    expect(hasOwnPendingComposerEcho({ 2: message(2, 'owner-review', 'different body') }, pending))
      .toBe(false);
    expect(hasOwnPendingComposerEcho({ 2: message(2, 'owner-review') }, pending)).toBe(true);
    expect(hasOwnPendingComposerEcho({ 2: message(2, 'owner-review') }, { ...pending, authorId: undefined }))
      .toBe(false);
  });

  it('selects only the destination message map across background-room churn', () => {
    const destination = { 7: message(7, 'owner-review') };
    const before = {
      rooms: {
        root: { messages: {} },
        'wt-review': { messages: destination },
        'wt-plan': { messages: {} },
      },
    };
    const afterBackgroundActivity = {
      rooms: {
        ...before.rooms,
        'wt-plan': { messages: { 8: message(8, 'planner', 'background update') } },
      },
    };
    expect(selectPendingDestinationMessages(before, 'wt-review')).toBe(destination);
    expect(selectPendingDestinationMessages(afterBackgroundActivity, 'wt-review')).toBe(destination);
    expect(selectPendingDestinationMessages(afterBackgroundActivity, undefined)).toBeUndefined();
  });
});
// harn:end pending-composer-echo-is-destination-and-self-bound

// harn:assume composer-acknowledgement-separates-raw-draft-from-canonical-echo ref=raw-draft-acknowledgement-regression
describe('raw composer acknowledgement ownership', () => {
  const message = (id: number, author: string, body: string) => ({
    id,
    room: 'eng',
    author,
    kind: 'chat' as const,
    body,
    mentions: [],
    refs: [],
    ledger_refs: [],
    ts: '2026-08-12T00:00:00.000Z',
    seq: id,
  });

  const pending = (rawBody: string) => ({
    ...composerDispatchSnapshot(rawBody),
    targetRoom: 'eng',
    knownMessageIds: new Set<number>(),
    authorId: 'owner-eng',
    errorCount: 0,
  });

  it.each([
    'please investigate @sol ',
    'please investigate ~review:@sol ',
  ])('correlates the canonical self echo but clears the exact raw snapshot (%s)', (rawBody) => {
    const send = pending(rawBody);
    expect(send.body).toBe(rawBody.trim());
    expect(pendingComposerResolution(
      { 1: message(1, 'owner-eng', send.body) }, send, rawBody, 0,
    )).toBe('clear');
  });

  it('preserves an edit made after dispatch even when the canonical self echo arrives', () => {
    const send = pending('please investigate @sol ');
    expect(pendingComposerResolution(
      { 1: message(1, 'owner-eng', send.body) }, send, 'please investigate @sol — adding context', 0,
    )).toBe('preserve');
  });

  it('does not correlate identical canonical prose from another author', () => {
    const send = pending('please investigate @sol ');
    expect(pendingComposerResolution(
      { 1: message(1, 'sol', send.body) }, send, send.rawBody, 0,
    )).toBeUndefined();
  });

  it('canonicalizes surrounding whitespace while retaining whitespace-only raw ownership', () => {
    expect(composerDispatchSnapshot('  please investigate @sol \n')).toEqual({
      rawBody: '  please investigate @sol \n',
      body: 'please investigate @sol',
    });
    expect(composerDispatchSnapshot(' \n\t ')).toEqual({ rawBody: ' \n\t ', body: '' });
  });

  it('preserves the raw draft when the server reports a refusal or transport error', () => {
    const send = pending('please investigate @sol ');
    expect(pendingComposerResolution(undefined, send, send.rawBody, 1)).toBe('error');
  });
});
// harn:end composer-acknowledgement-separates-raw-draft-from-canonical-echo

describe('composeVoiceBody', () => {
  it('prefixes the recipient mention before the plain transcript — no marker glyphs', () => {
    expect(composeVoiceBody('opus', ['first thought', 'second thought']))
      .toBe('@opus first thought\nsecond thought');
  });

  it('newline-joins every segment', () => {
    expect(composeVoiceBody('opus', ['a', 'b', 'c'])).toBe('@opus a\nb\nc');
  });

  it('omits the mention entirely when unaddressed — never a dangling @', () => {
    expect(composeVoiceBody(undefined, ['solo'])).toBe('solo');
  });
});

describe('deriveVoiceRecipientHandle', () => {
  const roster = ['fable', 'opus', 'codex'];

  it('uses the first roster member @-mentioned in the draft', () => {
    expect(deriveVoiceRecipientHandle('hey @codex look at this', roster, 'fable')).toBe('codex');
  });

  it('is case-insensitive and skips non-roster mentions', () => {
    expect(deriveVoiceRecipientHandle('@nobody then @Opus', roster, 'fable')).toBe('opus');
  });

  it('falls back to the effective default when no roster member is mentioned', () => {
    expect(deriveVoiceRecipientHandle('just typing', roster, 'fable')).toBe('fable');
  });

  it('is unaddressed when the draft has no mention and there is no fallback', () => {
    expect(deriveVoiceRecipientHandle('nothing here', roster, undefined)).toBeUndefined();
  });
});

// harn:assume qualified-completion-lists-registered-targets-only ref=qualified-composer-completion-regression
describe('qualified composer completion', () => {
  const catalog = {
    room: 'eng',
    targets: [
      {
        worktree_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        conversation_id: 'eng',
        alias: 'main',
        primary: true,
        lifecycle: 'active' as const,
        members: [{ member_id: '01BX5ZZKBKACTAV9WEVGEMMVRZ', handle: 'coder', kind: 'agent' as const }],
      },
      {
        worktree_id: '01J00000000000000000000001',
        conversation_id: 'wt-review',
        alias: 'review',
        primary: false,
        lifecycle: 'active' as const,
        members: [{ member_id: '01J00000000000000000000002', handle: 'coder', kind: 'agent' as const }],
      },
    ],
    tombstones: [{
      worktree_id: '01J00000000000000000000003', conversation_id: 'wt-old', alias: 'old', lifecycle: 'removed' as const,
    }],
  };

  it('filters registered main/secondary identities and inserts the full scoped token', () => {
    const draft = 'ask ~r:@co';
    const query = qualifiedMentionQuery(draft, draft.length)!;
    expect(query).toEqual({ start: 4, aliasQuery: 'r', handleQuery: 'co' });
    const candidates = qualifiedCompletionCandidates(catalog, query);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ target: { alias: 'review' }, member: { handle: 'coder' } });
    const inserted = insertQualifiedMentionText(draft, query, candidates[0]!, draft.length);
    expect(inserted.text).toBe('ask ~review:@coder ');
    expect(inserted.caret).toBe(inserted.text.length);

    const both = qualifiedCompletionCandidates(catalog, {
      start: 0, aliasQuery: '', handleQuery: 'cod',
    });
    expect(both.map((candidate) => `~${candidate.target.alias}:@${candidate.member.handle}`))
      .toEqual(['~main:@coder', '~review:@coder']);
  });

  it('keeps duplicate handles distinct by target and never suggests tombstones', () => {
    const query = qualifiedMentionQuery('~:@co', 5)!;
    expect(query).toEqual({ start: 0, aliasQuery: '', handleQuery: 'co' });
    const candidates = qualifiedCompletionCandidates(catalog, query);
    expect(candidates.map((candidate) => `~${candidate.target.alias}:@${candidate.member.handle}`))
      .toEqual(['~main:@coder', '~review:@coder']);
    expect(candidates.some((candidate) => candidate.target.alias === 'old')).toBe(false);
  });

  it('uses UTF-16 caret offsets while preserving the surrounding draft on insertion', () => {
    const draft = `😀😀 ask ~r:@co`;
    const query = qualifiedMentionQuery(draft, draft.length)!;
    expect(query).toEqual({ start: 9, aliasQuery: 'r', handleQuery: 'co' });
    const completion = qualifiedCompletionCandidates(catalog, query)[0]!;
    expect(insertQualifiedMentionText(draft, query, completion, draft.length)).toEqual({
      text: '😀😀 ask ~review:@coder ',
      caret: 24,
    });
  });

  it('suggests nothing for an ordinary channel empty catalog', () => {
    const query = qualifiedMentionQuery('~:@co', 5)!;
    expect(qualifiedCompletionCandidates({ room: 'eng', targets: [], tombstones: [] }, query))
      .toEqual([]);
  });
});
// harn:end qualified-completion-lists-registered-targets-only

// harn:assume invalid-qualified-targets-never-fallback ref=qualified-composer-refusal-regression
describe('qualified composer refusal', () => {
  it.each(['wait ~5 minutes', '~/tmp is a path', '~approximately done'])
    ('leaves ordinary tilde prose routable (%s)', (draft) => {
      const parsed = parseBody(draft, [], {
        qualifiedTargets: { room: 'eng', targets: [], tombstones: [] },
      });
      expect(parsed.qualified).toBeUndefined();
      expect(parsed.qualified_issues).toBeUndefined();
      expect(parsed.mentions).toEqual([]);
    });

  it.each([
    'x~review:@codex',
    '~review :@codex',
    '~ review:@codex',
    '~review: @codex',
    '~:@codex',
    '~ :@codex',
    '~review::@codex',
    '~review: :@codex',
    '~review:\n@codex',
    '~\nreview:@codex',
    '~review:\r\n@codex',
    '~review:',
    '~review:@',
    '~:',
    '~ :',
    '~::',
    '~ ::',
  ])('owns malformed scoped syntax without leaking the inner mention (%s)', (draft) => {
    const parsed = parseBody(draft, [{
      id: '01J00000000000000000000010', kind: 'agent', handle: 'codex',
      display_name: 'Codex', state: 'idle', custody: 'owned',
      conventions_sent: false, misaddressed: false, roster_stale: true,
    }], {
      qualifiedTargets: { room: 'eng', targets: [], tombstones: [] },
    });
    expect(parsed.mentions).toEqual([]);
    expect(parsed.qualified).toEqual([]);
    expect(parsed.qualified_issues).toEqual([
      expect.objectContaining({ reason: 'malformed' }),
    ]);
    expect(draft).toContain(parsed.qualified_issues![0]!.token);
  });

  it('keeps an unknown scoped target as a structured issue for inline draft feedback', () => {
    const parsed = parseBody('~missing:@coder keep this draft', [], {
      qualifiedTargets: { room: 'eng', targets: [], tombstones: [] },
    });
    expect(parsed.qualified).toEqual([]);
    expect(parsed.qualified_issues).toEqual([
      expect.objectContaining({ token: '~missing:@coder', reason: 'unknown-worktree' }),
    ]);
    expect('~missing:@coder keep this draft').toContain(parsed.qualified_issues![0]!.token);
  });

  it.each([
    ['~old:@coder', 'removed-worktree'],
    ['~unregistered:@coder', 'unregistered-worktree'],
    ['~review: @coder', 'malformed'],
  ] as const)('keeps %s as a visible non-fallback issue (%s)', (draft, reason) => {
    const parsed = parseBody(draft, [], {
      qualifiedTargets: {
        room: 'eng', targets: [], tombstones: [
          { worktree_id: '01J00000000000000000000004', conversation_id: 'wt-old', alias: 'old', lifecycle: 'removed' },
          { worktree_id: '01J00000000000000000000005', conversation_id: 'wt-unregistered', alias: 'unregistered', lifecycle: 'unregistered' },
        ],
      },
    });
    expect(parsed.qualified).toEqual([]);
    expect(parsed.mentions).toEqual([]);
    expect(parsed.qualified_issues).toEqual([expect.objectContaining({ token: expect.stringContaining(draft.slice(0, draft.indexOf(':'))), reason })]);
    expect(draft).toContain(parsed.qualified_issues![0]!.token);
  });
});
// harn:end invalid-qualified-targets-never-fallback
