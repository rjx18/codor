// web-next fixture harness: boots an ISOLATED daemon + server (never the live
// codor.service) with a FakeAdapter and a representative seed — multi-channel rail,
// a multi-speaker conversation with 2-minute grouping cases, a completed run with
// tool + diff evidence, a live running run, a pending approval, and a held delivery.
// Playwright and the screenshot pipeline point the dev server (or the built SPA this
// serves) at it.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CryptoVault,
  Daemon,
  FakeAdapter,
  LedgerManager,
  startServer,
} from '@codor/switchboard';

const readPort = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
};
const API_PORT = readPort('CODOR_NEXT_E2E_API_PORT', 28_137);
const CONTROL_PORT = readPort('CODOR_NEXT_E2E_CONTROL_PORT', 28_138);
const TOKEN = 'next-e2e-token';

const dir = mkdtempSync(join(tmpdir(), 'codor-next-e2e-'));
const fake = new FakeAdapter('fake', {
  extensions: true,
  policies: {
    'read-only': 'plan',
    'workspace-write': 'acceptEdits',
    'full-access': 'bypassPermissions',
  },
});

const ledger = new LedgerManager({ dataDir: dir });
const crypto = new CryptoVault(dir);
const daemon = new Daemon({
  discoverModels: false,
  dbPath: join(dir, 'db.sqlite'),
  blobRoot: join(dir, 'blobs'),
  adapters: [fake],
  ledger,
});

// ── Channels: distinct previews / working / failure / unread states ──────
const owner = { handle: 'richard', display_name: 'Richard' };
for (const [id, name] of [
  ['eng', 'Engineering'],
  ['design', 'Design'],
  ['ops', 'Ops'],
  ['research', 'Research'],
  ['trash', 'Scratch'],
  ['recovery', 'Recovery'],
  ['interleave', 'Interleave'],
  ['workspace', 'Workspace'],
  ['files', 'Files'],
  ['hydration', 'Hydration'],
  ['fixtures', 'Fixtures'],
]) {
  daemon.createRoom({ id, name, owner });
  crypto.roomKeys.ensureRoom(id);
}

// Scratch: an agent-free room of pre-seeded, non-grouped owner messages for the
// deletion tests — deleting here creates no runs and cannot collide with eng.
const trashOwner = daemon.ownerOf('trash');
['alpha', 'beta', 'gamma', 'delta', 'epsilon'].forEach((tag, index) => {
  const seeded = daemon.store.postMessage('trash', {
    author: trashOwner.id, kind: 'chat', body: `delete target ${tag}`,
  });
  // Backdate with >2min gaps so each is its own turn with a header + actions.
  daemon.store.db
    .prepare('UPDATE messages SET ts = ? WHERE room = ? AND id = ?')
    .run(new Date(Date.now() - (60 - index * 5) * 60_000).toISOString(), 'trash', seeded.id);
});

const engOwner = daemon.ownerOf('eng');
const fable = daemon.spawnMember('eng', { harness: 'fake', handle: 'fable', cwd: dir });
const scout = daemon.spawnMember('eng', { harness: 'fake', handle: 'scout', cwd: dir });
const muse = daemon.spawnMember('eng', { harness: 'fake', handle: 'muse', cwd: dir });
const hydrate = daemon.spawnMember('eng', { harness: 'fake', handle: 'hydrate', cwd: dir });
const restore = daemon.spawnMember('eng', { harness: 'fake', handle: 'restore', cwd: dir });

// A non-privileged human so tests can prove owner/admin-only controls stay hidden.
const viewer = daemon.store.addMember('eng', {
  kind: 'human', handle: 'viewer', display_name: 'Viewer', role: 'member',
});
const VIEWER_TOKEN = 'next-e2e-viewer-token';

// Ops carries the failure state: its latest run failed and its author is dead.
const relay = daemon.spawnMember('ops', { harness: 'fake', handle: 'relay', cwd: dir });
const relayRunTs = new Date().toISOString();
daemon.store.postMessage('ops', {
  author: relay.id,
  kind: 'run',
  body: 'deploy job exited 1 — rollback applied, needs a human look',
  run: {
    status: 'failed',
    started_ts: relayRunTs,
    ended_ts: relayRunTs,
    tool_calls: 0,
    events_ref: 'runs/relay-failed.jsonl',
    final_text: 'deploy job exited 1 — rollback applied, needs a human look',
  },
});
daemon.store.updateMember('ops', relay.id, { state: 'dead' });

