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
  ['acks', 'Acknowledgements'],
  ['inbox', 'Inbox Fixtures'],
  ['chronology', 'Chronology'],
  ['continuations', 'Continuation Fixtures'],
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
const analyst = daemon.store.addMember('research', {
  kind: 'human', handle: 'analyst', display_name: 'Analyst', role: 'member',
});
daemon.postHumanMessage('research', 'collected the retrieval eval traces for tomorrow', {
  author: analyst.id,
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

// Acknowledgements are finalized runs but remain dedicated quiet transcript
// rows after a cold refresh; they never enter the journal-segmentation path.
const acknowledger = daemon.spawnMember('acks', { harness: 'fake', handle: 'acknowledger', cwd: dir });
const ackTs = new Date().toISOString();
daemon.store.postMessage('acks', {
  author: acknowledger.id,
  kind: 'run',
  body: '<ACK_OK>',
  ack: true,
  run: {
    status: 'completed',
    started_ts: ackTs,
    ended_ts: ackTs,
    tool_calls: 0,
    events_ref: 'runs/ack.jsonl',
    final_text: '<ACK_OK>',
  },
});

// Inbox support must be self-contained even when the source mention sits far
// outside the strict transcript tail. A second, newest mention exercises the
// true reply_to path without opening/marking the inbox row first.
const inboxOwner = daemon.ownerOf('inbox');
const inboxAnalyst = daemon.store.addMember('inbox', {
  kind: 'human', handle: 'inbox-analyst', display_name: 'Inbox Analyst', role: 'member',
});
daemon.store.addMember('inbox', {
  kind: 'human', handle: 'inbox-reviewer', display_name: 'Inbox Reviewer', role: 'member',
});
const oldInboxMention = daemon.postHumanMessage(
  'inbox',
  '@richard old incident report needs your review',
  { author: inboxAnalyst.id },
);
for (let index = 0; index < 25; index += 1) {
  daemon.store.postMessage('inbox', {
    author: inboxOwner.id,
    kind: 'chat',
    body: `inbox filler ${String(index + 1)}`,
  });
}
const newInboxMention = daemon.postHumanMessage(
  'inbox',
  '@richard newest incident report needs your reply',
  { author: inboxAnalyst.id },
);

// Chronology is isolated from the busy eng room so strict 20-row hydration
// never pushes the ordering/grouping subjects out of the initial window.
const chronologyOwner = daemon.ownerOf('chronology');
const chronologyAgent = daemon.spawnMember('chronology', { harness: 'fake', handle: 'chronos', cwd: dir });
const chronologyMuse = daemon.spawnMember('chronology', { harness: 'fake', handle: 'chronology-muse', cwd: dir });
const chronologyScout = daemon.spawnMember('chronology', { harness: 'fake', handle: 'chronology-scout', cwd: dir });
const chronoTs = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const chronoMessage = (body) => daemon.store.postMessage('chronology', {
  author: chronologyOwner.id, kind: 'chat', body,
});
const chronoOne = chronoMessage('morning chronology marker');
const chronoProbe = chronoMessage('chronology probe between the grouped messages');
const chronoTwo = chronoMessage('staging chronology marker');
const chronoFresh = chronoMessage('later chronology marker');
for (const [id, ts] of [
  [chronoOne.id, chronoTs(26)],
  [chronoProbe.id, chronoTs(25.75)],
  [chronoTwo.id, chronoTs(25.5)],
  [chronoFresh.id, chronoTs(8)],
]) daemon.store.db.prepare('UPDATE messages SET ts = ? WHERE room = ? AND id = ?').run(ts, 'chronology', id);
const chronoMusePost = daemon.store.postMessage('chronology', {
  author: chronologyMuse.id, kind: 'chat', body: 'chronology muse before the completed run',
});
daemon.store.db.prepare('UPDATE messages SET ts = ? WHERE room = ? AND id = ?')
  .run(chronoTs(5), 'chronology', chronoMusePost.id);
const chronoRunTs = chronoTs(4);
const chronoRunRef = 'runs/chronology-complete.jsonl';
const chronoRun = daemon.store.postMessage('chronology', {
  author: chronologyAgent.id,
  kind: 'run',
  body: 'chronology completed run',
  run: {
    status: 'completed', started_ts: chronoRunTs, ended_ts: chronoRunTs,
    tool_calls: 0, events_ref: chronoRunRef, final_text: 'chronology completed run',
  },
});
daemon.blobs.append('chronology', chronoRunRef, {
  type: 'run.item', item_type: 'text_delta', payload: { text: 'chronology completed run' }, ts: chronoRunTs,
});
const chronoRunning = daemon.store.postMessage('chronology', {
  author: chronologyScout.id,
  kind: 'run',
  body: '',
  run: {
    status: 'running', started_ts: chronoTs(3), tool_calls: 0,
    events_ref: 'runs/chronology-running.jsonl',
  },
});
const chronoAfter = chronoMessage('chronology chat after the running turn started');
daemon.store.db.prepare('UPDATE messages SET ts = ? WHERE room = ? AND id = ?')
  .run(chronoTs(2), 'chronology', chronoAfter.id);

// Continuations: every repetition gets its OWN room, then the control endpoint
// drives the production writer through a real FakeAdapter turn while the browser
// is already subscribed. No row or journal event is seeded by hand.
let continuationRoomSeq = 0;
const createContinuationRoom = () => {
  const id = `continuations-${String(++continuationRoomSeq)}`;
  daemon.createRoom({ id, name: `Continuations ${String(continuationRoomSeq)}`, owner });
  crypto.roomKeys.ensureRoom(id);
  daemon.spawnMember(id, { harness: 'fake', handle: 'continuator', cwd: dir });
  return id;
};
/**
 * Seed a terminal run FAMILY in a fresh room, in one of the two shapes live
 * traffic actually produced. Both are durable data the writer already emits;
 * nothing here widens FakeAdapter or the switchboard protocol.
 *
 *   'root-evidence'  — #833 -> #835: prose + tools on the root, empty result.
 *   'result-evidence' — #856 -> #858: empty root, prose on the terminal result.
 */
const seedTerminalFamily = (shape, status, gap = 0) => {
  const roomId = createContinuationRoom();
  const agent = daemon.store.getMemberByHandle(roomId, 'continuator');
  const ts = new Date().toISOString();
  const ref = 'runs/family-root.jsonl';
  const rootBody = shape === 'root-evidence' ? 'Root stretch before the stop.' : '';
  const root = daemon.store.postMessage(roomId, {
    author: agent.id,
    kind: 'run',
    body: rootBody,
    run: {
      status,
      started_ts: ts,
      ended_ts: ts,
      tool_calls: shape === 'root-evidence' ? 2 : 0,
      events_ref: ref,
      output_mode: 'messages',
      ...(shape === 'root-evidence' ? {} : { error: `run ${status} before any output` }),
    },
  });
  // An operator row between root and result, exactly as the live families had:
  // it is what makes the result its own turn with its own permalink rather than
  // a grouped continuation of the root.
  const interjection = daemon.store.postMessage(roomId, {
    author: daemon.ownerOf(roomId).id,
    kind: 'chat',
    body: 'Operator interjection between the two stretches.',
  });
  // Optional filler pushes the ROOT outside the bounded hydration tail while
  // the result stays inside it — the out-of-window case.
  const filler = [];
  for (let index = 0; index < gap; index++) {
    // Deliberately TALL: with one-line rows the 20-message tail fits the
    // viewport exactly, the timeline never overflows, and no upward scroll
    // event fires — so no history request is ever made and paging cannot be
    // exercised at all.
    filler.push(daemon.store.postMessage(roomId, {
      author: daemon.ownerOf(roomId).id,
      kind: 'chat',
      body: [
        `filler ${String(index + 1)} between the family rows`,
        'second line of this filler row',
        'third line of this filler row',
        'fourth line of this filler row',
      ].join('\n'),
    }));
  }
  const resultBody = shape === 'root-evidence' ? '' : 'Result stretch carrying the only prose.';
  const result = daemon.store.postMessage(roomId, {
    author: agent.id, kind: 'run', body: resultBody, run_parent_id: root.id,
  });
  const events = [];
  if (shape === 'root-evidence') {
    events.push(
      { type: 'run.item', item_type: 'text_delta', output_message_id: root.id, payload: { text: rootBody }, ts },
      { type: 'run.item', item_type: 'tool_call', output_message_id: root.id, payload: { call_id: 'f1', tool: 'Read', title: 'Read fixture', input: { file_path: 'src/a.ts' } }, ts },
      { type: 'run.item', item_type: 'tool_result', output_message_id: root.id, payload: { call_id: 'f1', status: 'ok', output_text: 'read ok' }, ts },
      { type: 'run.item', item_type: 'tool_call', output_message_id: root.id, payload: { call_id: 'f2', tool: 'Edit', title: 'Edit fixture', input: { file_path: 'src/b.ts' } }, ts },
      { type: 'run.item', item_type: 'tool_result', output_message_id: root.id, payload: { call_id: 'f2', status: 'ok', output_text: 'edit ok' }, ts },
    );
  } else {
    events.push({ type: 'run.item', item_type: 'text_delta', output_message_id: result.id, payload: { text: resultBody }, ts });
  }
  // The authoritative terminal event names the row that owns the result, which
  // is what the UI must use when the root has fallen outside the tail.
  events.push({ type: 'run.completed', status, output_message_id: result.id, ts });
  for (const event of events) daemon.blobs.append(roomId, ref, event);
  for (const message of [root, interjection, ...filler, result]) daemon.emitMessage(roomId, message);
  return { room: roomId, root: root.id, result: result.id, status };
};

/**
 * A LIVE family the spec drives step by step, so ownership changes are observed
 * rather than posed: start a running root, then interleave human rows and
 * continuations. Every step emits durable rows the writer already produces.
 */
const liveFamilies = new Map();
const startLiveFamily = (handle, existingRoom) => {
  const roomId = existingRoom ?? createContinuationRoom();
  if (handle !== 'continuator') daemon.spawnMember(roomId, { harness: 'fake', handle, cwd: dir });
  const agent = daemon.store.getMemberByHandle(roomId, handle);
  const startedTs = new Date(Date.now() - 90_000).toISOString(); // a clock already running
  const ref = `runs/live-${String(agent.id)}.jsonl`;
  const root = daemon.store.postMessage(roomId, {
    author: agent.id,
    kind: 'run',
    // A running run's body is empty until it finalizes — the prose arrives as
    // streamed evidence, which is exactly what makes the row evidence-free
    // until the spec sends it.
    body: '',
    run: {
      status: 'running',
      started_ts: startedTs,
      tool_calls: 2,
      events_ref: ref,
      output_mode: 'messages',
    },
  });
  // Deliberately NO evidence yet: the spec asks for it after it has subscribed,
  // because a run_event emitted before then is correctly dropped on the floor.
  daemon.emitMessage(roomId, root);
  // The typing pill keys off MEMBER state, so a live fixture has to say the
  // agent is running, not merely leave a running run row behind.
  daemon.emitMember(roomId, daemon.store.updateMember(roomId, agent.id, { state: 'running' }));
  liveFamilies.set(`${roomId}:${handle}`, { roomId, agentId: agent.id, ref, rootId: root.id, startedTs });
  return { room: roomId, root: root.id, started_ts: startedTs };
};

const liveFamilyStep = (roomId, handle, step, body) => {
  const family = liveFamilies.get(`${roomId}:${handle}`);
  if (!family) throw new Error(`no live family: ${roomId}:${handle}`);
  if (step === 'interject') {
    const row = daemon.store.postMessage(roomId, {
      author: daemon.ownerOf(roomId).id, kind: 'chat', body: body ?? 'Operator interjection.',
    });
    daemon.emitMessage(roomId, row);
    return { id: row.id };
  }
  if (step === 'evidence') {
    const events = [
      { type: 'run.item', item_type: 'text_delta', output_message_id: family.rootId, payload: { text: 'Live root stretch.' }, ts: family.startedTs },
      { type: 'run.item', item_type: 'tool_call', output_message_id: family.rootId, payload: { call_id: 'l1', tool: 'Read', title: 'Read live fixture', input: { file_path: 'src/live.ts' } }, ts: family.startedTs },
      { type: 'run.item', item_type: 'tool_result', output_message_id: family.rootId, payload: { call_id: 'l1', status: 'ok', output_text: 'live read ok' }, ts: family.startedTs },
      { type: 'run.item', item_type: 'tool_call', output_message_id: family.rootId, payload: { call_id: 'l2', tool: 'Edit', title: 'Edit live fixture', input: { file_path: 'src/live-b.ts' } }, ts: family.startedTs },
      { type: 'run.item', item_type: 'tool_result', output_message_id: family.rootId, payload: { call_id: 'l2', status: 'ok', output_text: 'live edit ok' }, ts: family.startedTs },
    ];
    events.forEach((event, index) => {
      daemon.blobs.append(roomId, family.ref, event);
      daemon.emit(roomId, { type: 'run_event', room: roomId, message_id: family.rootId, event, index });
    });
    return { id: family.rootId };
  }
  if (step === 'continue') {
    const text = body ?? 'Live continuation stretch.';
    const row = daemon.store.postMessage(roomId, {
      author: family.agentId, kind: 'run', body: text, run_parent_id: family.rootId,
    });
    const event = {
      type: 'run.item', item_type: 'text_delta', output_message_id: row.id,
      payload: { text }, ts: new Date().toISOString(),
    };
    daemon.blobs.append(roomId, family.ref, event);
    daemon.emitMessage(roomId, row);
    daemon.emit(roomId, { type: 'run_event', room: roomId, message_id: family.rootId, event, index: 90 });
    return { id: row.id };
  }
  if (step === 'interrupt') {
    const rows = daemon.store.listMessages(roomId, { limit: 500 })
      .filter((message) => message.id === family.rootId || message.run_parent_id === family.rootId);
    const owner = rows.at(-1);
    daemon.blobs.append(roomId, family.ref, {
      type: 'run.completed', status: 'interrupted', output_message_id: owner.id,
      ts: new Date().toISOString(),
    });
    const root = daemon.store.getMessage(roomId, family.rootId);
    const settled = daemon.store.updateMessage(roomId, family.rootId, {
      run: {
        ...root.run,
        status: 'interrupted',
        ended_ts: new Date().toISOString(),
        result_message_id: owner.id,
      },
    });
    daemon.emitMessage(roomId, settled);
    daemon.emitMember(roomId, daemon.store.updateMember(roomId, family.agentId, { state: 'idle' }));
    return { id: owner.id };
  }
  throw new Error(`unknown live family step: ${step}`);
};

/**
 * A LEGACY one-row family: a single run message whose evidence is split into
 * stretches by an interleaved human row. No continuations, no output_mode —
 * this is stored history, and it has to stay readable.
 */
const seedHistoricalFamily = (shape, status) => {
  const roomId = createContinuationRoom();
  const agent = daemon.store.getMemberByHandle(roomId, 'continuator');
  const ts = new Date().toISOString();
  const ref = 'runs/legacy-root.jsonl';
  const run = daemon.store.postMessage(roomId, {
    author: agent.id,
    kind: 'run',
    body: shape === 'partial' ? 'Legacy stretch one.' : '',
    run: {
      status,
      started_ts: ts,
      ended_ts: ts,
      tool_calls: 0,
      events_ref: ref,
      ...(shape === 'partial' ? {} : { error: `legacy run ${status} with no output` }),
    },
  });
  if (shape === 'partial') {
    for (const event of [
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'Legacy stretch one.' }, ts },
      { type: 'run.item', item_type: 'text_delta', payload: { text: 'Legacy stretch two.' }, ts },
    ]) daemon.blobs.append(roomId, ref, event);
  }
  daemon.emitMessage(roomId, run);
  return { room: roomId, run: run.id, status };
};

