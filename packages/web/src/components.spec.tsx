import type { Member, Message, WireEvent } from '@wireroom/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  AskCardView,
  Header,
  MemberCard,
  MessageRow,
  extensionRunSummaries,
  ledgerTextSegments,
  mentionMatchAtCaret,
  RunMessageView,
  RunStallBadge,
  SPAWN_PRESETS,
  availableAgentHandle,
} from './components.js';
import type { Connection } from './ws.js';

const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const TS = '2026-07-10T07:00:00.000Z';

const richard: Member = {
  id: ULID_A,
  kind: 'human',
  handle: 'richard',
  display_name: 'Richard',
  role: 'owner',
  conventions_sent: false,
  misaddressed: false,
  roster_stale: false,
};
const alpha: Member = {
  id: ULID_B,
  kind: 'agent',
  handle: 'alpha',
  display_name: 'Alpha',
  conventions_sent: false,
  misaddressed: false,
  roster_stale: false,
};
const members = { [ULID_A]: richard, [ULID_B]: alpha };

const finalizedRun: Message = {
  id: 7,
  room: 'eng',
  author: ULID_B,
  kind: 'run',
  body: 'shipped it',
  mentions: [],
  refs: [],
  ledger_refs: [],
  ts: TS,
  seq: 9,
  run: {
    status: 'completed',
    started_ts: TS,
    ended_ts: TS,
    tool_calls: 2,
    usage: { input_tokens: 100, output_tokens: 20, cost_usd: 0.19 },
    events_ref: 'runs/7.jsonl',
    final_text: 'shipped it',
  },
};

const noopConnection: Connection = {
  post: () => undefined,
  act: () => undefined,
  disconnect: () => undefined,
  reconnect: () => undefined,
};

// harn:assume web-spawn-dialog-exposes-canonical-agent-controls ref=spawn-dialog-unit-regression
describe('spawn presets', () => {
  it('keeps the five operator presets exact and fully editable', () => {
    expect(SPAWN_PRESETS).toEqual({
      coder: {
        handle: 'coder',
        purpose: "Implements code changes in this channel's project",
        policy: 'workspace-write',
        thinking: 'medium',
      },
      reviewer: {
        handle: 'reviewer',
        purpose: 'Reviews diffs and flags defects; never edits',
        policy: 'read-only',
        thinking: 'high',
      },
      planner: {
        handle: 'planner',
        purpose: 'Investigates and writes implementation plans',
        policy: 'read-only',
        thinking: 'high',
      },
      writer: {
        handle: 'writer',
        purpose: 'Writes and edits documentation and prose',
        policy: 'workspace-write',
        thinking: 'low',
      },
      tester: {
        handle: 'tester',
        purpose: 'Runs tests, reproduces bugs, reports results',
        policy: 'workspace-write',
        thinking: 'medium',
      },
    });
  });

  it('suffixes active collisions and ignores removed tombstones', () => {
    const tester = { ...alpha, id: '01BX5ZZKBKACTAV9WEVGEMMVS0', handle: 'tester' };
    const tester2 = { ...alpha, id: '01BX5ZZKBKACTAV9WEVGEMMVS1', handle: 'tester-2' };
    expect(availableAgentHandle('tester', [richard, tester, tester2])).toBe('tester-3');
    expect(availableAgentHandle('tester', [richard, { ...tester, removed_ts: TS }])).toBe('tester');
  });
});
// harn:end web-spawn-dialog-exposes-canonical-agent-controls

// harn:assume literal-draft-recipient-visible-before-send ref=composer-recipient-unit-regression
describe('mentionMatchAtCaret', () => {
  it('orders agents before humans and filters by the caret prefix', () => {
    expect(mentionMatchAtCaret('@', 1, [richard, alpha])?.candidates.map((member) => member.handle))
      .toEqual(['alpha', 'richard']);
    expect(mentionMatchAtCaret('ask @r', 6, [richard, alpha])).toMatchObject({
      start: 4,
      end: 6,
      query: 'r',
      candidates: [expect.objectContaining({ handle: 'richard' })],
    });
  });

  it('uses the shared parser to reject code mentions and removed candidates', () => {
    expect(mentionMatchAtCaret('`@a`', 3, [alpha])).toBeUndefined();
    expect(mentionMatchAtCaret('@', 1, [{ ...alpha, removed_ts: TS }])).toBeUndefined();
  });
});
// harn:end literal-draft-recipient-visible-before-send

