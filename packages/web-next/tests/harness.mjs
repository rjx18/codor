// web-next fixture harness: boots an ISOLATED daemon + server (never the live
// codor.service) with a FakeAdapter and a representative seed — multi-channel rail,
// a multi-speaker conversation with 2-minute grouping cases, a completed run with
// tool + diff evidence, a live running run, a pending approval, and a held delivery.
// Playwright and the screenshot pipeline point the dev server (or the built SPA this
// serves) at it.
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
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
