// @vitest-environment happy-dom
import { parseBody } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import {
  composeVoiceBody,
  deriveVoiceRecipientHandle,
  insertQualifiedMentionText,
  qualifiedCompletionCandidates,
  qualifiedMentionQuery,
} from './Composer.js';

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
});
// harn:end qualified-completion-lists-registered-targets-only

// harn:assume invalid-qualified-targets-never-fallback ref=qualified-composer-refusal-regression
describe('qualified composer refusal', () => {
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
});
// harn:end invalid-qualified-targets-never-fallback
