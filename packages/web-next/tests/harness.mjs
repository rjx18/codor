// web-next fixture harness: boots an ISOLATED daemon + server (never the live
// codor.service) with a FakeAdapter and a representative seed — multi-channel rail,
// a multi-speaker conversation with 2-minute grouping cases, a completed run with
// tool + diff evidence, a live running run, a pending approval, and a held delivery.
// Playwright and the screenshot pipeline point the dev server (or the built SPA this
// serves) at it.
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
]) {
  daemon.createRoom({ id, name, owner });
  crypto.roomKeys.ensureRoom(id);
}

const engOwner = daemon.ownerOf('eng');
const fable = daemon.spawnMember('eng', { harness: 'fake', handle: 'fable', cwd: dir });
const scout = daemon.spawnMember('eng', { harness: 'fake', handle: 'scout', cwd: dir });
const muse = daemon.spawnMember('eng', { harness: 'fake', handle: 'muse', cwd: dir });

// Ops carries the failure state: a dead agent and an unhappy last word.
const relay = daemon.spawnMember('ops', { harness: 'fake', handle: 'relay', cwd: dir });
daemon.store.updateMember('ops', relay.id, { state: 'dead' });
daemon.postAgentMessage('ops', relay.id, 'deploy job exited 1 — rollback applied, needs a human look');

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
  items: [
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

const musePost = daemon.postAgentMessage(
  'eng',
  muse.id,
  'I can pick up the pricing copy once the auth work lands.',
);

// Backdate the seeded history so relative times and grouping boundaries are real.
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const backdate = (id, ts) =>
  daemon.store.db.prepare('UPDATE messages SET ts = ? WHERE room = ? AND id = ?').run(ts, 'eng', id);
const fableRun = daemon.store.listRunMessages('eng', { author: fable.id, limit: 1 })[0];
backdate(m1.id, minutesAgo(26));
backdate(m2.id, minutesAgo(25.5));
backdate(m3.id, minutesAgo(8));
if (fableRun) backdate(fableRun.id, minutesAgo(7.5));
backdate(musePost.id, minutesAgo(5));

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
  item_delay_ms: 45_000,
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

// ── Serve: built SPA + API on one isolated port ──────────────────────────
const staticRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
await startServer({
  daemon,
  token: TOKEN,
  port: API_PORT,
  staticRoot,
  crypto,
});

console.log(`web-next harness ready
  data:   ${dir}
  api:    http://127.0.0.1:${API_PORT}
  spa:    http://127.0.0.1:${API_PORT}/?room=eng&token=${TOKEN}
  dev:    CODOR_NEXT_API_PORT=${API_PORT} pnpm dev  ->  http://localhost:5273/?room=eng&token=${TOKEN}`);
