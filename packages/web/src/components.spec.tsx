import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';

import type { Member, Message, WireEvent } from '@codor/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  AskCardView,
  InboxPanel,
  draftRoutesToNobody,
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

// harn:assume literal-draft-effective-recipient-visible ref=composer-recipient-unit-regression
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

  it('identifies only nonempty drafts that truly have no recipient', () => {
    expect(draftRoutesToNobody('', [richard, alpha])).toBe(false);
    expect(draftRoutesToNobody('hello', [richard])).toBe(true);
    expect(draftRoutesToNobody('hello', [richard, alpha], alpha.id, richard.id)).toBe(false);
    expect(draftRoutesToNobody('@alpha hello', [richard, alpha], undefined, richard.id)).toBe(false);
    expect(draftRoutesToNobody('@richard note', [richard], undefined, richard.id)).toBe(true);
    expect(draftRoutesToNobody(
      '@alpha hello',
      [richard, { ...alpha, removed_ts: TS }],
      undefined,
      richard.id,
    )).toBe(true);
  });
});
// harn:end literal-draft-effective-recipient-visible

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
    expect(html).toContain('>running</span>');
    expect(html).toContain('wr-run-separator');
    expect(html).toContain('>Bash</span>');
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

  // harn:assume acknowledgement-marker-protocol ref=ack-web-regression
  it('renders acknowledgements as one muted permalinked line without a toggle', () => {
    const html = renderToStaticMarkup(
      <RunMessageView
        message={{ ...finalizedRun, body: '<ACK_OK>', ack: true }}
        authorHandle="alpha"
        liveEvents={{ events: [], dropped_count: 0 }}
        room="eng"
        token="t"
      />,
    );
    expect(html).toContain('data-testid="ack-alpha"');
    expect(html).toContain('@alpha acknowledged');
    expect(html).toContain('href="#7"');
    expect(html).not.toContain('run-7-toggle');
  });
  // harn:end acknowledgement-marker-protocol
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

  // harn:assume phone-first-interaction-cards ref=phone-ask-card-regression
  it('leads with what is being asked and who is asking', () => {
    const approval: Message = {
      ...card,
      ask: {
        interaction_id: 'native-2',
        kind: 'approval',
        prompt: 'Run this command?',
        tool: 'Bash',
        detail: 'rm -rf ./build && pnpm build',
        options: [{ label: 'Allow' }, { label: 'Deny' }],
      },
    };
    const html = renderToStaticMarkup(
      <AskCardView message={approval} authorHandle="alpha" answered={false} connection={noopConnection} />,
    );
    expect(html).toContain('APPROVAL NEEDED');
    expect(html).toContain('@alpha');
    expect(html).toContain('Bash');
    // The command is the point of the card — it must be present in full.
    expect(html).toContain('rm -rf ./build &amp;&amp; pnpm build');
  });

  it('calls a question a question', () => {
    const html = renderToStaticMarkup(
      <AskCardView message={card} authorHandle="alpha" answered={false} connection={noopConnection} />,
    );
    expect(html).toContain('QUESTION');
    expect(html).not.toContain('APPROVAL NEEDED');
  });

  it('keeps an answered card visible, only muted', () => {
    const html = renderToStaticMarkup(
      <AskCardView message={card} authorHandle="alpha" answered connection={noopConnection} />,
    );
    // The operator must still be able to see what they approved.
    expect(html).toContain('is-answered');
    expect(html).toContain('Which codeword?');
    expect(html).toContain('card-9-answered');
  });
  // harn:end phone-first-interaction-cards

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
        adapters={[]}
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
    expect(html).toContain('codor attach @alpha');
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
      <MemberCard member={member} detail={undefined} history={[]} adapters={[]} connection={noopConnection} />,
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

// harn:assume no-human-surface-says-switchboard ref=switchboard-phrase-gate
describe('product vocabulary', () => {
  // The word is legitimate as a machine identifier — `switchboard_sign_pub` in the
  // pairing link, the `peer:switchboard` IndexedDB key, the BrowserPeer.kind
  // discriminant — and renaming those would break the wire and the stored pairing.
  // It is never legitimate as something a human reads. A substring grep cannot tell
  // those apart, which is exactly how the previous gate passed while the channel rail
  // said "Live on this switchboard": it only ever looked for the footer's phrase.
  // So parse instead of grep, and judge only what the parser says is human text.
  const humanStrings = (file: string): string[] => {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      // An import specifier is a module path, not copy.
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) found.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };

  // A standalone word, so `switchboard_sign_pub` and `wr-switchboard-identity` are
  // identifiers and pass; and prose, so the single-token key 'peer:switchboard' passes
  // while any sentence containing the word does not.
  const saysIt = (text: string): boolean =>
    /(?<![\w-])switchboard(?![\w-])/i.test(text) && /\s/.test(text.trim());

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(path);
      return /\.tsx?$/.test(entry.name) && !entry.name.includes('.spec.') ? [path] : [];
    });

  it('never calls itself a switchboard in anything a human reads', () => {
    const offenders = walk('src').flatMap((file) =>
      humanStrings(file).filter(saysIt).map((text) => `${file}: ${JSON.stringify(text.trim())}`),
    );
    expect(offenders, 'these strings are read by a human and call the product a switchboard').toEqual([]);
  });

  it('still allows the word as a machine identifier', () => {
    // Guards the gate itself: if this ever fails, the gate has become a blunt grep
    // and the next person will "fix" it by renaming a wire field.
    expect(saysIt('peer:switchboard')).toBe(false);
    expect(saysIt('switchboard_sign_pub')).toBe(false);
    expect(saysIt('wr-switchboard-identity')).toBe(false);
    expect(saysIt('Live on this switchboard')).toBe(true);
    expect(saysIt('The switchboard isn’t answering.')).toBe(true);
  });
});