// Design also has a dormant dead agent, which must not trip attention by itself.
const retiredDesigner = daemon.spawnMember('design', { harness: 'fake', handle: 'retired-designer', cwd: dir });
daemon.store.updateMember('design', retiredDesigner.id, { state: 'dead' });

daemon.postHumanMessage('design', 'new pricing page comps are in figma, comments welcome', {
  author: daemon.ownerOf('design').id,
});
daemon.postHumanMessage('research', 'collected the retrieval eval traces for tomorrow', {
  author: daemon.ownerOf('research').id,
});
daemon.postHumanMessage('research', 'first pass: recall is fine, precision drops on long docs', {
  author: daemon.ownerOf('research').id,
});

// ── Engineering conversation with 2-minute grouping cases ────────────────
// m1 + m2 sit 30s apart (same sender, grouped); m3 comes 18 minutes later
// (same sender, NEW turn).
const m1 = daemon.postHumanMessage('eng', 'morning — can we get the auth refactor over the line today?');
const m2 = daemon.postHumanMessage('eng', 'staging deploy is green, so no blockers from infra');

fake.enqueue({
  kind: 'complete',
  final_text:
    'Queue is short: session rotation is refactored and tests pass. Remaining: wire the refresh TTL config and delete the legacy cookie path.',
  usage: { input_tokens: 18_234, output_tokens: 512, cost_usd: 0.041 },
  // harn:assume member-context-window-meter-derived-from-last-usage ref=context-window-meter-browser-fixture
  agent_usage: {
    inputTokens: 18_234,
    outputTokens: 512,
    totalCostUsd: 0.041,
    contextWindowUsedTokens: 150_000,
    contextWindowMaxTokens: 200_000,
  },
  // harn:end member-context-window-meter-derived-from-last-usage
  items: [
    {
      type: 'run.limits',
      limits: [
        // Three shapes on purpose: no-percentage pill fallback, warn gauge, ok gauge.
        { window: 'five_hour', status: 'allowed', resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString() },
        { window: 'weekly', status: 'allowed_warning', used_percent: 82 },
        { window: 'monthly', status: 'allowed', used_percent: 20 },
      ],
    },
    {
      type: 'run.item',
      item_type: 'text_delta',
      payload: { text: 'Checking the auth queue before making changes.' },
    },
    {
      type: 'run.item',
      item_type: 'tool_call',
      payload: {
        call_id: 't1',
        tool: 'Bash',
        title: 'pnpm test --filter auth',
        input: { command: 'pnpm test --filter auth' },
      },
    },
    {
      type: 'run.item',
      item_type: 'tool_result',
      payload: { call_id: 't1', status: 'ok', output_text: 'Test Files  6 passed (6)\nTests  42 passed (42)' },
    },
    {
      type: 'run.item',
      item_type: 'reasoning_summary',
      payload: { text: '' },
    },
    {
      type: 'run.item',
      item_type: 'tool_call',
      payload: {
        call_id: 't2',
        tool: 'Edit',
        title: 'src/auth/session.ts',
        input: { file_path: 'src/auth/session.ts' },
      },
    },
    {
      type: 'run.item',
      item_type: 'tool_result',
      payload: {
        call_id: 't2',
        status: 'ok',
        diff: {
          path: 'src/auth/session.ts',
          unified:
            '@@ -18,7 +18,9 @@\n-  const ttl = 3600;\n+  const ttl = config.refreshTtlSeconds;\n+  rotateOnUse(session);\n   persist(session);\n',
        },
      },
    },
    {
      type: 'run.item',
      item_type: 'text_delta',
      payload: {
        text: 'Queue is short: session rotation is refactored and tests pass. Remaining: wire the refresh TTL config and delete the legacy cookie path.',
      },
    },
  ],
});
const m3 = daemon.postHumanMessage('eng', '@fable summarize what is left on the auth queue');
await daemon.settle();