describe('RunMessageView', () => {
  it('renders the live header while running', () => {
    const running: Message = {
      ...finalizedRun,
      body: '',
      run: {
        status: 'running',
        started_ts: TS,
        stalled_since: TS,
        tool_calls: 0,
        events_ref: 'runs/7.jsonl',
      },
    };
    const html = renderToStaticMarkup(
      <RunMessageView
        message={running}
        authorHandle="alpha"
        liveEvents={{
          dropped_count: 0,
          events: [
            {
              type: 'run.item', item_type: 'tool_call',
              payload: { call_id: 'bash-1', tool: 'Bash', title: 'pnpm test' },
            },
          ],
        }}
        room="eng"
        token="t"
      />,
    );
    expect(html).toContain('running · ');
    expect(html).toContain(' · Bash');
    expect(html).toContain('pnpm test');
    expect(html).not.toContain('Run started');
    expect(html).toContain('data-run-status="running"');
    expect(renderToStaticMarkup(<RunStallBadge message={running} />)).toContain(
      'data-testid="run-7-stalled"',
    );
  });

  it('renders the finalized body, status, tokens, and cost in place', () => {
    const html = renderToStaticMarkup(
      <RunMessageView
        message={finalizedRun}
        authorHandle="alpha"
        liveEvents={{ events: [], dropped_count: 0 }}
        room="eng"
        token="t"
      />,
    );
    expect(html).toContain('shipped it');
    expect(html).toContain('completed');
    expect(html).toContain('2 tools');
    expect(html).toContain('$0.19');
    expect(html).toContain('#7');
    expect(html).toContain('id="7"');
    expect(html).toContain('href="#7"');
  });
});

describe('AskCardView', () => {
  const card: Message = {
    ...finalizedRun,
    id: 9,
    kind: 'ask',
    body: 'Which codeword?',
    run: undefined,
    ask: {
      interaction_id: 'native-1',
      kind: 'ask',
      prompt: 'Which codeword?',
      options: [{ label: 'ALPHA' }, { label: 'BETA' }],
    },
  };

  it('renders the prompt with an option button per choice', () => {
    const html = renderToStaticMarkup(
      <AskCardView message={card} authorHandle="alpha" answered={false} connection={noopConnection} />,
    );
    expect(html).toContain('Which codeword?');
    expect(html).toContain('card-9-option-ALPHA');
    expect(html).toContain('card-9-option-BETA');
    expect(html).toContain('id="9"');
    expect(html).toContain('href="#9"');
    expect(html).not.toContain('answered');
  });

  it('an answered card disables its options', () => {
    const html = renderToStaticMarkup(
      <AskCardView message={card} authorHandle="alpha" answered={true} connection={noopConnection} />,
    );
    expect(html).toContain('disabled');
    expect(html).toContain('answered');
  });
});

describe('MessageRow', () => {
  it('renders matching numeric fragment ids and visible permalinks', () => {
    const chat = { ...finalizedRun, kind: 'chat' as const, run: undefined };
    const html = renderToStaticMarkup(
      <MessageRow message={chat} authorHandle="alpha" mine={false} />,
    );
    expect(html).toContain('id="7"');
    expect(html).toContain('href="#7"');
    expect(html).toContain('Permalink to message 7');
  });

  it('renders ledger refs as note-viewer buttons without disturbing surrounding text', () => {
    const chat = {
      ...finalizedRun,
      kind: 'chat' as const,
      run: undefined,
      body: 'Honor [[risk-limits]] before shipping.',
      ledger_refs: ['risk-limits'],
    };
    expect(ledgerTextSegments(chat.body)).toEqual([
      { kind: 'text', text: 'Honor ' },
      { kind: 'ledger', name: 'risk-limits', text: '[[risk-limits]]' },
      { kind: 'text', text: ' before shipping.' },
    ]);
    const html = renderToStaticMarkup(
      <MessageRow message={chat} authorHandle="alpha" mine={false} />,
    );
    expect(html).toContain('data-testid="ledger-ref-risk-limits"');
    expect(html).toContain('[[risk-limits]]');
  });
});

