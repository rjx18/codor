// Tracked room-capture pipeline: build the SPA, serve the fresh dist on an isolated
// port trio, screenshot the six design references, and prove each was written by this
// run. Replaces the untracked tmp/ script that served a stale gitignored dist.
// harn:assume web-room-visual-hierarchy-matches-soft-editorial-reference ref=soft-editorial-room-capture-proof
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(packageRoot, '..', '..');
const OUT = join(repoRoot, 'tmp', 'build', 'design', 'v5');
const runStart = Date.now();

// 1. BUILD FIRST — the guarantee that later steps serve current CSS, not a stale dist.
const build = spawnSync('pnpm', ['--filter', '@codor/web', 'build'], { cwd: repoRoot, stdio: 'inherit' });
if (build.status !== 0) { process.stdout.write('capture: build failed\n'); process.exit(1); }
if (!existsSync(join(packageRoot, 'dist', 'index.html'))) {
  process.stdout.write('capture: dist/index.html missing after build\n');
  process.exit(1);
}

// 2. PROBE A FREE PORT TRIO — same pattern as run-e2e.mjs, so a lingering harness on
// fixed ports can never make us serve someone else's build.
function isFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}
async function selectBasePort() {
  const raw = process.env.CODOR_E2E_PORT_BASE;
  if (raw !== undefined) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value + 3 > 65_535) {
      throw new Error('CODOR_E2E_PORT_BASE must leave room for the capture port trio');
    }
    return value;
  }
  for (let base = 18_137; base + 3 < 30_000; base += 3) {
    const free = await Promise.all([base, base + 1, base + 2].map((port) => isFree(port)));
    if (free.every(Boolean)) return base;
  }
  throw new Error('no free contiguous port trio for the capture harness');
}
const base = await selectBasePort();
const [API, CONTROL, RELAY] = [base, base + 1, base + 2];

// 3. SERVE the freshly built dist.
const harness = spawn('node', ['tests/harness.mjs'], {
  cwd: packageRoot,
  env: {
    ...process.env,
    CODOR_E2E_API_PORT: String(API),
    CODOR_E2E_CONTROL_PORT: String(CONTROL),
    CODOR_E2E_RELAY_PORT: String(RELAY),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
harness.stdout.on('data', (d) => process.stdout.write(`[harness] ${d}`));
harness.stderr.on('data', (d) => process.stdout.write(`[harness-err] ${d}`));

async function stopHarness() {
  if (harness.exitCode !== null || harness.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { harness.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }, 2_000);
    harness.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    try { harness.kill('SIGTERM'); } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function waitHealth() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CONTROL}/health`, { method: 'POST' });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('capture: harness health timeout');
}

const SHOTS = [[1440, 900], [1024, 820], [390, 844]];
const THEMES = ['light', 'dark'];

let browser;
try {
  await waitHealth();
  // 4. Seed a realistic timeline so the desktop 34px message avatar is on screen.
  await fetch(`http://127.0.0.1:${CONTROL}/seed-history`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });

  // 5. SCREENSHOT the six references at rest (reduced motion, so no mid-animation frame).
  browser = await chromium.launch();
  const written = [];
  for (const [w, h] of SHOTS) {
    for (const theme of THEMES) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.addInitScript((t) => localStorage.setItem('codor-theme', t), theme);
      await page.goto(`http://127.0.0.1:${API}/?room=eng&token=e2e-token`);
      await page.waitForSelector('[data-testid="timeline"]');
      await page.waitForTimeout(500);
      const name = `room-${w}-${theme}.png`;
      await page.screenshot({ path: join(OUT, name) });
      written.push({ name, w, h });
      process.stdout.write(`captured ${name}\n`);
      await ctx.close();
    }
  }
  // 6. PROVE each image was written by THIS run, is nonempty, and has the expected size.
  for (const { name, w, h } of written) {
    const p = join(OUT, name);
    const st = statSync(p);
    if (st.mtimeMs < runStart) throw new Error(`capture: ${name} was not rewritten by this run`);
    if (st.size === 0) throw new Error(`capture: ${name} is empty`);
    const buf = readFileSync(p);
    // PNG IHDR: width at byte 16, height at byte 20 (big-endian).
    const pngW = buf.readUInt32BE(16);
    const pngH = buf.readUInt32BE(20);
    if (pngW !== w || pngH !== h) {
      throw new Error(`capture: ${name} is ${pngW}x${pngH}, expected ${w}x${h}`);
    }
  }
  process.stdout.write(`capture: all ${String(written.length)} images fresh, nonempty, correctly sized\n`);
} catch (error) {
  process.stdout.write(`CAPTURE ERROR: ${String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopHarness();
}
// harn:end web-room-visual-hierarchy-matches-soft-editorial-reference