// Recovery: an isolated room with a real failed run (bound delivery intact) so
// the retry tests have something to act on without touching eng. A room-scoped
// member ('onlooker') lets the viewer-role gate be proven here too.
const medic = daemon.spawnMember('recovery', { harness: 'fake', handle: 'medic', cwd: dir });
const onlooker = daemon.store.addMember('recovery', {
  kind: 'human', handle: 'onlooker', display_name: 'Onlooker', role: 'member',
});
const RECOVERY_VIEWER_TOKEN = 'next-e2e-recovery-viewer-token';
fake.enqueue({ kind: 'complete', status: 'failed', final_text: 'deploy step exploded' });
daemon.postHumanMessage('recovery', '@medic run the deploy');
await daemon.settle();

// Interleave: an isolated room whose only agent (@weaver) the interleave e2e
// drives live — enqueue a two-prose-block turn, start it, drop a human message
// between the blocks via the control port, and prove it lands between them.
daemon.spawnMember('interleave', { harness: 'fake', handle: 'weaver', cwd: dir });

// Workspace: a room bound to a REAL git repo so the diff explorer has a live
// working tree to read. Seeded dirty — a modified, a deleted, and an untracked
// file — with a committed run whose Edit chip points at the modified file.
const workspaceRepo = join(dir, 'workspace-repo');
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Codor', GIT_AUTHOR_EMAIL: 'codor@example.com',
  GIT_COMMITTER_NAME: 'Codor', GIT_COMMITTER_EMAIL: 'codor@example.com',
};
const gitIn = (args) => execFileSync('git', args, { cwd: workspaceRepo, env: gitEnv });
mkdirSync(join(workspaceRepo, 'src'), { recursive: true });
writeFileSync(join(workspaceRepo, 'src', 'app.ts'), 'export const version = 1;\n');
writeFileSync(join(workspaceRepo, 'legacy.ts'), 'export const old = true;\n');
writeFileSync(join(workspaceRepo, 'README.md'), '# Workspace\n');
gitIn(['init', '-q']);
gitIn(['add', '.']);
gitIn(['commit', '-q', '-m', 'initial workspace']);
const dirtyWorkspace = () => {
  writeFileSync(join(workspaceRepo, 'src', 'app.ts'), 'export const version = 2;\nexport const patched = true;\n');
  rmSync(join(workspaceRepo, 'legacy.ts'), { force: true });
  writeFileSync(join(workspaceRepo, 'notes.md'), 'scratch notes\nmore notes\n');
};
daemon.spawnMember('workspace', { harness: 'fake', handle: 'builder', cwd: workspaceRepo });
// A completed run whose Edit chip references the file the working tree changed,
// so clicking the chip lands on that file's CURRENT diff.
fake.enqueue({
  kind: 'complete',
  final_text: 'Bumped src/app.ts to version 2 and added a patch flag.',
  items: [
    { type: 'run.item', item_type: 'text_delta', payload: { text: 'Bumping the version and adding a patch flag.' } },
    {
      type: 'run.item', item_type: 'tool_call',
      payload: { call_id: 'w1', tool: 'Edit', title: 'src/app.ts', input: { file_path: 'src/app.ts' } },
    },
    {
      type: 'run.item', item_type: 'tool_result',
      payload: {
        call_id: 'w1', status: 'ok',
        diff: { path: 'src/app.ts', unified: '@@ -1 +1,2 @@\n-export const version = 1;\n+export const version = 2;\n+export const patched = true;\n' },
      },
    },
  ],
});
daemon.postHumanMessage('workspace', '@builder bump app.ts to version 2');
await daemon.settle();
dirtyWorkspace();

// Files: an agent-free room seeded with a message carrying a rendered image and a
// download chip (bytes + sidecars on disk) so the attachments e2e has real files
// to render, delete, and axe-check without a live upload.
const filesDir = join(dir, 'attachments', 'files');
mkdirSync(filesDir, { recursive: true });
const seedAttachment = (id, name, mime, bytes) => {
  writeFileSync(join(filesDir, id), bytes);
  const meta = { id, name, mime, size: bytes.length };
  writeFileSync(join(filesDir, `${id}.json`), JSON.stringify(meta));
  return meta;
};
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const seededImage = seedAttachment(`${'0'.repeat(31)}1`, 'diagram.png', 'image/png', onePixelPng);
const seededDoc = seedAttachment(`${'0'.repeat(31)}2`, 'notes.txt', 'text/plain', Buffer.from('build log\nmore lines\n'));
daemon.store.postMessage('files', {
  author: daemon.ownerOf('files').id,
  kind: 'chat',
  body: 'here are the files',
  attachments: [seededImage, seededDoc],
});