describe('Header', () => {
  it('shows an honest zero-state meter before the first usage frame', () => {
    const html = renderToStaticMarkup(
      <Header
        roomName="Eng"
        roomId="eng"
        token="t"
        connected={true}
        meter={undefined}
        unread={0}
      />,
    );
    expect(html).toContain('data-testid="meter"');
    expect(html).toContain('0 turns');
    expect(html).toContain('0 tokens');
    expect(html).toContain('$0.00');
  });

  it('shows the meter and the unread inbox badge', () => {
    const html = renderToStaticMarkup(
      <Header
        roomName="Eng"
        roomId="eng"
        token="t"
        connected={true}
        meter={{
          room: 'eng',
          day: '2026-07-10',
          turns: 4,
          cost_usd: 1.5,
          input_tokens: 60,
          output_tokens: 27,
          uncosted_tokens: 75,
        }}
        unread={2}
      />,
    );
    expect(html).toContain('4 turns');
    expect(html).toContain('87 tokens');
    expect(html).toContain('$1.50');
    expect(html).toContain('75 tokens uncosted');
    expect(html).toContain('data-testid="room-settings"');
    expect(html).toContain('/settings?room=eng');
    expect(html).not.toContain('token=t');
    expect(html).toContain('inbox');
    expect(html).toContain('>2<');
  });
});

describe('MemberCard', () => {
  it('shows session identity, spend, queue count, state history, and lifecycle actions', () => {
    const member: Member = {
      ...alpha,
      harness: 'fake',
      session_ref: 'fake-session-1',
      cwd: '/work/review',
      policy: 'read-only',
      state: 'paused',
    };
    const html = renderToStaticMarkup(
      <MemberCard
        member={member}
        detail={{
          member,
          queued_count: 2,
          spend: {
            turns: 3,
            input_tokens: 120,
            output_tokens: 30,
            cost_usd: 0.12,
            uncosted_tokens: 30,
          },
        }}
        history={[
          { state: 'idle', ts: TS },
          { state: 'running', ts: TS },
          { state: 'paused', ts: TS },
        ]}
        connection={noopConnection}
      />,
    );
    expect(html).toContain('fake-session-1');
    expect(html).toContain('/work/review');
    expect(html).toContain('$0.12');
    expect(html).toContain('150 tk');
    expect(html).toContain('30 uncosted');
    expect(html).toContain('2 queued');
    expect(html).toContain('idle &gt; running &gt; paused');
    expect(html).toContain('Unpause');
    expect(html).toContain('data-testid="attach-command-alpha"');
    expect(html).toContain('wireroom attach @alpha');
  });

  it('labels mirrored custody and exposes explicit adoption instead of drive controls', () => {
    const member: Member = {
      ...alpha,
      harness: 'codex',
      session_ref: 'thread-1',
      cwd: '/work',
      state: 'queued',
      custody: 'mirrored',
    };
    const html = renderToStaticMarkup(
      <MemberCard member={member} detail={undefined} history={[]} connection={noopConnection} />,
    );
    expect(html).toContain('mirrored');
    expect(html).toContain('data-testid="adopt-alpha"');
    expect(html).not.toContain('data-testid="kill-alpha"');
    expect(html).not.toContain('data-testid="pause-alpha"');
    expect(html).not.toContain('attach-command-alpha');
  });
});

describe('extension run summaries', () => {
  it('collapses mapped start and stop events into one nested parent-run row', () => {
    const events: WireEvent[] = [
      {
        type: 'extension.started',
        parent: ULID_B,
        ext_member: ULID_A,
        description: 'Inspect cache invalidation',
        agent_type: 'general-purpose',
      },
      {
        type: 'extension.ended',
        ext_member: ULID_A,
        summary: 'Cache paths are safe.',
        transcript_path: '/tmp/agent.jsonl',
      },
    ];
    expect(extensionRunSummaries(events)).toEqual([
      {
        id: ULID_A,
        description: 'Inspect cache invalidation',
        agentType: 'general-purpose',
        transcriptPath: '/tmp/agent.jsonl',
        summary: 'Cache paths are safe.',
        ended: true,
      },
    ]);
  });
});
