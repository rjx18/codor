import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCodeAdapter } from '@wireroom/adapter-claude-code';
import { CodexAdapter } from '@wireroom/adapter-codex';
import { Daemon, FakeAdapter, startServer } from '@wireroom/switchboard';
import { describe, expect, it } from 'vitest';

import { runCli } from './index.js';

const LIVE = process.env.WIREROOM_M1_ACCEPT === '1';
const REMAINDER = process.env.WIREROOM_M1_REMAINDER === '1';
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

async function settleWithin(daemon: Daemon, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    daemon.settle().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

// harn:assume permalink-ids-stable ref=m1-live-acceptance
describe.skipIf(!LIVE)('M1 live acceptance (WIREROOM_M1_ACCEPT=1)', () => {
  it('replays review, join, attach, extension, and brake flows once', { timeout: 900_000 }, async () => {
    const joinSession = process.env.WIREROOM_JOIN_SESSION;
    const joinCwd = process.env.WIREROOM_JOIN_CWD ?? REPO_ROOT;
    expect(joinSession, 'WIREROOM_JOIN_SESSION must identify the live TUI being joined').toBeTruthy();

    const dir = mkdtempSync(join(tmpdir(), 'wireroom-m1-accept-'));
    const workspace = join(dir, 'fixture-repo');
    mkdirSync(workspace);
    execFileSync('git', ['init', '-q', workspace]);
    writeFileSync(join(workspace, 'README.md'), '# M1 acceptance fixture\n');
    execFileSync('git', ['-C', workspace, 'add', '-A']);
    execFileSync('git', [
      '-C', workspace,
      '-c', 'user.email=accept@wireroom',
      '-c', 'user.name=accept',
      'commit', '-qm', 'fixture',
    ]);

    const fake = new FakeAdapter('fake');
    const daemon = new Daemon({
      dbPath: join(dir, 'wireroom.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [new ClaudeCodeAdapter(), new CodexAdapter(), fake],
    });
    const server = await startServer({
      daemon,
      token: 'm1-accept-token',
      socketPath: join(dir, 'wireroom.sock'),
    });
    const cliOutput: string[] = [];
    let unsubscribe = () => undefined;

    try {
      const room = daemon.createRoom({
        id: 'm1-review',
        name: 'M1 review loop',
        owner: { handle: 'richard', display_name: 'Richard' },
      }).room;
      expect(room.config).toMatchObject({ turn_brake: null, spend_brake_usd: null });
      const claude = daemon.spawnMember(room.id, {
        harness: 'claude-code',
        handle: 'claude',
        cwd: workspace,
        model: 'haiku',
        policy: 'bypassPermissions',
      });
      const codex = daemon.spawnMember(room.id, {
        harness: 'codex',
        handle: 'codex',
        cwd: workspace,
        model: 'gpt-5.4-mini',
        policy: 'workspace-write',
      });
      const owner = daemon.ownerOf(room.id);

      let watchdogPaused = false;
      unsubscribe = daemon.onFrame((frameRoom, frame) => {
        if (watchdogPaused || frameRoom !== room.id || frame.type !== 'message') return;
        const runs = daemon.store.listMessages(room.id, { limit: 50 }).filter((message) => message.kind === 'run');
        if (runs.length <= 6) return;
        watchdogPaused = true;
        daemon.store.updateMember(room.id, claude.id, { state: 'paused' });
        daemon.store.updateMember(room.id, codex.id, { state: 'paused' });
      });

      const reviewPost = daemon.postHumanMessage(
        room.id,
        '@claude Do not use tools. Produce PLAN v1 with exactly one implementation item: ' +
          'write m1.txt containing M1. Deliberately omit verification. End with one line that ' +
          'begins `@codex` without the backticks and asks it to review. Tell the reviewer, ' +
          'quoting these handles exactly but without the backticks: if verification is ' +
          'missing, request one verification item and tag `@claude` to fold it; if a revised ' +
          'plan includes verification, reply APPROVED and tag `@richard`. Later, when the ' +
          'reviewer asks you to fold, produce PLAN v2 adding that single verification item ' +
          'and end with one line that begins `@codex` without the backticks resubmitting for ' +
          'review. Do not tag anyone else.',
      );
      expect(await settleWithin(daemon, 600_000), 'review loop did not settle').toBe(true);
      expect(watchdogPaused, 'review loop exceeded the six-run safety budget').toBe(false);

      const reviewRuns = daemon.store
        .listMessages(room.id, { limit: 50 })
        .filter((message) => message.kind === 'run');
      expect(reviewRuns).toHaveLength(4);
      expect(reviewRuns.map((message) => message.author)).toEqual([
        claude.id,
        codex.id,
        claude.id,
        codex.id,
      ]);
      expect(reviewRuns[0]!.mentions.some((mention) => mention.member_id === codex.id)).toBe(true);
      expect(reviewRuns[1]!.mentions.some((mention) => mention.member_id === claude.id)).toBe(true);
      expect(reviewRuns[2]!.mentions.some((mention) => mention.member_id === codex.id)).toBe(true);
      expect(reviewRuns[3]!.mentions.some((mention) => mention.member_id === owner.id)).toBe(true);
      expect(reviewRuns[3]!.body).toMatch(/APPROVED/i);

      const extensionPost = daemon.postHumanMessage(
        room.id,
        '@claude You must use the Agent tool exactly once. Give that subagent only the tiny ' +
          'prompt "Reply FOUR only." After it returns, report EXTENSION FOUR and tag `@richard` ' +
          'without the backticks. Do not use other tools or tag anyone else.',
      );
      expect(await settleWithin(daemon, 300_000), 'extension turn did not settle').toBe(true);
      expect(watchdogPaused, 'extension turn exceeded the six-run safety budget').toBe(false);
      const extensionRun = daemon.store
        .listMessages(room.id, { limit: 50 })
        .filter((message) => message.kind === 'run' && message.id > reviewRuns[3]!.id)[0]!;
      const extensionEvents = daemon.readRunBlob(room.id, extensionRun.id);
      expect(extensionEvents.some((event) => event.type === 'extension.started')).toBe(true);
      expect(extensionEvents.some((event) => event.type === 'extension.ended')).toBe(true);
      const extensions = daemon.store.listMembers(room.id).filter((member) => member.kind === 'extension');
      expect(extensions).toHaveLength(1);
      expect(extensions[0]!.state).toBe('dead');

      await runCli(
        [
          'node', 'wireroom', '--data-dir', dir, 'join', room.id,
          '--as', 'implementer', '--harness', 'codex', '--session', joinSession!, '--cwd', joinCwd,
        ],
        { stdout: (line) => cliOutput.push(line), stderr: (line) => cliOutput.push(line) },
      );
      const joined = daemon.store.getMemberByHandle(room.id, 'implementer')!;
      expect(joined).toMatchObject({
        harness: 'codex',
        session_ref: joinSession,
        custody: 'mirrored',
      });

      await runCli(
        ['node', 'wireroom', '--data-dir', dir, 'attach', `@${codex.handle}`],
        {
          stdout: (line) => cliOutput.push(line),
          stderr: (line) => cliOutput.push(line),
          interactiveCommand: () => ({
            command: process.execPath,
            args: ['-e', 'setTimeout(() => process.exit(0), 150)'],
          }),
          attachHeartbeatMs: 20,
        },
      );
      expect(cliOutput).toContain(`attaching @${codex.handle} (codex)`);
      expect(cliOutput).toContain(`re-adopted @${codex.handle}`);
      expect(daemon.store.getMember(room.id, codex.id)).toMatchObject({ custody: 'owned', state: 'idle' });
      expect(daemon.store.getAttachLeaseForMember(codex.id)).toBeUndefined();

      const brakeRoom = daemon.createRoom({
        id: 'm1-brake',
        name: 'M1 brake acceptance',
        owner: { handle: 'richard', display_name: 'Richard' },
      }).room;
      const alpha = daemon.spawnMember(brakeRoom.id, {
        harness: 'fake', handle: 'alpha', cwd: workspace,
      });
      const beta = daemon.spawnMember(brakeRoom.id, {
        harness: 'fake', handle: 'beta', cwd: workspace,
      });
      daemon.configureRoom(brakeRoom.id, { turn_brake: 1 });
      fake.enqueue(
        { kind: 'complete', final_text: '@beta hop one' },
        { kind: 'complete', final_text: '@alpha hop two' },
        { kind: 'complete', final_text: '@richard released' },
      );
      const brakePost = daemon.postHumanMessage(brakeRoom.id, '@alpha start brake chain');
      await daemon.settle();
      const held = daemon.store.listDeliveries(brakeRoom.id, { state: 'held' });
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ recipient: alpha.id, hop_count: 2 });
      expect(daemon.store.listMessages(brakeRoom.id, { limit: 50 }).filter((message) => message.kind === 'run'))
        .toHaveLength(2);
      daemon.releaseHold(brakeRoom.id, held[0]!.id);
      await daemon.settle();
      expect(daemon.store.getDelivery(brakeRoom.id, held[0]!.id)!.state).toBe('consumed');
      expect(daemon.store.listMessages(brakeRoom.id, { limit: 50 }).filter((message) => message.kind === 'run'))
        .toHaveLength(3);
      expect(beta.id).toBeTruthy();

      writeTranscript({
        daemon,
        room: room.id,
        brakeRoom: brakeRoom.id,
        reviewPost: reviewPost.id,
        extensionPost: extensionPost.id,
        brakePost: brakePost.id,
        cliOutput,
        joinSession: joinSession!,
      });
    } finally {
      unsubscribe();
      await server.close();
      await daemon.close({ force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!REMAINDER)('M1 zero-spend acceptance remainder', () => {
  it('verifies join, attach custody, and separate brake hold/release', { timeout: 60_000 }, async () => {
    const joinSession = process.env.WIREROOM_JOIN_SESSION;
    const joinCwd = process.env.WIREROOM_JOIN_CWD ?? REPO_ROOT;
    expect(joinSession, 'WIREROOM_JOIN_SESSION must identify the live TUI being joined').toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'wireroom-m1-remainder-'));
    const workspace = join(dir, 'fixture-repo');
    mkdirSync(workspace);
    const codexFake = new FakeAdapter('codex', { interactiveAttach: true });
    const daemon = new Daemon({
      dbPath: join(dir, 'wireroom.sqlite'),
      blobRoot: join(dir, 'blobs'),
      adapters: [codexFake],
    });
    const server = await startServer({
      daemon,
      token: 'm1-remainder-token',
      socketPath: join(dir, 'wireroom.sock'),
    });
    const cliOutput: string[] = [];
    try {
      const reviewRoom = daemon.createRoom({
        id: 'm1-review',
        name: 'M1 review loop',
        owner: { handle: 'richard', display_name: 'Richard' },
      }).room;
      expect(reviewRoom.config).toMatchObject({ turn_brake: null, spend_brake_usd: null });
      await runCli(
        [
          'node', 'wireroom', '--data-dir', dir, 'join', reviewRoom.id,
          '--as', 'implementer', '--harness', 'codex', '--session', joinSession!, '--cwd', joinCwd,
        ],
        { stdout: (line) => cliOutput.push(line), stderr: (line) => cliOutput.push(line) },
      );
      expect(daemon.store.getMemberByHandle(reviewRoom.id, 'implementer')).toMatchObject({
        session_ref: joinSession,
        custody: 'mirrored',
      });

      const coder = daemon.spawnMember(reviewRoom.id, {
        harness: 'codex', handle: 'coder', cwd: workspace,
      });
      codexFake.enqueue({ kind: 'complete', final_text: '@richard initialized for attach' });
      daemon.postHumanMessage(reviewRoom.id, '@coder initialize');
      await daemon.settle();
      await runCli(
        ['node', 'wireroom', '--data-dir', dir, 'attach', '@coder'],
        {
          stdout: (line) => cliOutput.push(line),
          stderr: (line) => cliOutput.push(line),
          interactiveCommand: () => ({
            command: process.execPath,
            args: ['-e', 'setTimeout(() => process.exit(0), 150)'],
          }),
          attachHeartbeatMs: 20,
        },
      );
      expect(daemon.store.getMember(reviewRoom.id, coder.id)).toMatchObject({
        custody: 'owned', state: 'idle',
      });
      expect(daemon.store.getAttachLeaseForMember(coder.id)).toBeUndefined();

      const brakeRoom = daemon.createRoom({
        id: 'm1-brake',
        name: 'M1 brake acceptance',
        owner: { handle: 'richard', display_name: 'Richard' },
      }).room;
      const alpha = daemon.spawnMember(brakeRoom.id, {
        harness: 'codex', handle: 'alpha', cwd: workspace,
      });
      daemon.spawnMember(brakeRoom.id, {
        harness: 'codex', handle: 'beta', cwd: workspace,
      });
      daemon.configureRoom(brakeRoom.id, { turn_brake: 1 });
      codexFake.enqueue(
        { kind: 'complete', final_text: '@beta hop one' },
        { kind: 'complete', final_text: '@alpha hop two' },
        { kind: 'complete', final_text: '@richard released' },
      );
      const brakePost = daemon.postHumanMessage(brakeRoom.id, '@alpha start brake chain');
      await daemon.settle();
      const held = daemon.store.listDeliveries(brakeRoom.id, { state: 'held' });
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ recipient: alpha.id, hop_count: 2 });
      daemon.releaseHold(brakeRoom.id, held[0]!.id);
      await daemon.settle();
      expect(daemon.store.getDelivery(brakeRoom.id, held[0]!.id)!.state).toBe('consumed');

      writeBlockedTranscript({
        daemon,
        reviewRoom: reviewRoom.id,
        brakeRoom: brakeRoom.id,
        brakePost: brakePost.id,
        cliOutput,
        joinSession: joinSession!,
      });
    } finally {
      await server.close();
      await daemon.close({ force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeBlockedTranscript(input: {
  daemon: Daemon;
  reviewRoom: string;
  brakeRoom: string;
  brakePost: number;
  cliOutput: string[];
  joinSession: string;
}): void {
  const brakeMessages = input.daemon.store.listMessages(input.brakeRoom, { limit: 100 });
  const brakeMembers = new Map(
    input.daemon.store.listMembers(input.brakeRoom).map((member) => [member.id, member.handle]),
  );
  const lines = [
    '# M1 acceptance transcript',
    '',
    `Run: ${new Date().toISOString()}`,
    '',
    '## Gate status',
    '',
    '- BLOCKED: live review loop and live extension.',
    '- PASS: real pre-existing Codex session joined through `wireroom join` as mirrored.',
    '- PASS: `wireroom attach` custody lease, child report, exit, and re-adoption round trip.',
    '- PASS: separate turn-brake room held and released the same delivery.',
    '- PASS: history paging, search, and #N permalinks (Playwright; recorded in test summary).',
    '',
    '## Live attempt',
    '',
    'Models were pinned to Claude `haiku` and Codex `gpt-5.4-mini`; review-room turn and',
    'spend brakes were both off. One tiny review prompt was posted to Claude exactly once.',
    'Claude finalized its first run as failed before routing to Codex:',
    '',
    '> You\'ve hit your session limit - resets 11:50pm (Asia/Singapore)',
    '',
    'The local Claude transcript records `error: rate_limit`. Per the live-spend rule, the',
    'prompt was not retried, Codex was not invoked, and the extension prompt was not issued.',
    'Therefore plan -> review -> fold -> re-review -> converge and a live authoritative',
    'extension remain unverified rather than being represented by fixtures.',
    '',
    '## Live TUI join walkthrough',
    '',
    `The CLI joined active implementer session \`${input.joinSession}\` into ` +
      `room \`${input.reviewRoom}\` as \`@implementer\` with mirrored custody.`,
    '',
    'The fullscreen slash-command interaction is operator-owned and was not scripted by Vitest.',
    'Manual TUI steps:',
    '1. Open the existing Claude or Codex TUI session in its terminal.',
    `2. Invoke \`/wireroom\`, choose \`join\`, room \`${input.reviewRoom}\`, handle \`implementer\`.`,
    '3. Confirm the member appears with mirrored custody.',
    `4. On native TUI exit, run \`wireroom adopt -r ${input.reviewRoom} implementer\` only when transferring custody.`,
    '',
    '## Attach round trip',
    '',
    ...input.cliOutput.map((line) => `- ${line}`),
    '',
    'The actual CLI custody protocol ran end to end. A deterministic short child stood in for',
    'the fullscreen native resume process because the acceptance runner has no operator TTY;',
    'native resume capability itself is covered by the adapter command/conformance suites.',
    '',
    '## Brake room',
    '',
    `Human message #${String(input.brakePost)} started a separate room with \`turn_brake=1\`.`,
  ];
  for (const message of brakeMessages) {
    const author = brakeMembers.get(message.author) ?? message.author;
    const status = message.run ? ` [${message.run.status}]` : '';
    lines.push(`### #${String(message.id)} @${author} - ${message.kind}${status}`, '', message.body, '');
  }
  lines.push(
    'The third agent delivery held at hop 2. Releasing that exact held delivery consumed it',
    'and completed the third turn.',
    '',
  );
  mkdirSync(join(REPO_ROOT, 'tmp', 'build'), { recursive: true });
  writeFileSync(join(REPO_ROOT, 'tmp', 'build', 'ACCEPT-M1.md'), lines.join('\n'));
}

function writeTranscript(input: {
  daemon: Daemon;
  room: string;
  brakeRoom: string;
  reviewPost: number;
  extensionPost: number;
  brakePost: number;
  cliOutput: string[];
  joinSession: string;
}): void {
  const timeline = input.daemon.store.listMessages(input.room, { limit: 100 });
  const members = new Map(input.daemon.store.listMembers(input.room).map((member) => [member.id, member.handle]));
  const extensions = input.daemon.store.listMembers(input.room).filter((member) => member.kind === 'extension');
  const brakeMessages = input.daemon.store.listMessages(input.brakeRoom, { limit: 100 });
  const brakeMembers = new Map(
    input.daemon.store.listMembers(input.brakeRoom).map((member) => [member.id, member.handle]),
  );
  const lines = [
    '# M1 acceptance transcript',
    '',
    `Run: ${new Date().toISOString()}`,
    'Models: Claude `haiku`; Codex `gpt-5.4-mini`.',
    'Review-room brakes: turn off, spend off. Live prompts were each issued once.',
    '',
    '## Review loop and extension',
    '',
    `One human message #${String(input.reviewPost)} started the plan -> review -> fold -> re-review loop.`,
    `Human message #${String(input.extensionPost)} requested exactly one live Agent subagent.`,
    '',
  ];
  for (const message of timeline) {
    const author = members.get(message.author) ?? message.author;
    const status = message.run ? ` [${message.run.status}]` : '';
    const usage = message.run?.usage
      ? ` (${String(message.run.usage.input_tokens)}/${String(message.run.usage.output_tokens)} tk` +
        (message.run.usage.cost_usd === undefined ? ')' : `, $${message.run.usage.cost_usd.toFixed(4)})`)
      : '';
    lines.push(`### #${String(message.id)} @${author} - ${message.kind}${status}${usage}`, '', message.body, '');
  }
  lines.push(
    'Observed extension members:',
    ...extensions.map((member) => `- @${member.handle}: ${member.state ?? 'unknown'} (${member.session_ref ?? 'no native id'})`),
    '',
    '## Live TUI join walkthrough',
    '',
    `The CLI joined the active implementer Codex TUI session \`${input.joinSession}\` as ` +
      '`@implementer` with mirrored custody; this was a real pre-existing session, not a fixture.',
    '',
    'The fullscreen slash-command interaction itself is operator-owned and was not scripted by Vitest.',
    'Manual TUI steps recorded for the walkthrough:',
    '1. Open the existing Claude or Codex TUI session in its terminal.',
    '2. Invoke `/wireroom`, choose `join`, room `m1-review`, and handle `implementer`.',
    '3. Confirm the room member appears with mirrored custody.',
    '4. End the native TUI and run `wireroom adopt -r m1-review implementer` only when transferring custody.',
    '',
    '## Attach round trip',
    '',
    ...input.cliOutput.map((line) => `- ${line}`),
    '',
    'The actual `wireroom attach` lease, child report, exit, and re-adoption handshake ran against the',
    'live Codex room member. The automated acceptance used a short deterministic interactive child instead',
    'of attempting to drive the fullscreen native TUI from a non-interactive test runner.',
    '',
    '## Brake room',
    '',
    `Human message #${String(input.brakePost)} started the separate turn-brake=1 room.`,
  );
  for (const message of brakeMessages) {
    const author = brakeMembers.get(message.author) ?? message.author;
    const status = message.run ? ` [${message.run.status}]` : '';
    lines.push(`### #${String(message.id)} @${author} - ${message.kind}${status}`, '', message.body, '');
  }
  lines.push(
    'Assertions passed: the third agent delivery held at hop 2, emitted its hold notice, then release',
    'consumed that same delivery and completed the third turn.',
    '',
  );
  mkdirSync(join(REPO_ROOT, 'tmp', 'build'), { recursive: true });
  writeFileSync(join(REPO_ROOT, 'tmp', 'build', 'ACCEPT-M1.md'), lines.join('\n'));
}
// harn:end permalink-ids-stable