// Fixtures: a STABLE room for specs whose subject is a seeded message or run.
// The shared eng room accretes as other specs post into it, which pushes boot
// fixtures out of the bounded cold tail — a spec then pages two-plus pages just
// to reach its subject, testing paging instead of itself. Ids here are
// deterministic (1 = quote target, 2 = search target, 3 = the evidence run).
const fixturesOwner = daemon.ownerOf('fixtures');
daemon.store.postMessage('fixtures', {
  author: fixturesOwner.id, kind: 'chat',
  body: 'morning — can we get the auth refactor over the line today?',
});
daemon.store.postMessage('fixtures', {
  author: fixturesOwner.id, kind: 'chat',
  body: 'staging deploy is green, so no blockers from infra',
});
const archiver = daemon.spawnMember('fixtures', { harness: 'fake', handle: 'archiver', cwd: dir });
const evidencePost = daemon.store.postMessage('fixtures', {
  author: archiver.id, kind: 'run', body: 'Queue is short: session rotation is refactored.',
});
const evidenceRef = `runs/${evidencePost.id}.jsonl`;
daemon.store.updateMessage('fixtures', evidencePost.id, {
  run: {
    status: 'completed', started_ts: new Date().toISOString(), ended_ts: new Date().toISOString(),
    tool_calls: 2, events_ref: evidenceRef,
    final_text: 'Queue is short: session rotation is refactored.',
  },
});
for (const event of [
  { type: 'run.item', item_type: 'text_delta', payload: { text: 'Checking the auth queue before making changes.' } },
  { type: 'run.item', item_type: 'tool_call', payload: { call_id: 'x1', tool: 'Bash', title: 'pnpm test --filter auth', input: { command: 'pnpm test --filter auth' } } },
  { type: 'run.item', item_type: 'tool_result', payload: { call_id: 'x1', status: 'ok', output_text: 'Test Files  6 passed (6)\nTests  42 passed (42)' } },
  { type: 'run.item', item_type: 'tool_call', payload: { call_id: 'x2', tool: 'Edit', title: 'src/auth/session.ts', input: { file_path: 'src/auth/session.ts' } } },
  { type: 'run.item', item_type: 'tool_result', payload: { call_id: 'x2', status: 'ok', diff: { path: 'src/auth/session.ts', unified: '@@ -18,7 +18,9 @@\n-  const ttl = 3600;\n+  const ttl = config.refreshTtlSeconds;\n+  rotateOnUse(session);\n   persist(session);\n' } } },
  { type: 'run.item', item_type: 'text_delta', payload: { text: 'Queue is short: session rotation is refactored.' } },
]) daemon.blobs.append('fixtures', evidenceRef, { ...event, ts: new Date().toISOString() });

// Hydration: the large-room regression room (codex #516). It carries a LIVE run
// with prose that must be fetched first and survive a reload, plus an empty
// interrupted run sitting seconds after a completed one by the same agent — the
// shape that used to group away and read as deleted. The e2e seeds the hundreds
// of archived runs on demand through /seed-runs.
daemon.spawnMember('hydration', { harness: 'fake', handle: 'archivist', cwd: dir });
const archivist = daemon.store.getMemberByHandle('hydration', 'archivist');
const seedRun = (body, run, events = []) => {
  const posted = daemon.store.postMessage('hydration', { author: archivist.id, kind: 'run', body });
  const eventsRef = `runs/${posted.id}.jsonl`;
  daemon.store.updateMessage('hydration', posted.id, { run: { ...run, tool_calls: 0, events_ref: eventsRef } });
  for (const event of events) daemon.blobs.append('hydration', eventsRef, event);
  return posted.id;
};
const proseEvent = (text, ts) => ({
  type: 'run.item', item_type: 'text_delta', payload: { text }, ts,
});
const minutesAgoIso = (m) => new Date(Date.now() - m * 60_000).toISOString();
// The three shapes under test are created by /seed-runs AFTER the archived bulk,
// so they hold the newest ids and survive the client's last-page trim.
let hydrationIds;

const musePost = daemon.postAgentMessage(
  'eng',
  muse.id,
  'I can pick up the pricing copy once the auth work lands.',
);
const chronologyProbe = daemon.store.postMessage('eng', {
  author: engOwner.id,
  kind: 'chat',
  body: 'chronology probe between the grouped messages',
});