// harn:assume the-inbox-opens-what-needs-you ref=inbox-panel-regression
describe('InboxPanel', () => {
  const items = [
    { id: 12, authorHandle: 'alpha', tool: 'Bash', prompt: 'Run the migration?', ageMs: 120_000 },
  ];

  it('lists who is waiting, on what, and for how long', () => {
    const html = renderToStaticMarkup(
      <InboxPanel items={items} onSelect={() => undefined} onClose={() => undefined} />,
    );
    expect(html).toContain('@alpha');
    expect(html).toContain('Bash');
    expect(html).toContain('Run the migration?');
    expect(html).toContain('2m ago');
    expect(html).toContain('inbox-item-12');
  });

  it('says so plainly when nothing needs the operator', () => {
    const html = renderToStaticMarkup(
      <InboxPanel items={[]} onSelect={() => undefined} onClose={() => undefined} />,
    );
    expect(html).toContain('Nothing needs you.');
  });
});

// harn:assume timeline-rows-are-never-crushed ref=timeline-crush-unit-gate
describe('timeline rows are content, not flexible space', () => {
  // Layout itself is asserted in the browser, where there is a real flex algorithm.
  // This gate guards the RULE: it must exist, and nothing may quietly hand a timeline
  // row its shrinkability back. Deleting the rule, or re-enabling shrink on any row,
  // fails here long before it reaches a phone.
  const css = readFileSync('src/styles.css', 'utf8');

  it('forbids every direct child of the timeline from shrinking', () => {
    const rule = /\.wr-timeline\s*>\s*\*\s*\{[^}]*flex-shrink:\s*0[^}]*\}/.exec(css);
    expect(rule, '.wr-timeline > * must set flex-shrink: 0').not.toBeNull();
  });

  it('lets no later rule give a timeline row its shrink back', () => {
    // A rule that targets a timeline child and sets a nonzero flex-shrink would
    // re-open the exact hole F10 came through — the ask card was crushable only
    // because it was the one child the flex algorithm was permitted to shrink.
    // Read the VALUE rather than lookahead past it: `flex-shrink:\s*(?!0)` backtracks
    // to zero whitespace and then happily reports that a space is not a zero.
    const shrinkValues = (block: string): string[] => [
      ...[...block.matchAll(/flex-shrink:\s*([^;}]+)/g)].map((match) => match[1].trim()),
      // The `flex: <grow> <shrink> <basis>` shorthand sets flex-shrink too.
      ...[...block.matchAll(/[^-]flex:\s*\d+\s+(\d+)/g)].map((match) => match[1].trim()),
    ];
    const offenders = [...css.matchAll(/\.wr-timeline\s*>\s*[^{]*\{[^}]*\}/g)]
      .map((match) => match[0])
      .filter((block) => shrinkValues(block).some((value) => value !== '0'));
    expect(offenders, 'these rules let a timeline row be crushed again').toEqual([]);
  });
});

// harn:assume member-config-is-changed-not-respawned ref=member-card-settings
describe('MemberSettings', () => {
  const agent: Member = {
    ...alpha,
    harness: 'claude-code',
    cwd: '/work',
    policy: 'read-only',
    model: 'haiku',
    thinking: 'low',
    state: 'idle',
  };
  const adapters = [{
    id: 'claude-code',
    capabilities: {
      resume: true, thinking: true,
      policies: { 'read-only': 'plan', 'workspace-write': 'acceptEdits', 'full-access': 'bypassPermissions' },
    },
    models: ['haiku', 'sonnet', 'opus'],
    models_source: 'curated',
  }] as unknown as Parameters<typeof MemberCard>[0]['adapters'];

  const render = (member: Member): string =>
    renderToStaticMarkup(
      <MemberCard
        member={member}
        detail={undefined}
        history={[]}
        adapters={adapters}
        connection={noopConnection}
        expanded
        canManage
      />,
    );

  it('offers the settings an agent can actually be given', () => {
    expect(render(agent)).toContain('data-testid="configure-alpha"');
  });

  it('never offers to configure a member this switchboard does not own', () => {
    // The daemon refuses it; the UI must not invite the operator to try.
    expect(render({ ...agent, custody: 'mirrored' })).not.toContain('data-testid="configure-alpha"');
  });
});
// harn:end member-config-is-changed-not-respawned

// harn:assume removing-an-agent-is-one-deliberate-step ref=remove-member-regression
describe('removing an agent', () => {
  const live: Member = { ...alpha, harness: 'fake', cwd: '/work', state: 'idle' };
  const render = (member: Member): string =>
    renderToStaticMarkup(
      <MemberCard
        member={member}
        detail={undefined}
        history={[]}
        adapters={[]}
        connection={noopConnection}
        expanded
        canManage
      />,
    );

  it('is offered on a LIVE member, not only once it is already dead', () => {
    // It used to be a ritual: kill it, then find the button that only appears after.
    expect(render(live)).toContain('data-testid="remove-alpha"');
  });

  it('is still offered on a dead one', () => {
    expect(render({ ...live, state: 'dead', session_ref: 's-1' })).toContain('data-testid="remove-alpha"');
  });

  it('does not destroy anything on the first click — it asks first', () => {
    // The button opens a confirmation; it does not send the act.
    const html = render(live);
    expect(html).not.toContain('data-testid="remove-alpha-confirm"');
    expect(html).toContain('data-testid="remove-alpha"');
  });
});
// harn:end removing-an-agent-is-one-deliberate-step
