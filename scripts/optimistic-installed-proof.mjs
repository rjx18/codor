// Read only installed package code; all runtime state belongs to this disposable proof.
// Usage: node scripts/optimistic-installed-proof.mjs <installed-package-root> <proof-root>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]), proof = resolve(process.argv[3]);
mkdirSync(proof, { recursive: true });
const WebSocket = createRequire(join(root, 'package.json'))('ws');
const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const token = 'isolated-correlation-proof', base = `http://127.0.0.1:${port}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CODOR_')));
env.CODOR_TOKEN = token;
let child;
const sockets = new Set();
async function start() {
  child = spawn(process.execPath, [join(root, 'bin/codor.mjs'), '--data-dir', proof, 'up', '--host', '127.0.0.1',
    '--port', String(port), '--channel', 'proof', '--channel-name', 'Proof', '--owner', 'proof'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', b => { log = (log + b).slice(-8000); }); child.stderr.on('data', b => { log = (log + b).slice(-8000); });
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(log);
    try { const r = await fetch(base + '/api/client-compatibility', { headers: { authorization: `Bearer ${token}` } });
      if (r.ok && (await r.json()).post_correlations === true) return;
    } catch { /* isolated process is starting */ }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`startup timed out: ${log}`);
}
async function stop() {
  for (const ws of sockets) ws.terminate(); sockets.clear();
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
}
async function connect() {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws?token=' + token); sockets.add(ws);
  const frames = []; ws.on('message', raw => frames.push(JSON.parse(String(raw))));
  await once(ws, 'open');
  const wait = async predicate => {
    const until = Date.now() + 5000;
    while (Date.now() < until) { const found = frames.find(predicate); if (found) return found; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('frame timeout');
  };
  ws.send(JSON.stringify({ type: 'subscribe', room: 'proof', since_seq: 0, room_addressed: true, browser_protocol: 2 }));
  await wait(f => f.type === 'sync_complete');
  return { ws, frames, wait };
}
try {
  await start();
  const first = await connect();
  const request = { type: 'post', room: 'proof', body: 'installed identity', submission_id: 'installed-one' };
  first.ws.send(JSON.stringify(request));
  const canonical = await first.wait(f => f.type === 'message' && f.message.submission_id === 'installed-one');
  // Retain only the canonical correlation, discard any acknowledgement received.
  await stop(); await start();
  const recovered = await connect();
  const replay = recovered.frames.find(f => f.type === 'message' && f.message.submission_id === 'installed-one');
  assert.equal(replay.message.id, canonical.message.id);
  const history = await (await fetch(base + '/api/rooms/proof/transcript-history', { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(history.messages.find(m => m.submission_id === 'installed-one').id, canonical.message.id);
  recovered.ws.send(JSON.stringify(request));
  const ack = await recovered.wait(f => f.type === 'post_accepted' && f.submission_id === 'installed-one');
  assert.equal(ack.outcome.message_id, canonical.message.id);
  recovered.ws.send(JSON.stringify({ type: 'post', room: 'proof', body: 'legacy installed post' }));
  await recovered.wait(f => f.type === 'message' && f.message.body === 'legacy installed post');
  assert.equal(recovered.frames.filter(f => f.type === 'post_accepted').length, 1);
  console.log(JSON.stringify({ installed: root, restartReplay: true, independentHttp: true, sameIdRetry: true, legacy: true }));
} finally { await stop(); }