// Backdate the seeded history so relative times and grouping boundaries are real.
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const backdate = (id, ts) =>
  daemon.store.db.prepare('UPDATE messages SET ts = ? WHERE room = ? AND id = ?').run(ts, 'eng', id);
const fableRun = daemon.store.listRunMessages('eng', { author: fable.id, limit: 1 })[0];
backdate(m1.id, minutesAgo(26));
backdate(chronologyProbe.id, minutesAgo(25.75));
backdate(m2.id, minutesAgo(25.5));
backdate(m3.id, minutesAgo(8));
if (fableRun) backdate(fableRun.id, minutesAgo(7.5));
backdate(musePost.id, minutesAgo(5));

// ── Ledger notes: a small linked vault for the graph ─────────────────────
for (const note of [
  { name: 'launch-plan', type: 'decision', body: '# Launch plan\n\nShip with [[risk-limits]] and [[wire-contract]].' },
  { name: 'risk-limits', type: 'constraint', body: '# Risk limits\n\nKeep exposure below 2%. Link back to [[launch-plan]].' },
  { name: 'wire-contract', type: 'contract', body: '# Wire contract\n\nFrames remain acknowledged. See [[launch-plan]].' },
  { name: 'release-checklist', type: 'decision', body: '# Release checklist\n\nConfirm [[wire-contract]].' },
]) {
  daemon.addLedgerNote('eng', { ...note, author: 'richard' });
}

// ── Held delivery (banner + release/redeliver) ───────────────────────────
const held = daemon.store.postMessage('eng', {
  author: engOwner.id,
  kind: 'chat',
  body: '@fable parked: rotate the API keys when convenient',
});
const heldDelivery = daemon.store.createDelivery('eng', {
  message_id: held.id,
  recipient: fable.id,
});
daemon.holdDelivery('eng', heldDelivery.id, 'operator asked to wait for the release window');

// ── Pending approval on @muse ────────────────────────────────────────────
fake.enqueue({
  kind: 'ask',
  card: {
    kind: 'approval',
    prompt: 'Run `git push origin main`?',
    options: [{ label: 'Allow' }, { label: 'Deny' }],
    tool: 'Bash',
    detail: 'git push origin main',
  },
  reply: (answer) => `push ${String(answer)}`,
});
daemon.postHumanMessage('eng', '@muse ship the pricing page copy update');
await new Promise((resolve) => setTimeout(resolve, 400));

// ── Live running run on @scout (items trickle, stays running) ────────────
fake.enqueue({
  kind: 'complete',
  final_text: 'Profile complete — the dashboard query needs a covering index.',
  // Long enough that the seeded "live" run stays visibly running for the whole
  // life of a screenshot or test session.
  item_delay_ms: 600_000,
  items: [
    {
      type: 'run.item',
      item_type: 'tool_call',
      payload: {
        call_id: 's1',
        tool: 'Bash',
        title: 'EXPLAIN ANALYZE SELECT * FROM dashboard_rollup',
        input: { command: 'psql -c "EXPLAIN ANALYZE SELECT * FROM dashboard_rollup"' },
      },
    },
    {
      type: 'run.item',
      item_type: 'tool_result',
      payload: { call_id: 's1', status: 'ok', output_text: 'Seq Scan on dashboard_rollup (cost=0.00..48210.11)' },
    },
    {
      type: 'run.item',
      item_type: 'tool_call',
      payload: {
        call_id: 's2',
        tool: 'Read',
        title: 'src/db/rollup.sql',
        input: { file_path: 'src/db/rollup.sql' },
      },
    },
  ],
});
daemon.postHumanMessage('eng', '@scout profile the slow dashboard query');
await new Promise((resolve) => setTimeout(resolve, 300));
daemon.store.postMessage('eng', {
  author: engOwner.id,
  kind: 'chat',
  body: 'chronology probe posted after the running turn started',
});

