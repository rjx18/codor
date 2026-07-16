// Build-first isolated Phase 5 capture pipeline. It serves only the freshly built dist,
// drives the three responsive inspector modes, and proves all six outputs came from this run.
// harn:assume graph-derived-from-vault-links-readonly-v5 ref=soft-editorial-ledger-capture-proof
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(packageRoot, '..', '..');
const outputRoot = join(repoRoot, 'tmp', 'build', 'design', 'v5');
const runStart = Date.now();

const build = spawnSync('pnpm', ['--filter', '@codor/web', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(1);
if (!existsSync(join(packageRoot, 'dist', 'index.html'))) {
  throw new Error('capture:ledger dist/index.html missing after build');
}

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
    if (!Number.isInteger(value) || value < 1 || value + 2 > 65_535) {
      throw new Error('CODOR_E2E_PORT_BASE must leave room for the capture port trio');
    }
    return value;
  }
  for (let base = 18_137; base + 2 < 30_000; base += 3) {
    const free = await Promise.all([base, base + 1, base + 2].map((port) => isFree(port)));
    if (free.every(Boolean)) return base;
  }
  throw new Error('no free contiguous port trio for Ledger capture');
}

const basePort = await selectBasePort();
const [apiPort, controlPort, relayPort] = [basePort, basePort + 1, basePort + 2];
const baseUrl = `http://127.0.0.1:${String(apiPort)}`;
const controlUrl = `http://127.0.0.1:${String(controlPort)}`;
const harness = spawn('node', ['tests/harness.mjs'], {
  cwd: packageRoot,
  env: {
    ...process.env,
    CODOR_E2E_API_PORT: String(apiPort),
    CODOR_E2E_CONTROL_PORT: String(controlPort),
    CODOR_E2E_RELAY_PORT: String(relayPort),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
harness.stdout.on('data', (chunk) => process.stdout.write(`[harness] ${String(chunk)}`));
harness.stderr.on('data', (chunk) => process.stdout.write(`[harness-err] ${String(chunk)}`));

async function stopHarness() {
  if (harness.exitCode !== null || harness.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { harness.kill('SIGKILL'); } catch { /* already stopped */ }
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

async function waitForHarness() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${controlUrl}/health`, { method: 'POST' });
      if (response.ok) return;
    } catch { /* harness is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('capture:ledger harness health timeout');
}

const sizes = [
  { width: 1440, height: 900, mode: 'docked' },
  { width: 1024, height: 820, mode: 'side' },
  { width: 390, height: 844, mode: 'sheet' },
];
let browser;

try {
  await waitForHarness();
  const seed = await fetch(`${controlUrl}/ledger-graph-init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!seed.ok) throw new Error(`Ledger seed failed: ${await seed.text()}`);

  browser = await chromium.launch();
  const written = [];
  for (const { width, height, mode } of sizes) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      await page.addInitScript((choice) => localStorage.setItem('codor-theme', choice), theme);
      await page.goto(`${baseUrl}/ledger?room=eng&token=e2e-token`);
      await page.waitForSelector('[data-testid="ledger-node-risk-limits"]');
      if (mode !== 'docked') await page.getByTestId('ledger-node-risk-limits').click();
      await page.waitForSelector('[data-testid="ledger-inspector"]');
      await page.waitForFunction(() => document.fonts.status === 'loaded');
      await page.waitForFunction(() => document.documentElement.dataset.theme !== undefined);
      await page.waitForTimeout(100);

      const name = `ledger-${String(width)}-${theme}.png`;
      await page.screenshot({ path: join(outputRoot, name) });
      written.push({ name, width, height });
      process.stdout.write(`captured ${name}\n`);
      await context.close();
    }
  }

  if (written.length !== 6) throw new Error(`capture wrote ${String(written.length)} images, expected 6`);
  for (const { name, width, height } of written) {
    const path = join(outputRoot, name);
    const stat = statSync(path);
    if (stat.mtimeMs < runStart) throw new Error(`${name} was not rewritten by this run`);
    if (stat.size === 0) throw new Error(`${name} is empty`);
    const png = readFileSync(path);
    const actualWidth = png.readUInt32BE(16);
    const actualHeight = png.readUInt32BE(20);
    if (actualWidth !== width || actualHeight !== height) {
      throw new Error(`${name} is ${String(actualWidth)}x${String(actualHeight)}, expected ${String(width)}x${String(height)}`);
    }
  }
  process.stdout.write('capture:ledger all 6 images fresh, nonempty, and correctly sized\n');
} catch (error) {
  process.stdout.write(`CAPTURE LEDGER ERROR: ${String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopHarness();
}
// harn:end graph-derived-from-vault-links-readonly-v5
