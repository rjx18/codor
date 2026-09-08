// Run against an npm-packed, locally installed package, never workspace imports.
// Usage: node scripts/p6-installed-proof.mjs <installed @richhardry/codor root> <proof directory>
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = resolve(process.argv[2]);
const proofRoot = resolve(process.argv[3]);
mkdirSync(proofRoot, { recursive: true });
const requireInstalled = createRequire(join(packageRoot, 'package.json'));
const WebSocket = requireInstalled('ws');
const Database = requireInstalled('better-sqlite3');
const bin = join(packageRoot, 'bin/codor.mjs');
const data = join(proofRoot, 'data');
const token = 'p6-isolated-installed-proof';
// Never inherit the running agent's socket, room or member credential.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CODOR_')));
env.CODOR_TOKEN = token;
const module = pathToFileURL(join(packageRoot, 'node_modules/@codor/switchboard/dist/index.js')).href;
const adapter = join(proofRoot, 'proof-adapter.mjs');
writeFileSync(adapter, `import { FakeAdapter } from ${JSON.stringify(module)};\nexport function createAdapter() { return new FakeAdapter('proof'); }\n`);
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const cli = (...args) => execFileSync(process.execPath, [bin, '--data-dir', data, ...args], { env, encoding: 'utf8' });
let child;
const sockets = new Set();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, label) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await check()) return; await pause(50); }
  throw new Error(`timed out: ${label}`);
};
const database = () => {
  // The CLI contract names its main database switchboard.sqlite.
  return new Database(join(data, 'switchboard.sqlite'), { readonly: true, fileMustExist: true });
};
const query = (sql, ...args) => { const db = database(); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
async function start() {
  child = spawn(process.execPath, [bin, '--data-dir', data, 'up', '--host', '127.0.0.1', '--port', String(port),
    '--adapter', `proof=${adapter}`, '--channel', 'proof', '--channel-name', 'Proof', '--owner', 'proof'],
  { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
    output = (output + chunk).slice(-16_000);
    writeFileSync(join(proofRoot, 'daemon.log'), output);
  });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`installed daemon exited: ${output}`);
    try {
      const response = await fetch(base + '/api/client-compatibility', { headers: { authorization: `Bearer ${token}` } });
      return response.ok && (await response.json()).post_acknowledgements === true;
    } catch { return false; }
  }, 'installed daemon ready');
}
async function stop(signal = 'SIGTERM') {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) { child = undefined; return; }
  for (const ws of sockets) ws.terminate(); sockets.clear();
  const exited = once(child, 'exit'); child.kill(signal); await exited; child = undefined;
}
async function socket() {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws?token=' + token);
  sockets.add(ws); await once(ws, 'open'); return ws;
}
async function post(frame) {
  const ws = await socket();
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('installed acknowledgement timeout')), 5000);
    ws.on('message', (raw) => {
      const response = JSON.parse(String(raw));
      if (response.submission_id !== frame.submission_id) return;
      clearTimeout(timer);
      if (response.type === 'error') reject(new Error(response.message)); else resolve(response);
    });
  });
  ws.send(JSON.stringify(frame));
  const accepted = await result; ws.close(); return accepted;
}
async function browserRestartProof() {
  const { chromium } = createRequire(new URL('../packages/web-next/package.json', import.meta.url))('@playwright/test');
  const { startMockRelay } = await import('../packages/web-next/tests/mock-relay.mjs');
  const relay = await startMockRelay();
  const webRoot = join(packageRoot, 'node_modules/@codor/cli/runtime/web');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
  const spa = createHttpServer((req, res) => {
    const path = resolve(webRoot, '.' + new URL(req.url, 'http://test').pathname);
    const file = path.startsWith(webRoot + '/') && existsSync(path) && statSync(path).isFile()
      ? path : join(webRoot, 'index.html');
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  spa.listen(0, '127.0.0.1'); await once(spa, 'listening');
  const spaOrigin = `http://127.0.0.1:${spa.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const proofs = [];
  try {
    for (const hosted of [false, true]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(({ hosted, relayUrl }) => {
        if (hosted) window.__CODOR_RELAY_URL = relayUrl;
        window.__p6DropAcknowledgements = true;
        window.__p6Acknowledgements = [];
        const parse = JSON.parse;
        JSON.parse = function (...args) {
          const value = parse(...args);
          if (value?.type === 'self') window.__p6SelfFrame = value;
          if (value?.type === 'post_accepted') {
            window.__p6Acknowledgements.push(value);
            // Suppress acknowledgement consumption in both transports by
            // replaying an already received ordinary self frame. Keep the mux
            // callback intact: an injected exception would test parser failure.
            if (window.__p6DropAcknowledgements) return window.__p6SelfFrame;
          }
          return value;
        };
      }, { hosted, relayUrl: relay.url });
      const errors = [];
      page.on('pageerror', (error) => { errors.push(error.stack ?? error.message); });
      if (hosted) {
        const enabled = await fetch(base + '/api/relay/enable', { method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ url: relay.url }) });
        assert.equal(enabled.status, 200);
        const offered = await fetch(base + '/api/relay/pair', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
        const pairing = await offered.json(); assert.ok(pairing.code);
        await page.goto(spaOrigin);
        await page.getByTestId('pairing-code-0').evaluate((element, code) => {
          const data = new DataTransfer(); data.setData('text/plain', code);
          element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
        }, pairing.code);
        await page.getByTestId('pairing-code-submit').click();
      } else await page.goto(base + '/?token=' + token + '&room=proof');
      await page.waitForFunction(() => window.__codor?.postAcknowledgements === true && window.__codor?.state() === 'connected');
      const body = `@proof installed browser restart ${hosted ? 'hosted' : 'direct'}`;
      await page.getByTestId('composer-input').fill(body);
      await page.getByTestId('composer-send').click();
      await page.waitForFunction(() => window.__p6Acknowledgements.length > 0);
      assert.equal(await page.evaluate(() => window.__codor.submissionPending), true);
      const original = await page.evaluate(() => window.__p6Acknowledgements[0]);
      assert.equal(query('SELECT submission_id FROM post_receipts WHERE submission_id = ?', original.submission_id).length, 1);
      const edited = `@proof edited while ${hosted ? 'hosted' : 'direct'} is offline`;
      await page.getByTestId('composer-input').fill(edited);
      await stop('SIGKILL');
      await page.evaluate(() => { window.__p6DropAcknowledgements = false; });
      await start();
      await page.waitForFunction(() => window.__codor?.submissionPending === false && window.__p6Acknowledgements.length >= 2, null, { timeout: 45_000 });
      const received = await page.evaluate(() => window.__p6Acknowledgements);
      assert.deepEqual(received.at(-1), original);
      assert.equal(await page.getByTestId('composer-input').inputValue(), edited);
      assert.equal(query('SELECT id FROM messages WHERE room = ? AND body = ?', 'proof', body).length, 1);
      // The exact clean pre-P6 installed browser reproduces one coalescer
      // flush after relay teardown with channel already cleared (18ee45c2).
      // Record that inherited P5 diagnostic explicitly; every other error fails.
      const inheritedErrors = errors.filter((error) => hosted
        && error.includes("Cannot read properties of undefined (reading 'seal')")
        && error.includes('.onPacket') && error.includes('.flush'));
      assert.deepEqual(errors.filter((error) => !inheritedErrors.includes(error)), []);
      assert.ok(inheritedErrors.length <= 1);
      proofs.push({ inherited_p5_teardown_errors: inheritedErrors, transport: hosted ? 'hosted' : 'direct', submission_id: original.submission_id,
        message_id: original.outcome.message_id, same_id_after_sigkill: true, edited_draft_preserved: true });
      await context.close();
    }
    return proofs;
  } finally {
    await browser.close();
    await new Promise((resolve) => spa.close(resolve));
    await relay.close();
  }
}

try {
  const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
  await start();
  for (const handle of ['alpha', 'beta']) {
    cli('agent', 'add', handle, '--channel', 'proof', '--adapter', 'proof', '--cwd', proofRoot, '--json');
    cli('agent', 'pause', handle, '--channel', 'proof', '--json');
  }
  const uploaded = await fetch(base + '/api/rooms/proof/attachments?name=proof.txt', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: 'installed bytes',
  });
  assert.equal(uploaded.status, 200);
  const file = await uploaded.json();
  const frame = { type: 'post', room: 'proof', submission_id: 'packed-original', body: '@alpha @beta packed atomic group',
    attachments: [file.id], voice: { duration_seconds: 2, levels: [2, 8, 3] } };
  const lost = await socket();
  // Deliberately install no message consumer. Observe durable commit from a
  // separate SQLite reader and kill the installed daemon before any ack is used.
  lost.send(JSON.stringify(frame));
  await until(() => query('SELECT outcome FROM post_receipts WHERE submission_id = ?', frame.submission_id).length === 1, 'receipt commit');
  const original = JSON.parse(query('SELECT outcome FROM post_receipts WHERE submission_id = ?', frame.submission_id)[0].outcome);
  assert.equal(original.kind, 'message'); assert.equal(original.delivery_ids.length, 2); assert.ok(original.group_id);
  await stop('SIGKILL'); await start();
  assert.deepEqual((await post(frame)).outcome, original);
  assert.deepEqual((await post(frame)).outcome, original);
  assert.equal(query('SELECT id FROM collaboration_groups WHERE id = ?', original.group_id).length, 1);
  assert.equal(query('SELECT id FROM deliveries WHERE room = ? AND message_id = ?', 'proof', original.message_id).length, 2);
  const scheduleFrame = { type: 'post', room: 'proof', submission_id: 'packed-schedule', body: '[send_in=1h] @alpha packed schedule' };
  const scheduled = (await post(scheduleFrame)).outcome;
  assert.equal(scheduled.kind, 'schedule');
  await stop('SIGKILL'); await start();
  assert.deepEqual((await post(scheduleFrame)).outcome, scheduled);
  const deletion = await socket();
  deletion.send(JSON.stringify({ type: 'act', room: 'proof', act: { act: 'delete_message', message_id: original.message_id } }));
  await until(() => query('SELECT deleted FROM messages WHERE room = ? AND id = ?', 'proof', original.message_id)[0].deleted === 1, 'deletion tombstone');
  assert.deepEqual((await post(frame)).outcome, original);
  assert.equal(query('SELECT deleted FROM messages WHERE room = ? AND id = ?', 'proof', original.message_id)[0].deleted, 1);
  const browserRestarts = await browserRestartProof();
  const proof = { version, installed_package: packageRoot, port, message: original, schedule: scheduled,
    receipts: query('SELECT submission_id FROM post_receipts').length,
    message_count: query('SELECT id FROM messages WHERE room = ? AND id = ?', 'proof', original.message_id).length,
    delivery_count: query('SELECT id FROM deliveries WHERE room = ? AND message_id = ?', 'proof', original.message_id).length,
    tombstone: true, daemon_sigkills: 4, browser_restarts: browserRestarts };
  writeFileSync(join(proofRoot, 'evidence.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} finally { await stop(); }