// ── Control endpoint: tests script upcoming fake turns just-in-time ──────
createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', async () => {
    let payload = {};
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/enqueue') {
        const body = raw === '' ? {} : JSON.parse(raw);
        for (const turn of body.turns ?? []) fake.enqueue(turn);
      }
      if (url.pathname === '/hold-compactions') {
        // Arm/release, not a timing race: the spec decides exactly how long a
        // compaction is in flight, so the busy state is observable on purpose.
        const body = raw === '' ? {} : JSON.parse(raw);
        if (body.held === false) fake.releaseCompactions();
        else fake.holdCompactions();
        if (body.usage !== undefined) fake.compactUsage = body.usage;
        payload = { held: body.held !== false };
      }
      if (url.pathname === '/complete-agent') {
        const body = raw === '' ? {} : JSON.parse(raw);
        const handle = String(body.handle ?? '');
        const member = daemon.store.getMemberByHandle('eng', handle);
        if (!member || member.kind !== 'agent') throw new Error(`no such agent: ${handle}`);
        const previousRunId = daemon.store.listRunMessages('eng', { author: member.id, limit: 1 })[0]?.id;
        fake.enqueue({ kind: 'complete', final_text: String(body.final_text ?? 'done') });
        daemon.postHumanMessage('eng', `@${handle} ${String(body.prompt ?? 'hydrate default')}`);
        let finalized = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          const latestRun = daemon.store.listRunMessages('eng', { author: member.id, limit: 1 })[0];
          if (latestRun?.id !== previousRunId && latestRun?.run?.status !== 'running') {
            finalized = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!finalized) throw new Error(`agent did not finalize: ${handle}`);
      }
      if (url.pathname === '/start-run') {
        // Fire an agent turn and return immediately (no wait for finalize) so a
        // test can act while the run is mid-stream. The next queued fake turn
        // drives it, so /enqueue its shape first.
        const body = raw === '' ? {} : JSON.parse(raw);
        const roomId = String(body.room ?? 'eng');
        const handle = String(body.handle ?? '');
        daemon.postHumanMessage(roomId, `@${handle} ${String(body.prompt ?? 'go')}`);
      }
      if (url.pathname === '/live-chat') {
        // Like /post-chat but through the daemon, so subscribers get the live
        // `message` frame — the arrival that a pinned transcript scrolls to.
        const body = raw === '' ? {} : JSON.parse(raw);
        const roomId = String(body.room ?? 'eng');
        const message = daemon.postHumanMessage(roomId, String(body.body ?? 'live arrival'));
        payload = { id: message.id, ts: message.ts };
      }
      if (url.pathname === '/post-chat') {
        // Insert a plain human chat straight into the store — NO routing, so it
        // starts no run and cannot default-route to the room's last agent. The
        // interleave test reloads to read it back, so no live broadcast needed.
        const body = raw === '' ? {} : JSON.parse(raw);
        const roomId = String(body.room ?? 'eng');
        const message = daemon.store.postMessage(roomId, {
          author: daemon.ownerOf(roomId).id,
          kind: 'chat',
          body: String(body.body ?? ''),
        });
        payload = { id: message.id, ts: message.ts };
      }
      if (url.pathname === '/git-reset') {
        // Revert the workspace repo to a clean tree so a test can prove the
        // working-tree-clean state after changes are resolved.
        execFileSync('git', ['checkout', '--', '.'], { cwd: workspaceRepo, env: gitEnv });
        execFileSync('git', ['clean', '-fd', '-q'], { cwd: workspaceRepo, env: gitEnv });
      }
      if (url.pathname === '/git-dirty') {
        // Re-dirty the workspace repo (inverse of /git-reset) for re-runs.
        dirtyWorkspace();
      }
      if (url.pathname === '/run-progress') {
        // Report an agent's latest run: its id, status, and how many prose
        // (text_delta) blocks are journaled so far. Journaling is live per event,
        // so a test can poll for block one, interject, then wait for completion.
        const body = raw === '' ? {} : JSON.parse(raw);
        const roomId = String(body.room ?? 'eng');
        const member = daemon.store.getMemberByHandle(roomId, String(body.handle ?? ''));
        const runMsg = member
          ? daemon.store.listRunMessages(roomId, { author: member.id, limit: 1 })[0]
          : undefined;
        const events = runMsg ? daemon.readRunBlob(roomId, runMsg.id) : [];
        const blocks = events.filter(
          (event) => event.type === 'run.item' && event.item_type === 'text_delta',
        ).length;
        payload = { runId: runMsg?.id ?? null, status: runMsg?.run?.status ?? null, blocks };
      }
      if (url.pathname === '/seed-runs') {
        // Hundreds of archived runs with journals — the large-room shape whose
        // hydration used to melt the browser's connection pool. Idempotent so a
        // spec can call it per run without re-seeding.
        const body = raw === '' ? {} : JSON.parse(raw);
        const count = Math.min(400, Number(body.count ?? 180));
        if (hydrationIds === undefined) {
          const base = Date.now() - (count + 30) * 60_000;
          // A uniquely-worded oldest message, hundreds of ids below the bounded
          // cold tail: the target for the beyond-the-tail deep-link assertion.
          const oldestId = daemon.store.postMessage('hydration', {
            author: daemon.ownerOf('hydration').id, kind: 'chat',
            body: 'oldest archive note: mariner beacon logged at the very start',
          }).id;
          // A second sentinel ~40 messages from the end: past the bounded tail, but
          // with plenty of history BELOW it, so "parked on the target" and
          // "snapped back to the tail" are visibly different positions.
          let nearTailId = 0;
          for (let i = 0; i < count; i++) {
            const ts = new Date(base + i * 60_000).toISOString();
            if (i === count - 40) {
              nearTailId = daemon.store.postMessage('hydration', {
                author: daemon.ownerOf('hydration').id, kind: 'chat',
                body: 'midway archive note: pelican waypoint, well above the tail',
              }).id;
            }
            seedRun(`archived run ${i + 1}`, {
              status: 'completed', started_ts: ts, ended_ts: ts, final_text: `archived run ${i + 1}`,
            }, [proseEvent(`archived run ${i + 1}`, ts)]);
          }
          const liveRunId = seedRun('', { status: 'running', started_ts: minutesAgoIso(1) }, [
            proseEvent('live hydration prose that must survive a reload', minutesAgoIso(1)),
          ]);
          const neighbourRunId = seedRun('neighbouring completed run', {
            status: 'completed', started_ts: minutesAgoIso(10), ended_ts: minutesAgoIso(10),
            final_text: 'neighbouring completed run',
          }, [proseEvent('neighbouring completed run', minutesAgoIso(10))]);
          // Empty + interrupted, half a minute after its neighbour by the same
          // agent: the same-author grouping window that used to swallow its
          // header and #id, making it read as deleted.
          const orphanRunId = seedRun('', {
            status: 'interrupted', started_ts: minutesAgoIso(10), ended_ts: minutesAgoIso(9.5),
            error: 'restarted mid-turn',
          });
          hydrationIds = { liveRunId, neighbourRunId, orphanRunId, oldestId, nearTailId };
        }
        payload = hydrationIds;
      }
      if (url.pathname === '/seed-bulk') {
        // A long back-catalog for virtualization/paging proofs: N backdated
        // owner messages inserted straight into the store.
        const body = raw === '' ? {} : JSON.parse(raw);
        const count = Math.min(2000, Number(body.count ?? 300));
        const roomId = body.room ?? 'eng';
        const author = daemon.ownerOf(roomId).id;
        const base = Date.now() - (count + 60) * 60_000;
        for (let i = 0; i < count; i++) {
          const message = daemon.store.postMessage(roomId, {
            author,
            kind: 'chat',
            body: `archive note #${i + 1}: nothing urgent, just history`,
          });
          daemon.store.db
            .prepare('UPDATE messages SET ts = ? WHERE room = ? AND id = ?')
            .run(new Date(base + i * 60_000).toISOString(), roomId, message.id);
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    } catch (error) {
      res.writeHead(400).end(String(error));
    }
  });
}).listen(CONTROL_PORT, '127.0.0.1');

// ── Serve: built SPA + API on one isolated port ──────────────────────────
const staticRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
await startServer({
  daemon,
  token: TOKEN,
  port: API_PORT,
  staticRoot,
  crypto,
  principals: [
    { token: VIEWER_TOKEN, member_id: viewer.id },
    { token: RECOVERY_VIEWER_TOKEN, member_id: onlooker.id },
  ],
});

console.log(`web-next harness ready
  data:   ${dir}
  api:    http://127.0.0.1:${API_PORT}
  spa:    http://127.0.0.1:${API_PORT}/?room=eng&token=${TOKEN}
  dev:    CODOR_NEXT_API_PORT=${API_PORT} pnpm dev  ->  http://localhost:5273/?room=eng&token=${TOKEN}`);