const waitForContinuation = async (read, predicate, label) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`continuation fixture timed out: ${label}`);
};
const runContinuation = async (roomId) => {
  const continuationAgent = daemon.store.getMemberByHandle(roomId, 'continuator');
  if (!continuationAgent) throw new Error(`continuation room has no agent: ${roomId}`);
  const interject = (body) => {
    // Persist and fan out the operator row without creating a second delivery:
    // this fixture is isolating one engine turn's output segmentation, not the
    // default-recipient queue that a subsequent operator instruction exercises.
    const message = daemon.store.postMessage(roomId, {
      author: daemon.ownerOf(roomId).id,
      kind: 'chat',
      body,
    });
    daemon.emitMessage(roomId, message);
    return message;
  };

  fake.enqueue({
    kind: 'complete',
    final_text: 'First durable stretch before the operator replied. Second durable stretch after the operator replied.',
    item_delay_ms: 120,
    items: [
      {
        type: 'run.item', item_type: 'text_delta',
        payload: { text: 'First durable stretch before the operator replied. ' },
      },
      {
        type: 'run.item', item_type: 'tool_call',
        payload: {
          call_id: 'continuation-read', tool: 'Read', title: 'Read source fixture',
          input: { file_path: 'src/input.ts' },
        },
      },
      {
        type: 'run.item', item_type: 'reasoning_summary',
        payload: { text: '' },
      },
      {
        type: 'run.item', item_type: 'tool_result',
        payload: { call_id: 'continuation-read', status: 'ok', output_text: 'source ready' },
      },
      {
        type: 'run.item', item_type: 'tool_call',
        payload: {
          call_id: 'continuation-edit', tool: 'Edit', title: 'Edit continuation fixture',
          input: { file_path: 'src/output.ts' },
        },
      },
      {
        type: 'run.item', item_type: 'tool_result',
        payload: { call_id: 'continuation-edit', status: 'ok', output_text: 'fixture updated' },
      },
      {
        type: 'run.item', item_type: 'text_delta',
        payload: { text: 'Second durable stretch after the operator replied.' },
      },
    ],
  });

  const trigger = daemon.postHumanMessage(roomId, '@continuator stream a durable answer');
  const root = await waitForContinuation(
    () => daemon.store.listRunMessages(roomId, { author: continuationAgent.id, limit: 1 })[0],
    (message) => message?.run?.status === 'running',
    'main root to start',
  );
  await waitForContinuation(
    () => daemon.readRunBlob(roomId, root.id),
    (events) => events.some((event) =>
      event.type === 'run.item'
      && event.item_type === 'tool_result'
      && event.payload.call_id === 'continuation-edit'),
    'root tool batch to finish',
  );
  const interjection = interject('Operator interjection must stay between both stretches.');
  await waitForContinuation(
    () => daemon.store.getMessage(roomId, root.id),
    (message) => message?.run?.status !== 'running',
    'main root to finalize',
  );
  const tail = daemon.store.listRunContinuations(roomId, root.id)[0];
  if (!tail) throw new Error('production writer did not create the continuation row');

  // A final-only acknowledgement after an interjection must allocate its terminal
  // result row, yet the reader presents exactly one Acknowledged row for the family.
  fake.enqueue({ kind: 'complete', final_text: '<ACK_OK>', delay_ms: 150 });
  const ackTrigger = daemon.postHumanMessage(roomId, '@continuator acknowledge silently');
  const ackRoot = await waitForContinuation(
    () => daemon.store.listRunMessages(roomId, { author: continuationAgent.id, limit: 1 })[0],
    (message) => message?.id !== root.id && message?.run?.status === 'running',
    'ack root to start',
  );
  const ackInterjection = interject('Operator interjection before the acknowledgement result.');
  const settledAckRoot = await waitForContinuation(
    () => daemon.store.getMessage(roomId, ackRoot.id),
    (message) => message?.run?.status !== 'running',
    'ack root to finalize',
  );
  const ackResultId = settledAckRoot?.run?.result_message_id;
  if (ackResultId === undefined || ackResultId === ackRoot.id) {
    throw new Error('production writer did not allocate the acknowledgement result row');
  }

  return {
    room: roomId,
    main: {
      trigger: trigger.id,
      root: root.id,
      interjection: interjection.id,
      tail: tail.id,
    },
    ack: {
      trigger: ackTrigger.id,
      root: ackRoot.id,
      interjection: ackInterjection.id,
      result: ackResultId,
    },
  };
};

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
        const author = body.author === undefined
          ? daemon.ownerOf(roomId)
          : daemon.store.getMemberByHandle(roomId, String(body.author));
        if (!author) throw new Error(`no such author: ${String(body.author)}`);
        let message;
        if (author.kind === 'agent') {
          message = daemon.postAgentMessage(roomId, author.id, String(body.body ?? 'live arrival'));
        } else if (body.route === false) {
          // Some visual-only regressions need a live durable arrival without
          // also exercising the room's default-recipient delivery chain.
          message = daemon.store.postMessage(roomId, {
            author: author.id,
            kind: 'chat',
            body: String(body.body ?? 'live arrival'),
          });
          daemon.emitMessage(roomId, message);
        } else {
          message = daemon.postHumanMessage(roomId, String(body.body ?? 'live arrival'), {
            author: author.id,
          });
        }
        payload = { id: message.id, ts: message.ts };
      }
      if (url.pathname === '/tail-ids') {
        const body = raw === '' ? {} : JSON.parse(raw);
        const roomId = String(body.room ?? 'eng');
        const limit = Math.max(1, Math.min(100, Number(body.limit ?? 20)));
        payload = { ids: daemon.store.listMessages(roomId, { limit }).map((message) => message.id) };
      }
      if (url.pathname === '/room-support') {
        const body = raw === '' ? {} : JSON.parse(raw);
        const roomId = String(body.room ?? 'eng');
        payload = daemon.store.roomSupport(roomId, daemon.ownerOf(roomId).id);
      }
      if (url.pathname === '/fixture-ids') {
        payload = {
          oldInboxMention: oldInboxMention.id,
          newInboxMention: newInboxMention.id,
        };
      }
      if (url.pathname === '/seed-historical-family') {
        const body = raw === '' ? {} : JSON.parse(raw);
        payload = seedHistoricalFamily(
          String(body.shape ?? 'partial'), String(body.status ?? 'interrupted'),
        );
      }
      if (url.pathname === '/live-family') {
        const body = raw === '' ? {} : JSON.parse(raw);
        payload = startLiveFamily(
          String(body.handle ?? 'continuator'),
          body.room === undefined ? undefined : String(body.room),
        );
      }
      if (url.pathname === '/live-family-step') {
        const body = raw === '' ? {} : JSON.parse(raw);
        payload = liveFamilyStep(
          String(body.room), String(body.handle ?? 'continuator'),
          String(body.step), body.body === undefined ? undefined : String(body.body),
        );
      }
      if (url.pathname === '/seed-terminal-family') {
        const body = raw === '' ? {} : JSON.parse(raw);
        payload = seedTerminalFamily(
          String(body.shape ?? 'root-evidence'),
          String(body.status ?? 'interrupted'),
          Number(body.gap ?? 0),
        );
      }
      if (url.pathname === '/continuation-room') {
        // Handed out empty, so the spec can be watching before the rows land.
        payload = { room: createContinuationRoom() };
      }
      if (url.pathname === '/run-continuation') {
        const body = raw === '' ? {} : JSON.parse(raw);
        payload = await runContinuation(String(body.room ?? createContinuationRoom()));
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
        payload = {
          runId: runMsg?.id ?? null,
          status: runMsg?.run?.status ?? null,
          blocks,
          outputIds: runMsg === undefined
            ? []
            : [runMsg.id, ...daemon.store.listRunContinuations(roomId, runMsg.id).map((message) => message.id)],
        };
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
