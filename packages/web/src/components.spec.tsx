import type { Member, Message, WireEvent } from '@wireroom/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  AskCardView,
  Header,
  MemberCard,
  extensionRunSummaries,
  impliedRecipient,
  RunMessageView,
  RunStallBadge,
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
};
const alpha: Member = {
  id: ULID_B,
  kind: 'agent',
  handle: 'alpha',
  display_name: 'Alpha',
  conventions_sent: false,
  misaddressed: false,
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

describe('impliedRecipient (invariant 3: visible before send)', () => {
  const runMessages = { 7: finalizedRun };

  it('explicit mentions win', () => {
    expect(impliedRecipient('@alpha and @richard look', members, runMessages)).toEqual({
      kind: 'mentions',
      label: '→ @alpha @richard',
    });
  });

  it('uses the router grammar for fenced-code escaping', () => {
    expect(impliedRecipient('```\n@richard\n```\ncontinue', members, runMessages)).toEqual({
      kind: 'default',
      label: '→ @alpha (untagged default)',
    });
  });

  it('untagged drafts show the latest FINALIZED agent as the default', () => {
    expect(impliedRecipient('looks good, continue', members, runMessages)).toEqual({
      kind: 'default',
      label: '→ @alpha (untagged default)',
    });
  });

  it('a running placeholder does not count as a default target', () => {
    const running = {
      7: { ...finalizedRun, run: { ...finalizedRun.run!, status: 'running' as const } },
    };
    expect(impliedRecipient('anyone?', members, running).kind).toBe('commentary');
  });

  it('no finalized agent ever → room commentary', () => {
    expect(impliedRecipient('morning', members, {})).toEqual({
      kind: 'commentary',
      label: 'room commentary — delivered to nobody',
    });
  });

  it('unknown handles do not select recipients', () => {
    expect(impliedRecipient('@nosuch hello', members, {}).kind).toBe('commentary');
  });
});

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
      <RunMessageView message={running} authorHandle="alpha" liveEventCount={3} room="eng" token="t" />,
    );
    expect(html).toContain('running · 3 events');
    expect(html).toContain('data-run-status="running"');
    expect(renderToStaticMarkup(<RunStallBadge message={running} />)).toContain(
      'data-testid="run-7-stalled"',
    );
  });

  it('renders the finalized body, status, tokens, and cost in place', () => {
    const html = renderToStaticMarkup(
      <RunMessageView message={finalizedRun} authorHandle="alpha" liveEventCount={0} room="eng" token="t" />,
    );
    expect(html).toContain('shipped it');
    expect(html).toContain('completed');
    expect(html).toContain('120 tk');
    expect(html).toContain('$0.19');
    expect(html).toContain('#7');
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

describe('Header', () => {
  it('shows the meter and the unread inbox badge', () => {
    const html = renderToStaticMarkup(
      <Header
        roomName="Eng"
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
        config={{ turn_brake: null, spend_brake_usd: null, stall_minutes: 30, redaction_enabled: true }}
        connection={noopConnection}
      />,
    );
    expect(html).toContain('4 turns');
    expect(html).toContain('$1.50');
    expect(html).toContain('75 tokens uncosted');
    expect(html).toContain('data-testid="room-settings"');
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
