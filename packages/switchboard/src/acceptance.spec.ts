import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCodeAdapter } from '@codor/adapter-claude-code';
import { CodexAdapter } from '@codor/adapter-codex';
import { afterAll, describe, expect, it } from 'vitest';

import { Daemon } from './daemon.js';

/**
 * M0 acceptance (PLAN-M0 P0.10): a REAL claude→codex handoff through the
 * daemon. One human post, no manual routing:
 *
 *   @claude plans hello.md (a haiku) and hands off →
 *   claude's FINALIZED run message tags @codex →
 *   codex (workspace-write, temp git repo) creates the file.
 *
 * Gated behind WIREROOM_M0_ACCEPT=1 — this bills live turns.
 * The transcript is written to tmp/build/ACCEPT-M0.md in the repo root.
 *
 * Lessons already folded from the first live run: the human post must not
 * contain literal `@codex`/`@richard` tokens (they fan out on message #1 —
 * inline code escapes them), and runaway chains are paused, not
 * interrupted (an interrupted turn used to finalize empty and re-route).
 */
const LIVE = process.env.WIREROOM_M0_ACCEPT === '1';
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

// harn:assume m0-live-acceptance-chain ref=acceptance-live-chain
describe.skipIf(!LIVE)('M0 live acceptance (WIREROOM_M0_ACCEPT=1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wireroom-m0-accept-'));
  const workspace = join(dir, 'fixture-repo');
  mkdirSync(workspace);
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), '# acceptance fixture\n');
  execFileSync('git', ['-C', workspace, 'add', '-A']);
  execFileSync('git', [
    '-C', workspace, '-c', 'user.email=accept@wireroom', '-c', 'user.name=accept',
    'commit', '-qm', 'fixture',
  ]);

  const daemon = new Daemon({
    dbPath: join(dir, 'db.sqlite'),
    blobRoot: join(dir, 'blobs'),
    adapters: [new ClaudeCodeAdapter(), new CodexAdapter()],
  });

  afterAll(async () => {
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('one human post drives the routed chain and codex writes the artifact', { timeout: 600_000 }, async () => {
    daemon.createRoom({ id: 'accept', name: 'M0 acceptance', owner: { handle: 'richard', display_name: 'Richard' } });
    // operator directive: live test runs use the cheap models
    const claude = daemon.spawnMember('accept', {
      harness: 'claude-code',
      handle: 'claude',
      cwd: workspace,
      model: 'haiku',
    });
    const codex = daemon.spawnMember('accept', {
      harness: 'codex',
      handle: 'codex',
      cwd: workspace,
      policy: 'workspace-write', // spawn-time approvals = the member's policy chip
      model: 'gpt-5.4-mini',
    });
    const owner = daemon.ownerOf('accept');

    // runaway-chain watchdog: live spend — PAUSE members past the budget
    // (never interrupt: an interrupted turn finalizes empty; pausing holds
    // queues so settle() can resolve).
    let paused = false;
    const unsubscribe = daemon.onFrame((room, frame) => {
      if (paused || room !== 'accept' || frame.type !== 'message') return;
      const runs = daemon.store.listMessages('accept', { limit: 50 }).filter((m) => m.kind === 'run');
      if (runs.length > 4) {
        paused = true;
        daemon.store.updateMember('accept', claude.id, { state: 'paused' });
        daemon.store.updateMember('accept', codex.id, { state: 'paused' });
      }
    });

    // THE one human post — everything after this is routing. Inline code
    // ESCAPES the handles (PROTOCOL §3 rule 6) so only @claude fans out.
    const post = daemon.postHumanMessage(
      'accept',
      '@claude Plan a file hello.md containing exactly one haiku about a wireroom ' +
        'connecting agents. Do not use any tools and do not create anything yourself — ' +
        'reply with only the plan text (filename + the exact haiku). End your reply with ' +
        'one line that tags the codex agent — write `@codex` WITHOUT the backticks — ' +
        'instructing it to create the file exactly per your plan and, when done, to ' +
        'report to the human by tagging `@richard` (again without backticks), not you.',
    );

    const settled = await Promise.race([
      daemon.settle().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 480_000)),
    ]);
    unsubscribe();
    expect(settled, 'chain did not settle before the timeout').toBe(true);
    expect(paused, 'the runaway watchdog should never have fired').toBe(false);

    const messages = daemon.store.listMessages('accept', { limit: 50 });
    const claudeRuns = messages.filter((m) => m.kind === 'run' && m.author === claude.id);
    const codexRuns = messages.filter((m) => m.kind === 'run' && m.author === codex.id);

    // claude's reply IS its finalized run message and it tags codex
    expect(claudeRuns).toHaveLength(1);
    const plan = claudeRuns[0]!;
    expect(plan.run!.status).toBe('completed');
    expect(plan.mentions.some((s) => s.member_id === codex.id)).toBe(true);

    // the codex turn is exactly ONE message, finalized, referenced as #N
    expect(codexRuns).toHaveLength(1);
    const build = codexRuns[0]!;
    expect(build.run!.status).toBe('completed');
    expect(build.id).toBeGreaterThan(plan.id);

    // the delivery chain fired FROM claude's finalized run — no manual routing
    const codexDeliveries = daemon.store.listDeliveries('accept', { recipient: codex.id });
    expect(codexDeliveries).toHaveLength(1);
    expect(codexDeliveries[0]!.message_id).toBe(plan.id);
    expect(codexDeliveries[0]!.state).toBe('consumed');
    expect(codexDeliveries[0]!.run_msg_id).toBe(build.id);

    // the artifact: hello.md exists with the planned shape (a haiku = 3 lines)
    const helloPath = join(workspace, 'hello.md');
    expect(existsSync(helloPath), 'codex did not create hello.md').toBe(true);
    const hello = readFileSync(helloPath, 'utf8');
    expect(hello.trim().length).toBeGreaterThan(0);
    expect(hello.split('\n').filter((l) => l.trim() !== '').length).toBeGreaterThanOrEqual(3);

    // usage accounting: claude reports dollars, codex tokens only
    expect(plan.run!.usage?.cost_usd).toBeTypeOf('number');
    expect(build.run!.usage?.cost_usd).toBeUndefined();
    expect(build.run!.usage?.input_tokens ?? 0).toBeGreaterThan(0);

    // richard got codex's report as an inbox record, never a turn
    const inbox = daemon.store.listDeliveries('accept', { recipient: owner.id });
    expect(inbox.length).toBeGreaterThan(0);

    writeTranscript({ messages: daemon.store.listMessages('accept', { limit: 50 }), hello, workspace, post: post.id });
  });

  function writeTranscript(input: {
    messages: ReturnType<Daemon['store']['listMessages']>;
    hello: string;
    workspace: string;
    post: number;
  }): void {
    const members = new Map(daemon.store.listMembers('accept').map((m) => [m.id, m.handle]));
    const lines: string[] = [
      '# M0 acceptance transcript',
      '',
      `Run: ${new Date().toISOString()} · room \`accept\` · fixture \`${input.workspace}\``,
      'Flow: one human post → @claude plans (live claude CLI) → finalized run tags @codex →',
      '@codex (live codex CLI, workspace-write) creates hello.md → reports to @richard.',
      `No manual routing after message #${String(input.post)}.`,
      '',
      '## Timeline',
      '',
    ];
    for (const message of input.messages) {
      const author = members.get(message.author) ?? message.author;
      const status = message.kind === 'run' ? ` [${message.run!.status}]` : '';
      const usage = message.run?.usage
        ? ` (${message.run.usage.input_tokens}/${message.run.usage.output_tokens} tk` +
          (message.run.usage.cost_usd !== undefined ? `, $${message.run.usage.cost_usd.toFixed(4)}` : '') +
          ')'
        : '';
      lines.push(`### #${message.id} @${author} · ${message.kind}${status}${usage}`, '', message.body, '');
    }
    lines.push('## Artifact: hello.md', '', '```', input.hello.trimEnd(), '```', '');
    lines.push('All assertions passed: chain routed from the finalized run message,');
    lines.push('one message per turn, artifact on disk, tokens-only codex usage.');
    mkdirSync(join(REPO_ROOT, 'tmp', 'build'), { recursive: true });
    writeFileSync(join(REPO_ROOT, 'tmp', 'build', 'ACCEPT-M0.md'), lines.join('\n'));
  }
});
// harn:end m0-live-acceptance-chain
